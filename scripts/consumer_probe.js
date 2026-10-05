'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

async function main() {
  const consumer = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  const requireFromConsumer = createRequire(path.join(consumer, 'probe.js'));
  const installedPath = requireFromConsumer.resolve('graphql-query-cost-gate');
  assert.ok(installedPath.startsWith(path.join(consumer, 'node_modules') + path.sep));
  const gate = requireFromConsumer('graphql-query-cost-gate');
  const metadata = requireFromConsumer('graphql-query-cost-gate/package.json');
  assert.equal(metadata.version, '0.1.2');
  assert.equal(metadata.author, 'dhtfish98');
  assert.equal(metadata.license, 'MIT');
  const lowQuery = 'query{tenant(id:"lab"){projects(first:2){tasks(first:2){label}}}}';
  const highQuery = 'query Q($n:Int!){tenant(id:"lab"){projects(first:$n){tasks(first:$n){label}}}}';
  const lowBaseline = await gate.executeRequest({ query: lowQuery, mode: 'baseline' });
  const lowFixed = await gate.executeRequest({ query: lowQuery, mode: 'fixed' });
  const highBaseline = await gate.executeRequest({ query: highQuery, variables: { n: 10 }, mode: 'baseline' });
  const highFixed = await gate.executeRequest({ query: highQuery, variables: { n: 10 }, mode: 'fixed' });
  assert.deepEqual(JSON.parse(JSON.stringify(lowBaseline.result)), JSON.parse(JSON.stringify(lowFixed.result)));
  assert.equal(lowBaseline.resolverCalls, lowFixed.resolverCalls);
  assert.ok(highBaseline.resolverCalls >= 100);
  assert.equal(highFixed.resolverCalls, 0);
  assert.equal(highFixed.result.errors[0].code, 'QUERY_COST_EXCEEDED');
  const amplificationQuery = 'query Q($id:ID!){tenant(id:$id){projects(first:9){tasks(first:9){label}}}}';
  const largeVariables = await gate.executeRequest({
    query: amplificationQuery, variables: { id: 'X'.repeat(28_000) }, mode: 'fixed',
  });
  assert.equal(largeVariables.result.errors[0].code, 'VARIABLE_SIZE_LIMIT');
  assert.equal(largeVariables.resolverCalls, 0);
  const boundedOutput = await gate.executeRequest({
    query: amplificationQuery, variables: { id: 'X'.repeat(gate.MAX_TENANT_ID_BYTES) }, mode: 'fixed',
  });
  assert.equal(boundedOutput.cost, 111);
  assert.equal(boundedOutput.resolverCalls, 92);
  assert.equal(boundedOutput.result.errors[0].code, 'OUTPUT_SIZE_LIMIT');
  assert.ok(Buffer.byteLength(JSON.stringify(boundedOutput), 'utf8') <= gate.MAX_OUTPUT_BYTES);
  const server = gate.createLabServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let httpLimit;
  try {
    const body = JSON.stringify({ query: amplificationQuery, variables: { id: 'X'.repeat(28_000) }, mode: 'fixed' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const text = await response.text();
    const outcome = JSON.parse(text);
    assert.equal(response.status, 400);
    assert.equal(outcome.result.errors[0].code, 'VARIABLE_SIZE_LIMIT');
    assert.equal(outcome.resolverCalls, 0);
    assert.ok(Buffer.byteLength(text, 'utf8') <= gate.MAX_OUTPUT_BYTES);
    httpLimit = { requestBytes: Buffer.byteLength(body), responseBytes: Buffer.byteLength(text), status: response.status, code: outcome.result.errors[0].code, resolverCalls: outcome.resolverCalls };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const result = {
    schema: 'graphql-query-cost-gate-independent-installed-consumer.v1',
    installedPath,
    dependencyVersion: JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules/graphql/package.json'))).version,
    low: { cost: lowFixed.cost, baselineCalls: lowBaseline.resolverCalls, fixedCalls: lowFixed.resolverCalls, dataEqual: true },
    high: { cost: highFixed.cost, baselineCalls: highBaseline.resolverCalls, fixedCalls: highFixed.resolverCalls, fixedRejectedBeforeResolver: true },
    inputLimit: { code: largeVariables.result.errors[0].code, resolverCalls: largeVariables.resolverCalls },
    outputLimit: { code: boundedOutput.result.errors[0].code, cost: boundedOutput.cost, resolverCalls: boundedOutput.resolverCalls, responseBytes: Buffer.byteLength(JSON.stringify(boundedOutput)) },
    httpLimit,
    pass: true,
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(cause => {
  process.stderr.write(cause.stack + '\n');
  process.exitCode = 1;
});
