'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRequest, DEFAULT_BUDGET, MAX_OUTPUT_BYTES, MAX_TENANT_ID_BYTES, MAX_VARIABLE_BYTES } = require('../src');

const small = 'query Q($n:Int = 2) { tenant(id:"lab") { id projects(first:$n) { id tasks(first:2) { label } } } }';
const variablePage = 'query Q($n:Int!) { tenant(id:"lab") { projects(first:$n) { tasks(first:$n) { label } } } }';
const nested = 'query { tenant(id:"lab") { projects(first:5) { tasks(first:5) { children(first:5) { label } } } } }';
const aliases = `query { ${Array.from({ length: 12 }, (_, i) => `a${i}:tenant(id:"lab"){projects(first:2){tasks(first:2){label}}}`).join(' ')} }`;

test('budgeted small query preserves baseline data and resolver behavior', async () => {
  const baseline = await executeRequest({ query: small, mode: 'baseline' });
  const fixed = await executeRequest({ query: small, mode: 'fixed' });
  assert.equal(fixed.cost, 16);
  assert.ok(fixed.cost < DEFAULT_BUDGET);
  assert.equal(fixed.accepted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fixed.result)), JSON.parse(JSON.stringify(baseline.result)));
  assert.equal(fixed.resolverCalls, baseline.resolverCalls);
  assert.equal(fixed.resolverCalls, 11);
});

test('aliases consume budget before any resolver is called', async () => {
  const baseline = await executeRequest({ query: aliases, mode: 'baseline' });
  const fixed = await executeRequest({ query: aliases, mode: 'fixed' });
  assert.equal(baseline.accepted, true);
  assert.ok(baseline.resolverCalls >= 90);
  assert.equal(fixed.cost, 156);
  assert.equal(fixed.accepted, false);
  assert.equal(fixed.result.errors[0].code, 'QUERY_COST_EXCEEDED');
  assert.equal(fixed.resolverCalls, 0);
});

test('coerced pagination variables change cost and preserve a request inside budget', async () => {
  const withinBaseline = await executeRequest({ query: variablePage, variables: { n: 8 }, mode: 'baseline' });
  const withinFixed = await executeRequest({ query: variablePage, variables: { n: 8 }, mode: 'fixed' });
  assert.equal(withinFixed.cost, 91);
  assert.deepEqual(JSON.parse(JSON.stringify(withinFixed.result)), JSON.parse(JSON.stringify(withinBaseline.result)));
  assert.equal(withinFixed.resolverCalls, withinBaseline.resolverCalls);
  const highBaseline = await executeRequest({ query: variablePage, variables: { n: 10 }, mode: 'baseline' });
  const highFixed = await executeRequest({ query: variablePage, variables: { n: 10 }, mode: 'fixed' });
  assert.equal(highFixed.cost, 133);
  assert.ok(highBaseline.resolverCalls >= 100);
  assert.equal(highFixed.resolverCalls, 0);
  assert.equal(highFixed.result.errors[0].code, 'QUERY_COST_EXCEEDED');
});

test('nested list weights multiply and reject before resolver execution', async () => {
  const baseline = await executeRequest({ query: nested, mode: 'baseline' });
  const fixed = await executeRequest({ query: nested, mode: 'fixed' });
  assert.equal(fixed.cost, 218);
  assert.ok(baseline.resolverCalls >= 150);
  assert.equal(fixed.resolverCalls, 0);
  assert.equal(fixed.result.errors[0].code, 'QUERY_COST_EXCEEDED');
});

test('invalid pagination and variable values fail closed before resolvers', async () => {
  const page = await executeRequest({ query: variablePage, variables: { n: 11 }, mode: 'fixed' });
  assert.equal(page.result.errors[0].code, 'PAGE_OUT_OF_RANGE');
  assert.equal(page.resolverCalls, 0);
  const badVariable = await executeRequest({ query: variablePage, variables: { n: 'ten' }, mode: 'fixed' });
  assert.equal(badVariable.result.errors[0].code, 'INVALID_VARIABLES');
  assert.equal(badVariable.resolverCalls, 0);
  const missing = await executeRequest({ query: variablePage, variables: {}, mode: 'fixed' });
  assert.equal(missing.result.errors[0].code, 'INVALID_VARIABLES');
  assert.equal(missing.resolverCalls, 0);
});

