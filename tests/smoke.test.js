'use strict';
// Starts all five services in-process (in-memory storage, no Docker needed)
// and walks through the same path a browser would: frontend -> gateway -> services.
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listen } = require('../shared/lib');

const payments = require('../services/payments-service/src/server');
const users = require('../services/users-service/src/server');
const orders = require('../services/orders-service/src/server');
const gateway = require('../services/api-gateway/src/server');
const frontend = require('../services/frontend/src/server');

const running = [];
async function start(mod, env = {}) {
  const svc = await mod.build(env);
  const port = await listen(svc.server, 0, '127.0.0.1');
  running.push(svc);
  return `http://127.0.0.1:${port}`;
}

let base;

test.before(async () => {
  const paymentsUrl = await start(payments);
  const usersUrl = await start(users);
  const ordersUrl = await start(orders, { USERS_URL: usersUrl, PAYMENTS_URL: paymentsUrl });
  const gatewayUrl = await start(gateway, { USERS_URL: usersUrl, ORDERS_URL: ordersUrl, PAYMENTS_URL: paymentsUrl });
  base = await start(frontend, { API_GATEWAY_URL: gatewayUrl });
});

test.after(async () => {
  for (const svc of running) await svc.close();
});

const call = async (path, opts) => {
  const res = await fetch(base + path, opts && opts.body ? { ...opts, headers: { 'content-type': 'application/json' } } : opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};

test('frontend serves the page and health endpoint', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.data, /Microservices lab/);
  assert.equal((await call('/healthz')).data.status, 'ok');
});

test('gateway reports every upstream as ok', async () => {
  const { status, data } = await call('/api/status');
  assert.equal(status, 200);
  assert.deepEqual(data.upstream, { users: 'ok', orders: 'ok', payments: 'ok' });
});

test('users can be listed and created', async () => {
  const list = await call('/api/users');
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 3);
  const created = await call('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Dana', email: 'dana@example.com' }) });
  assert.equal(created.status, 201);
  const dup = await call('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Dana', email: 'dana@example.com' }) });
  assert.equal(dup.status, 409);
});

test('an order goes through users and payments and ends up paid', async () => {
  const res = await call('/api/orders', { method: 'POST', body: JSON.stringify({ userId: 1, items: [{ sku: 'widget', qty: 2, price: 19.99 }] }) });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'paid');
  assert.equal(res.data.total, 39.98);
  assert.equal(res.data.user.name, 'Alice Johnson');
  assert.equal(res.data.payment.status, 'approved');
});

test('a very large order is declined by payments', async () => {
  const res = await call('/api/orders', { method: 'POST', body: JSON.stringify({ userId: 2, items: [{ sku: 'yacht', qty: 1, price: 6000 }] }) });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'payment_failed');
});

test('bad input is rejected with clear errors', async () => {
  assert.equal((await call('/api/orders', { method: 'POST', body: JSON.stringify({ userId: 999, items: [{ sku: 'x', qty: 1, price: 1 }] }) })).status, 404);
  assert.equal((await call('/api/orders', { method: 'POST', body: JSON.stringify({ userId: 1, items: [] }) })).status, 400);
  assert.equal((await call('/api/orders', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await call('/api/nothing')).status, 404);
});

test('orders are listed newest first', async () => {
  const { data } = await call('/api/orders');
  assert.ok(data.length >= 2);
  assert.ok(data[0].id > data[1].id);
});

test('every service exposes prometheus metrics', async () => {
  const gw = await call('/metrics');
  assert.equal(gw.status, 200);
  assert.match(gw.data, /http_requests_total\{method="GET",route="\/",status="200"\}/);
  assert.match(gw.data, /http_request_duration_seconds_bucket/);
});
