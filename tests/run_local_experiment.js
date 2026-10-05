'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { parse, version: graphqlVersion } = require('graphql');
const { createLabServer, DEFAULT_BUDGET, MAX_OUTPUT_BYTES, MAX_TENANT_ID_BYTES } = require('../src');

const aliasFields = Array.from({ length: 12 }, (_, index) =>
  `alias${index}:tenant(id:"lab"){projects(first:2){tasks(first:2){label}}}`);
const scenarios = [
  { name: 'within_budget', query: 'query Q($n:Int = 2){tenant(id:"lab"){id projects(first:$n){id tasks(first:2){label}}}}', variables: {} },
  { name: 'alias_expansion', query: `query { ${aliasFields.join(' ')} }`, variables: {} },
  { name: 'pagination_variable', query: 'query Q($n:Int!){tenant(id:"lab"){projects(first:$n){tasks(first:$n){label}}}}', variables: { n: 10 } },
  { name: 'nested_list_weights', query: 'query {tenant(id:"lab"){projects(first:5){tasks(first:5){children(first:5){label}}}}}', variables: {} },
];

async function post(url, request) {
  const started = performance.now();
  const body = JSON.stringify(request);
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  const text = await response.text();
  return { httpStatus: response.status, requestBytes: Buffer.byteLength(body), responseBytes: Buffer.byteLength(text), clientElapsedMs: Number((performance.now() - started).toFixed(3)), ...JSON.parse(text) };
}

async function main() {
  const server = createLabServer({ budget: DEFAULT_BUDGET, allowWeakBaseline: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/graphql`;
    const cases = [];
    for (const scenario of scenarios) {
      const baseline = await post(url, { ...scenario, mode: 'baseline' });
      const fixed = await post(url, { ...scenario, mode: 'fixed' });
      const within = scenario.name === 'within_budget';
      const pass = within
        ? baseline.accepted && fixed.accepted && JSON.stringify(baseline.result) === JSON.stringify(fixed.result)
        : baseline.accepted && baseline.resolverCalls > 0 && !fixed.accepted && fixed.resolverCalls === 0 && fixed.result.errors?.[0]?.code === 'QUERY_COST_EXCEEDED';
      cases.push({ ...scenario, ast: JSON.parse(JSON.stringify(parse(scenario.query))), budget: DEFAULT_BUDGET, baseline, fixed, pass });
    }
    const amplificationQuery = 'query Q($id:ID!){tenant(id:$id){projects(first:9){tasks(first:9){label}}}}';
    const largeInput = await post(url, { query: amplificationQuery, variables: { id: 'X'.repeat(28_000) }, mode: 'fixed' });
    const cappedOutput = await post(url, { query: amplificationQuery, variables: { id: 'X'.repeat(MAX_TENANT_ID_BYTES) }, mode: 'fixed' });
    const regressions = [
      {
        name: 'large_variable_rejected_before_resolvers',
        requestBytes: largeInput.requestBytes,
        responseBytes: largeInput.responseBytes,
        httpStatus: largeInput.httpStatus,
        code: largeInput.result.errors?.[0]?.code,
        resolverCalls: largeInput.resolverCalls,
        pass: largeInput.requestBytes === 28_123 && largeInput.httpStatus === 400 && largeInput.result.errors?.[0]?.code === 'VARIABLE_SIZE_LIMIT' && largeInput.resolverCalls === 0 && largeInput.responseBytes <= MAX_OUTPUT_BYTES,
      },
      {
        name: 'large_result_suppressed_at_output_boundary',
        requestBytes: cappedOutput.requestBytes,
        responseBytes: cappedOutput.responseBytes,
        httpStatus: cappedOutput.httpStatus,
        code: cappedOutput.result.errors?.[0]?.code,
        cost: cappedOutput.cost,
        resolverCalls: cappedOutput.resolverCalls,
        pass: cappedOutput.httpStatus === 400 && cappedOutput.result.errors?.[0]?.code === 'OUTPUT_SIZE_LIMIT' && cappedOutput.cost === 111 && cappedOutput.resolverCalls === 92 && cappedOutput.responseBytes <= MAX_OUTPUT_BYTES,
      },
    ];
    const report = {
      schema: 'graphql-query-cost-gate-local-lab.v1',
      capturedAtUtc: new Date().toISOString(),
      nodeVersion: process.version,
      graphqlVersion,
      author: 'dhtfish98',
      studyReference: 'https://github.com/slicknode/graphql-query-complexity/commit/31a4e10868585290ef81197170ab3c57aca773ad',
      host: '127.0.0.1',
      budget: DEFAULT_BUDGET,
      resourceMeasurement: 'peakProcessRssKiB is a process-wide high-water mark, not per-request allocation or a memory-safety proof.',
      allPass: cases.every(item => item.pass) && regressions.every(item => item.pass),
      cases,
      regressions,
    };
    const text = JSON.stringify(report, null, 2) + '\n';
    if (process.argv[2]) {
      const destination = path.resolve(process.argv[2]);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, text);
      process.stdout.write(JSON.stringify({ allPass: report.allPass, cases: cases.length, report: destination }) + '\n');
    } else {
      process.stdout.write(text);
    }
    if (!report.allPass) process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(cause => {
  process.stderr.write(cause.stack + '\n');
  process.exitCode = 1;
});
