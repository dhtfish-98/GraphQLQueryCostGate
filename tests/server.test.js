'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLabServer, MAX_OUTPUT_BYTES, MAX_TENANT_ID_BYTES } = require('../src');

const heavy = `query { ${Array.from({ length: 12 }, (_, i) => `a${i}:tenant(id:"lab"){projects(first:2){tasks(first:2){label}}}`).join(' ')} }`;

async function withServer(options, callback) {
  const server = createLabServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}/graphql`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('local HTTP service executes weak baseline and rejects same expensive input pre-resolver', async () => {
  await withServer({ allowWeakBaseline: true }, async url => {
    const baseline = await post(url, { query: heavy, mode: 'baseline' });
    const fixed = await post(url, { query: heavy, mode: 'fixed' });
    assert.equal(baseline.status, 200);
    assert.ok(baseline.body.resolverCalls >= 90);
    assert.equal(fixed.status, 400);
    assert.equal(fixed.body.resolverCalls, 0);
    assert.equal(fixed.body.result.errors[0].code, 'QUERY_COST_EXCEEDED');
  });
});

test('baseline HTTP mode is disabled unless the local lab opts in', async () => {
  await withServer({}, async url => {
    const baseline = await post(url, { query: '{health}', mode: 'baseline' });
    const fixed = await post(url, { query: '{health}', mode: 'fixed' });
    assert.equal(baseline.status, 403);
    assert.equal(baseline.body.error, 'BASELINE_DISABLED');
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.result.data.health, 'synthetic-ok');
  });
});

test('28 KB variable input cannot amplify to a multi-megabyte fixed response', async () => {
  await withServer({}, async url => {
    const query = 'query Q($id:ID!){tenant(id:$id){projects(first:9){tasks(first:9){label}}}}';
    const body = JSON.stringify({ query, variables: { id: 'X'.repeat(28_000) }, mode: 'fixed' });
    assert.equal(Buffer.byteLength(body, 'utf8'), 28_123);
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const text = await response.text();
    const outcome = JSON.parse(text);
    assert.equal(response.status, 400);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.resolverCalls, 0);
    assert.equal(outcome.result.errors[0].code, 'VARIABLE_SIZE_LIMIT');
    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES);
  });
});

test('HTTP response suppresses valid-budget output beyond byte limit', async () => {
  await withServer({}, async url => {
    const query = 'query Q($id:ID!){tenant(id:$id){projects(first:9){tasks(first:9){label}}}}';
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: 'X'.repeat(MAX_TENANT_ID_BYTES) }, mode: 'fixed' }),
    });
    const text = await response.text();
    const outcome = JSON.parse(text);
    assert.equal(response.status, 400);
    assert.equal(outcome.cost, 111);
    assert.equal(outcome.resolverCalls, 92);
    assert.equal(outcome.result.errors[0].code, 'OUTPUT_SIZE_LIMIT');
    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES);
  });
});
