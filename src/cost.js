'use strict';

const {
  getArgumentValues,
  getDirectiveValues,
  getNamedType,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
} = require('graphql');
const { MAX_PAGE } = require('./schema');

const MAX_EXPANDED_SELECTIONS = 4096;
const MAX_SELECTION_DEPTH = 12;
const MAX_TENANT_ID_BYTES = 256;
const SATURATED_COST = Number.MAX_SAFE_INTEGER;

// Every field in the synthetic schema has an explicit weight. New fields fail closed.
const FIELD_RULES = Object.freeze({
  'Query.tenant': { weight: 1, maxArgBytes: { id: MAX_TENANT_ID_BYTES } },
  'Query.health': { weight: 1 },
  'Tenant.id': { weight: 1 },
  'Tenant.projects': { weight: 2, pageArg: 'first' },
  'Project.id': { weight: 1 },
  'Project.tasks': { weight: 3, pageArg: 'first' },
  'Task.id': { weight: 1 },
  'Task.label': { weight: 1 },
  'Task.children': { weight: 3, pageArg: 'first' },
});

class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

function add(a, b) {
  return a > SATURATED_COST - b ? SATURATED_COST : a + b;
}

function multiply(a, b) {
  return a > Math.floor(SATURATED_COST / b) ? SATURATED_COST : a * b;
}

function included(node, variables) {
  for (const directive of node.directives || []) {
    if (!['skip', 'include'].includes(directive.name.value)) {
      throw new PolicyError('UNSUPPORTED_DIRECTIVE', 'This directive is outside the cost model');
    }
  }
  const skip = getDirectiveValues(GraphQLSkipDirective, node, variables);
  if (skip && skip.if === true) return false;
  const include = getDirectiveValues(GraphQLIncludeDirective, node, variables);
  return !include || include.if !== false;
}

function estimateCost(schema, document, operation, variables) {
  const fragments = new Map(document.definitions
    .filter(definition => definition.kind === Kind.FRAGMENT_DEFINITION)
    .map(definition => [definition.name.value, definition]));
  let selections = 0;

  function walk(selectionSet, parentType, depth, spreadPath) {
    if (depth > MAX_SELECTION_DEPTH) {
      throw new PolicyError('SELECTION_DEPTH_LIMIT', 'Selection nesting exceeds the lab policy');
    }
    let total = 0;
    for (const node of selectionSet.selections) {
      selections += 1;
      if (selections > MAX_EXPANDED_SELECTIONS) {
        throw new PolicyError('SELECTION_COUNT_LIMIT', 'Expanded selection count exceeds the lab policy');
      }
      if (!included(node, variables)) continue;

      if (node.kind === Kind.FRAGMENT_SPREAD) {
        const name = node.name.value;
        const fragment = fragments.get(name);
        if (!fragment || spreadPath.has(name)) {
          throw new PolicyError('INVALID_FRAGMENT', 'Fragment cannot be expanded safely');
        }
        if (fragment.variableDefinitions?.length || fragment.directives?.length) {
          throw new PolicyError('UNSUPPORTED_FRAGMENT', 'Fragment variables or directives are outside the cost model');
        }
        const condition = schema.getType(fragment.typeCondition.name.value);
        if (!condition || typeof condition.getFields !== 'function') {
          throw new PolicyError('UNSUPPORTED_TYPE', 'Fragment type is outside the synthetic schema');
        }
        total = add(total, walk(fragment.selectionSet, condition, depth + 1, new Set([...spreadPath, name])));
        continue;
      }
      if (node.kind === Kind.INLINE_FRAGMENT) {
        const condition = node.typeCondition
          ? schema.getType(node.typeCondition.name.value) : parentType;
        if (!condition || typeof condition.getFields !== 'function') {
          throw new PolicyError('UNSUPPORTED_TYPE', 'Inline fragment type is outside the synthetic schema');
        }
        total = add(total, walk(node.selectionSet, condition, depth + 1, spreadPath));
        continue;
      }
      if (node.kind !== Kind.FIELD || node.name.value.startsWith('__')) {
        throw new PolicyError('UNSUPPORTED_SELECTION', 'This selection is outside the cost model');
      }

      const fieldName = node.name.value;
      const field = parentType.getFields()[fieldName];
      const rule = FIELD_RULES[`${parentType.name}.${fieldName}`];
      if (!field || !rule) {
        throw new PolicyError('UNSUPPORTED_SCHEMA_FIELD', 'A field has no declared cost rule');
      }
      let multiplier = 1;
      if (rule.pageArg || rule.maxArgBytes) {
        const args = getArgumentValues(field, node, variables);
        for (const [argument, limit] of Object.entries(rule.maxArgBytes || {})) {
          if (Buffer.byteLength(String(args[argument]), 'utf8') > limit) {
            throw new PolicyError('ARGUMENT_SIZE_LIMIT', `${argument} exceeds ${limit} UTF-8 bytes`);
          }
        }
        if (rule.pageArg) {
          multiplier = args[rule.pageArg];
          if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > MAX_PAGE) {
            throw new PolicyError('PAGE_OUT_OF_RANGE', `first must be an integer from 1 to ${MAX_PAGE}`);
          }
        }
      }
      let childCost = 0;
      if (node.selectionSet) {
        const childType = getNamedType(field.type);
        if (!childType || typeof childType.getFields !== 'function') {
          throw new PolicyError('UNSUPPORTED_TYPE', 'Selection type is outside the cost model');
        }
        childCost = walk(node.selectionSet, childType, depth + 1, spreadPath);
      }
      total = add(total, add(rule.weight, multiply(multiplier, childCost)));
    }
    return total;
  }

  const queryType = schema.getQueryType();
  if (operation.operation !== 'query' || !queryType) {
    throw new PolicyError('UNSUPPORTED_OPERATION', 'Only synthetic query operations are supported');
  }
  return { cost: walk(operation.selectionSet, queryType, 0, new Set()), expandedSelections: selections };
}

module.exports = { estimateCost, PolicyError, FIELD_RULES, MAX_EXPANDED_SELECTIONS, MAX_SELECTION_DEPTH, MAX_TENANT_ID_BYTES };
