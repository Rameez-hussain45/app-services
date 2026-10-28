'use strict';
const crypto = require('node:crypto');
const { createService, makeLogger, json, httpError, run } = require('../../../shared/lib');

const NAME = 'payments-service';
const LIMIT = 5000; // demo rule: payments above this amount are declined

async function build() {
  const log = makeLogger(NAME);
  const recent = [];

  const routes = [
    {
      method: 'POST',
      path: '/payments',
      handler: (ctx) => {
        const body = ctx.json();
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'amount must be a positive number');
        if (!body.orderId) throw httpError(400, 'orderId is required');

        const approved = amount <= LIMIT;
        const payment = {
          id: crypto.randomUUID(),
          orderId: body.orderId,
          amount,
          status: approved ? 'approved' : 'declined',
          reason: approved ? null : `amount exceeds demo limit of ${LIMIT}`,
          createdAt: new Date().toISOString(),
        };
        recent.unshift(payment);
        if (recent.length > 100) recent.pop();
        ctx.metrics.inc('payments_total', { status: payment.status }, 1, 'Payments processed by outcome.');
        ctx.log('info', 'payment processed', { reqId: ctx.reqId, orderId: payment.orderId, amount, status: payment.status });
        return json(201, payment);
      },
    },
    { method: 'GET', path: '/payments', handler: () => json(200, recent) },
  ];

  return createService({ name: NAME, log, routes });
}

module.exports = { build };
if (require.main === module) run(build, 3003);
