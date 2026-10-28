'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService, makeLogger, json, proxy, run } = require('../../../shared/lib');

const NAME = 'frontend';

async function build(env = process.env) {
  const log = makeLogger(NAME);
  const gatewayUrl = env.API_GATEWAY_URL || 'http://localhost:3000';
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

  const routes = [
    {
      method: 'GET',
      path: '/',
      handler: () => ({ status: 200, body: indexHtml, contentType: 'text/html; charset=utf-8' }),
    },
    { method: 'GET', path: '/info', handler: () => json(200, { service: NAME, pod: os.hostname(), image: env.IMAGE_TAG || 'unknown' }) },
    { method: 'GET', path: '/favicon.ico', handler: () => json(204) },
  ];

  // everything under /api goes to the gateway (the browser only ever talks to the frontend)
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    routes.push({ method, prefix: '/api', handler: (ctx) => proxy(ctx, gatewayUrl, '') });
  }

  return createService({ name: NAME, log, routes });
}

module.exports = { build };
if (require.main === module) run(build, 8080);
