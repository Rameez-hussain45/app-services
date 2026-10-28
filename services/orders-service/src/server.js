'use strict';
const { createService, makeLogger, json, httpError, callJson, retry, run } = require('../../../shared/lib');

const NAME = 'orders-service';

// ----- storage: in memory by default, PostgreSQL when DATABASE_URL is set
function memoryStore() {
  const orders = [];
  let next = 1;
  return {
    kind: 'memory',
    async create({ userId, items, total, status }) {
      const order = { id: next++, userId, total, status, items, createdAt: new Date().toISOString() };
      orders.unshift(order);
      return order;
    },
    async setStatus(id, status) {
      const order = orders.find((o) => o.id === id);
      if (order) order.status = status;
      return order || null;
    },
    async list() {
      return orders.slice(0, 50);
    },
    async get(id) {
      return orders.find((o) => o.id === id) || null;
    },
    async close() {},
  };
}

const fromRow = (r) => ({
  id: r.id,
  userId: r.user_id,
  total: Number(r.total),
  status: r.status,
  items: r.items,
  createdAt: r.created_at,
});

async function postgresStore(url, log) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5 });
  await retry(
    () =>
      pool.query(`CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        total NUMERIC(12,2) NOT NULL,
        status TEXT NOT NULL,
        items JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now())`),
    { log, what: 'postgres connection' }
  );
  return {
    kind: 'postgres',
    async create({ userId, items, total, status }) {
      const res = await pool.query(
        'INSERT INTO orders (user_id, total, status, items) VALUES ($1, $2, $3, $4) RETURNING *',
        [userId, total, status, JSON.stringify(items)]
      );
      return fromRow(res.rows[0]);
    },
    async setStatus(id, status) {
      const res = await pool.query('UPDATE orders SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
      return res.rows[0] ? fromRow(res.rows[0]) : null;
    },
    async list() {
      return (await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 50')).rows.map(fromRow);
    },
    async get(id) {
      const res = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
      return res.rows[0] ? fromRow(res.rows[0]) : null;
    },
    close: () => pool.end(),
  };
}

function validateOrder(body) {
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId < 1) throw httpError(400, 'userId must be a positive integer');
  if (!Array.isArray(body.items) || body.items.length === 0) throw httpError(400, 'items must be a non-empty array');
  const items = body.items.map((it) => {
    const qty = Number(it.qty);
    const price = Number(it.price);
    if (typeof it.sku !== 'string' || !it.sku.trim()) throw httpError(400, 'each item needs a sku');
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'each item needs a whole qty >= 1');
    if (!Number.isFinite(price) || price < 0) throw httpError(400, 'each item needs a price >= 0');
    return { sku: it.sku.trim(), qty, price };
  });
  const total = Math.round(items.reduce((sum, it) => sum + it.qty * it.price, 0) * 100) / 100;
  return { userId, items, total };
}

async function build(env = process.env) {
  const log = makeLogger(NAME);
  const usersUrl = env.USERS_URL || 'http://localhost:3001';
  const paymentsUrl = env.PAYMENTS_URL || 'http://localhost:3003';
  const store = env.DATABASE_URL ? await postgresStore(env.DATABASE_URL, log) : memoryStore();
  log('info', 'storage ready', { store: store.kind });

  const routes = [
    { method: 'GET', path: '/orders', handler: async () => json(200, await store.list()) },
    {
      method: 'GET',
      path: '/orders/:id',
      handler: async (ctx) => {
        const id = Number(ctx.params.id);
        if (!Number.isInteger(id) || id < 1) throw httpError(400, 'id must be a positive integer');
        const order = await store.get(id);
        if (!order) throw httpError(404, 'order not found');
        return json(200, order);
      },
    },
    {
      method: 'POST',
      path: '/orders',
      handler: async (ctx) => {
        const { userId, items, total } = validateOrder(ctx.json());

        // level 2: ask the users service whether this customer exists
        const user = await callJson(`${usersUrl}/users/${userId}`, { reqId: ctx.reqId });
        if (user.status === 404) throw httpError(404, `user ${userId} does not exist`);
        if (user.status >= 500) throw httpError(502, 'users service failed');

        const order = await store.create({ userId, items, total, status: 'pending' });

        // level 2: ask the payments service to charge for it
        let payment;
        try {
          payment = await callJson(`${paymentsUrl}/payments`, {
            method: 'POST',
            reqId: ctx.reqId,
            body: { orderId: order.id, userId, amount: total },
          });
        } catch (err) {
          await store.setStatus(order.id, 'payment_error');
          ctx.metrics.inc('orders_created_total', { status: 'payment_error' }, 1, 'Orders created by final status.');
          throw httpError(502, `payments service unavailable, order ${order.id} saved as payment_error`);
        }

        const status = payment.status === 201 && payment.data?.status === 'approved' ? 'paid' : 'payment_failed';
        const final = await store.setStatus(order.id, status);
        ctx.metrics.inc('orders_created_total', { status }, 1, 'Orders created by final status.');
        ctx.log('info', 'order processed', { reqId: ctx.reqId, orderId: order.id, userId, total, status });
        return json(201, { ...final, user: user.data, payment: payment.data });
      },
    },
  ];

  return createService({ name: NAME, log, routes, onClose: () => store.close() });
}

module.exports = { build };
if (require.main === module) run(build, 3002);
