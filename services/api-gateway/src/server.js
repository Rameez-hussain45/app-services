'use strict';
const os = require('node:os');
const { createService, makeLogger, json, callJson, proxy, run } = require('../../../shared/lib');

const NAME = 'api-gateway';

async function build(env = process.env) {
  const log = makeLogger(NAME);
  const upstream = {
    users: env.USERS_URL || 'http://localhost:3001',
    orders: env.ORDERS_URL || 'http://localhost:3002',
    payments: env.PAYMENTS_URL || 'http://localhost:3003',
  };

  const routes = [
    {
      method: 'GET',
      path: '/api/status',
      handler: async (ctx) => {
        const entries = await Promise.all(
          Object.entries(upstream).map(async ([name, base]) => {
            try {
              const res = await callJson(`${base}/healthz`, { reqId: ctx.reqId, timeoutMs: 2000 });
              return [name, res.status === 200 ? 'ok' : 'down'];
            } catch {
              return [name, 'down'];
            }
          })
        );
        return json(200, { gateway: 'ok', pod: os.hostname(), upstream: Object.fromEntries(entries) });
      },
    },
  ];

  // /api/users/* -> users-service, /api/orders/* -> orders-service, ...
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const [name, base] of Object.entries(upstream)) {
      routes.push({ method, prefix: `/api/${name}`, handler: (ctx) => proxy(ctx, base, '/api') });
    }
  }

  return createService({ name: NAME, log, routes });
}

module.exports = { build };
if (require.main === module) run(build, 3000);
