'use strict';

const http = require('node:http');
const { executeRequest, DEFAULT_BUDGET, MAX_OUTPUT_BYTES } = require('./engine');

const MAX_BODY_BYTES = 32 * 1024;

function reply(response, status, body) {
  let payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, 'utf8') > MAX_OUTPUT_BYTES) {
    status = 500;
    payload = JSON.stringify({ error: 'RESPONSE_SIZE_LIMIT' });
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function createLabServer({ budget = DEFAULT_BUDGET, allowWeakBaseline = false } = {}) {
  return http.createServer(async (request, response) => {
    if (!['127.0.0.1', '::1'].includes(request.socket.localAddress)) {
      reply(response, 403, { error: 'LOOPBACK_ONLY' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/graphql') {
      reply(response, 404, { error: 'NOT_FOUND' });
      return;
    }
    let body;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          reply(response, 413, { error: 'BODY_SIZE_LIMIT' });
          return;
        }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Body must be an object');
    } catch {
      reply(response, 400, { error: 'INVALID_JSON' });
      return;
    }
    const mode = body.mode || 'fixed';
    if (mode === 'baseline' && !allowWeakBaseline) {
      reply(response, 403, { error: 'BASELINE_DISABLED' });
      return;
    }
    try {
      const outcome = await executeRequest({
        query: body.query,
        variables: body.variables,
        operationName: body.operationName,
        mode,
        budget,
      });
      reply(response, outcome.accepted ? 200 : 400, outcome);
    } catch {
      reply(response, 500, { error: 'INTERNAL_ERROR' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('PORT must be an integer from 0 to 65535\n');
    process.exitCode = 2;
  } else {
    const server = createLabServer({ allowWeakBaseline: process.env.LAB_WEAK_BASELINE === '1' });
    server.listen(port, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ host: '127.0.0.1', port: server.address().port }) + '\n');
    });
  }
}

module.exports = { createLabServer, MAX_BODY_BYTES };
