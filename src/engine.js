'use strict';

const { performance } = require('node:perf_hooks');
const {
  execute,
  getOperationAST,
  getVariableValues,
  parse,
  validate,
} = require('graphql');
const { schema } = require('./schema');
const { estimateCost, PolicyError } = require('./cost');

const DEFAULT_BUDGET = 120;
const MAX_QUERY_BYTES = 16 * 1024;
const MAX_VARIABLE_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_PARSE_TOKENS = 2048;

function error(code, message) {
  return { message, code };
}

function errorsFromGraphQL(errors, fallback) {
  return errors.map(item => error(item.extensions?.code || fallback, item.message));
}

function variableByteLength(value) {
  const seen = new WeakSet();
  let bytes = 0;
  function add(amount) {
    bytes += amount;
    if (bytes > MAX_VARIABLE_BYTES) throw new PolicyError('VARIABLE_SIZE_LIMIT', 'Variables exceed the JSON byte limit');
  }
  function visit(item, depth) {
    if (depth > 16) throw new PolicyError('INVALID_VARIABLES', 'Variables are nested too deeply');
    if (item === null) return add(4);
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > MAX_VARIABLE_BYTES) {
        throw new PolicyError('VARIABLE_SIZE_LIMIT', 'Variables exceed the JSON byte limit');
      }
      return add(Buffer.byteLength(JSON.stringify(item), 'utf8'));
    }
    if (typeof item === 'number' && Number.isFinite(item)) return add(Buffer.byteLength(JSON.stringify(item), 'utf8'));
    if (typeof item === 'boolean') return add(item ? 4 : 5);
    if (!item || typeof item !== 'object') throw new PolicyError('INVALID_VARIABLES', 'Variables must contain JSON values');
    if (seen.has(item)) throw new PolicyError('INVALID_VARIABLES', 'Variables must not contain cycles');
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_VARIABLE_BYTES) throw new PolicyError('VARIABLE_SIZE_LIMIT', 'Variables exceed the JSON byte limit');
      add(2);
      for (let index = 0; index < item.length; index += 1) {
        if (index) add(1);
        visit(item[index], depth + 1);
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) {
        throw new PolicyError('INVALID_VARIABLES', 'Variables must be plain JSON objects');
      }
      add(2);
      const names = Object.getOwnPropertyNames(item);
      if (names.length > MAX_VARIABLE_BYTES) throw new PolicyError('VARIABLE_SIZE_LIMIT', 'Variables exceed the JSON byte limit');
      for (const [index, name] of names.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new PolicyError('INVALID_VARIABLES', 'Variables must be plain JSON values');
        }
        if (index) add(1);
        add(Buffer.byteLength(JSON.stringify(name), 'utf8') + 1);
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
  return bytes;
}

async function executeRequest({ query, variables = {}, operationName, mode = 'fixed', budget = DEFAULT_BUDGET, traceAst = false }) {
  const started = performance.now();
  const context = { resolverCalls: 0, byField: Object.create(null) };
  let cost = null;
  let expandedSelections = null;
  let ast = null;

  function finish(accepted, result, costError = null) {
    const outcome = {
      mode,
      accepted,
      cost,
      budget,
      expandedSelections,
      costError,
      result,
      resolverCalls: context.resolverCalls,
      resolverByField: context.byField,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      peakProcessRssKiB: process.resourceUsage().maxRSS,
      ...(traceAst ? { ast } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(outcome), 'utf8') <= MAX_OUTPUT_BYTES) return outcome;
    return {
      mode,
      accepted: false,
      cost,
      budget,
      expandedSelections,
      costError: 'OUTPUT_SIZE_LIMIT',
      result: { data: null, errors: [error('OUTPUT_SIZE_LIMIT', 'Output exceeds the response byte limit')] },
      resolverCalls: context.resolverCalls,
      resolverByField: context.byField,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      peakProcessRssKiB: process.resourceUsage().maxRSS,
    };
  }

  if (!['baseline', 'fixed'].includes(mode) || !Number.isInteger(budget) || budget < 1 || budget > 1_000_000) {
    return finish(false, { data: null, errors: [error('INVALID_POLICY', 'Mode or budget is invalid')] });
  }
  if (typeof query !== 'string' || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    return finish(false, { data: null, errors: [error('QUERY_SIZE_LIMIT', 'Query text is missing or too large')] });
  }
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return finish(false, { data: null, errors: [error('INVALID_VARIABLES', 'Variables must be a JSON object')] });
  }
  try {
    variableByteLength(variables);
  } catch (cause) {
    const code = cause instanceof PolicyError ? cause.code : 'INVALID_VARIABLES';
    return finish(false, { data: null, errors: [error(code, 'Variables are not a bounded JSON object')] }, code);
  }

  let document;
  try {
    document = parse(query, { maxTokens: MAX_PARSE_TOKENS });
    if (traceAst) ast = JSON.parse(JSON.stringify(document));
  } catch (cause) {
    return finish(false, { data: null, errors: [error('GRAPHQL_PARSE', cause.message)] });
  }
  const validationErrors = validate(schema, document);
  if (validationErrors.length) {
    return finish(false, { data: null, errors: errorsFromGraphQL(validationErrors, 'GRAPHQL_VALIDATION') });
  }
  const operation = getOperationAST(document, operationName || undefined);
  if (!operation) {
    return finish(false, { data: null, errors: [error('OPERATION_SELECTION', 'Select one named query operation')] });
  }
  const coercedResult = getVariableValues(schema, operation.variableDefinitions || [], variables, { maxErrors: 10 });
  if (coercedResult.errors) {
    return finish(false, { data: null, errors: errorsFromGraphQL(coercedResult.errors, 'INVALID_VARIABLES') });
  }
  const variableValues = coercedResult.variableValues;
  try {
    const estimate = estimateCost(schema, document, operation, variableValues);
    cost = estimate.cost;
    expandedSelections = estimate.expandedSelections;
  } catch (cause) {
    if (mode === 'fixed') {
      if (cause instanceof PolicyError) {
        return finish(false, { data: null, errors: [error(cause.code, cause.message)] }, cause.code);
      }
      return finish(false, { data: null, errors: [error('COST_ESTIMATE_FAILED', 'Cost could not be estimated safely')] }, 'COST_ESTIMATE_FAILED');
    }
    // The intentionally weak lab baseline records the estimation failure and executes anyway.
    cost = null;
    expandedSelections = null;
  }
  if (mode === 'fixed' && cost > budget) {
    return finish(false, { data: null, errors: [error('QUERY_COST_EXCEEDED', `Estimated cost ${cost} exceeds budget ${budget}`)] });
  }

  const execution = await execute({ schema, document, operationName: operationName || undefined, variableValues: variableValues.coerced, contextValue: context });
  const result = { data: execution.data ?? null };
  if (execution.errors) result.errors = errorsFromGraphQL(execution.errors, 'GRAPHQL_EXECUTION');
  return finish(true, result);
}

module.exports = { executeRequest, DEFAULT_BUDGET, MAX_QUERY_BYTES, MAX_VARIABLE_BYTES, MAX_OUTPUT_BYTES, MAX_PARSE_TOKENS };
