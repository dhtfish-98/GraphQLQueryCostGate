'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..');
const docs = path.join(source, '项目文档');
const evidence = path.join(source, 'Build/验证/GraphQLQueryCostGate');
const label = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '') + '-' + crypto.randomBytes(4).toString('hex');
const runRoot = path.join(evidence, `run-${label}`);
const stage = path.join(runRoot, 'source');
const dist = path.join(runRoot, 'dist');
const consumer = path.join(runRoot, 'consumer');
const logs = path.join(runRoot, 'logs');
const docNames = ['README.md', 'LICENSE', 'ORIGIN.md', 'THIRD_PARTY_NOTICES.md', 'GRAPHQL_JS_LICENSE'];

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copy(sourceFile, destinationFile) {
  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  fs.copyFileSync(sourceFile, destinationFile);
}

function command(label, program, args, cwd, env) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const log = path.join(logs, `${label}.log`);
  fs.writeFileSync(log, `command: ${program} ${args.join(' ')}\nexit: ${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`);
  if (result.error || result.status !== 0) throw new Error(`${label} failed; see ${log}: ${result.error || result.status}`);
  return { log, stdout: result.stdout };
}

function main() {
  for (const p of [runRoot, stage, dist, consumer, logs]) fs.mkdirSync(p, { recursive: true });
  const inputHashes = {};
  for (const name of ['package.json', 'package-lock.json']) {
    copy(path.join(source, name), path.join(stage, name));
    inputHashes[name] = sha(path.join(stage, name));
  }
  for (const dir of ['src', 'tests', 'scripts']) {
    for (const name of fs.readdirSync(path.join(source, dir))) {
      if (!name.endsWith('.js')) continue;
      const rel = `${dir}/${name}`;
      copy(path.join(source, rel), path.join(stage, rel));
      inputHashes[rel] = sha(path.join(stage, rel));
    }
  }
  for (const name of docNames) {
    copy(path.join(docs, name), path.join(stage, name));
    inputHashes[`项目文档/${name}`] = sha(path.join(stage, name));
  }
  const env = { ...process.env, npm_config_cache: path.join(runRoot, 'npm-cache') };
  command('npm-ci', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], stage, env);
  command('tests', 'npm', ['test'], stage, env);
  const experiment = path.join(runRoot, 'experiment.json');
  command('experiment', 'node', ['tests/run_local_experiment.js', experiment], stage, env);
  const packed = command('npm-pack', 'npm', ['pack', '--json', '--pack-destination', dist], stage, env);
  const packData = JSON.parse(packed.stdout);
  if (packData.length !== 1) throw new Error('Expected one package archive');
  const tarball = path.join(dist, packData[0].filename);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'graphql-query-cost-gate-consumer', version: '0.0.0', private: true }) + '\n');
  command('consumer-install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer, env);
  const consumerReport = path.join(runRoot, 'consumer.json');
  command('consumer-probe', 'node', [path.join(stage, 'scripts/consumer_probe.js'), consumer, consumerReport], consumer, env);
  const listing = command('package-list', 'tar', ['-tzf', tarball], runRoot, env).stdout.trim().split('\n');
  for (const name of docNames) if (!listing.includes(`package/${name}`)) throw new Error(`Missing packed document ${name}`);
  for (const name of fs.readdirSync(path.join(source, 'src'))) {
    if (name.endsWith('.js') && !listing.includes(`package/src/${name}`)) throw new Error(`Missing packed source ${name}`);
  }
  const experimentData = JSON.parse(fs.readFileSync(experiment));
  const consumerData = JSON.parse(fs.readFileSync(consumerReport));
  if (!experimentData.allPass || !consumerData.pass) throw new Error('Behavioral evidence failed');
  const report = {
    schema: 'graphql-query-cost-gate-build.v1',
    capturedAtUtc: new Date().toISOString(),
    version: require(path.join(source, 'package.json')).version,
    author: 'dhtfish98',
    source,
    docs,
    runRoot,
    inputSha256: inputHashes,
    nodeVersion: process.version,
    graphqlVersion: require(path.join(stage, 'node_modules/graphql/package.json')).version,
    graphqlInstalledLicenseSha256: sha(path.join(stage, 'node_modules/graphql/LICENSE')),
    graphqlDocLicenseExact: sha(path.join(stage, 'node_modules/graphql/LICENSE')) === sha(path.join(stage, 'GRAPHQL_JS_LICENSE')),
    testsLogSha256: sha(path.join(logs, 'tests.log')),
    experiment: { path: experiment, sha256: sha(experiment), cases: experimentData.cases.length, regressionCases: experimentData.regressions.length, allPass: experimentData.allPass },
    tarball: { path: tarball, sha256: sha(tarball), bytes: fs.statSync(tarball).size, files: listing },
    installedConsumer: { path: consumerReport, sha256: sha(consumerReport), pass: consumerData.pass },
    status: 'PASS_ENGINEERING_SCOPE',
    open: ['This build run alone does not establish Release publication, real GraphQL deployment, or CVP qualification.'],
  };
  if (!report.graphqlDocLicenseExact) throw new Error('GraphQL-JS license does not match staged notice');
  const receipt = path.join(runRoot, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, receipt, receiptSha256: sha(receipt), tarball: report.tarball }) + '\n');
}

try { main(); } catch (cause) {
  process.stderr.write(cause.stack + '\n');
  process.exitCode = 1;
}