test('fragments and skip directives follow selected operation without hidden resolver work', async () => {
  const query = 'query Q($skip:Boolean!){health ...F @skip(if:$skip)} fragment F on Query { tenant(id:"lab"){projects(first:2){id}} }';
  const skipped = await executeRequest({ query, variables: { skip: true }, mode: 'fixed' });
  const included = await executeRequest({ query, variables: { skip: false }, mode: 'fixed' });
  assert.equal(skipped.cost, 1);
  assert.equal(skipped.resolverCalls, 1);
  assert.equal(skipped.result.data.tenant, undefined);
  assert.ok(included.cost > skipped.cost);
  assert.equal(included.accepted, true);
  assert.equal(included.result.data.tenant.projects.length, 2);
});

test('operation selection excludes an unused expensive operation', async () => {
  const query = `query Cheap{health} ${aliases.replace(/^query\s*\{/, 'query Heavy{')}`;
  const selected = await executeRequest({ query, operationName: 'Cheap', mode: 'fixed' });
  const missing = await executeRequest({ query, mode: 'fixed' });
  assert.equal(selected.cost, 1);
  assert.equal(selected.resolverCalls, 1);
  assert.equal(missing.accepted, false);
  assert.equal(missing.resolverCalls, 0);
});

test('unsupported introspection and oversized text fail before resolvers', async () => {
  const introspection = await executeRequest({ query: '{ __schema { queryType { name } } }', mode: 'fixed' });
  assert.equal(introspection.result.errors[0].code, 'UNSUPPORTED_SELECTION');
  assert.equal(introspection.resolverCalls, 0);
  const oversized = await executeRequest({ query: ' '.repeat(20_000), mode: 'fixed' });
  assert.equal(oversized.result.errors[0].code, 'QUERY_SIZE_LIMIT');
  assert.equal(oversized.resolverCalls, 0);
});

test('selection depth policy fails closed before execution', async () => {
  const manyChildren = 'children(first:1){'.repeat(13) + 'label' + '}'.repeat(13);
  const query = `query{tenant(id:"lab"){projects(first:1){tasks(first:1){${manyChildren}}}}}`;
  const baseline = await executeRequest({ query, mode: 'baseline' });
  const fixed = await executeRequest({ query, mode: 'fixed' });
  assert.equal(baseline.accepted, true);
  assert.ok(baseline.resolverCalls > 13);
  assert.equal(fixed.accepted, false);
  assert.equal(fixed.resolverCalls, 0);
  assert.equal(fixed.result.errors[0].code, 'SELECTION_DEPTH_LIMIT');
});

test('large variable JSON and long tenant IDs are rejected before any resolver', async () => {
  const query = 'query Q($id:ID!){tenant(id:$id){projects(first:9){tasks(first:9){label}}}}';
  const oversized = await executeRequest({ query, variables: { id: 'X'.repeat(28_000) }, mode: 'fixed' });
  assert.equal(oversized.accepted, false);
  assert.equal(oversized.result.errors[0].code, 'VARIABLE_SIZE_LIMIT');
  assert.equal(oversized.resolverCalls, 0);
  assert.equal(oversized.cost, null);
  assert.ok(28_000 > MAX_VARIABLE_BYTES);

  const longId = await executeRequest({ query, variables: { id: 'X'.repeat(MAX_TENANT_ID_BYTES + 1) }, mode: 'fixed' });
  assert.equal(longId.result.errors[0].code, 'ARGUMENT_SIZE_LIMIT');
  assert.equal(longId.resolverCalls, 0);
  const inlineId = await executeRequest({
    query: `{tenant(id:"${'X'.repeat(MAX_TENANT_ID_BYTES + 1)}"){id}}`, mode: 'fixed',
  });
  assert.equal(inlineId.result.errors[0].code, 'ARGUMENT_SIZE_LIMIT');
  assert.equal(inlineId.resolverCalls, 0);
});

test('direct API suppresses oversized output after execution', async () => {
  const query = 'query Q($id:ID!){tenant(id:$id){projects(first:9){tasks(first:9){label}}}}';
  const outcome = await executeRequest({ query, variables: { id: 'X'.repeat(MAX_TENANT_ID_BYTES) }, mode: 'fixed' });
  assert.equal(outcome.cost, 111);
  assert.equal(outcome.resolverCalls, 92);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.result.errors[0].code, 'OUTPUT_SIZE_LIMIT');
  assert.equal(outcome.result.data, null);
  assert.ok(Buffer.byteLength(JSON.stringify(outcome), 'utf8') <= MAX_OUTPUT_BYTES);
});
