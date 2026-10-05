/**
 * V3 Idempotency Experiments — Controlled Investigation
 *
 * Purpose: Investigate the CURRENT checkout behavior to document existing
 * defects and validate our proposed design's assumptions.
 *
 * These experiments do NOT implement idempotency. They demonstrate
 * what happens TODAY when duplicate checkout requests are submitted.
 *
 * Target: ShopScale_test database
 * Run: node tests/experiments/v3-idempotency-experiments.js
 */

// Load test environment first
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env.test') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const app = require('../../src/app');
const { generateAccessToken } = require('../../src/utils/token');
const request = require('supertest');
const { assertTestDatabase } = require('../test-db-guard');

// ─── Helpers ───────────────────────────────────────────────────────────
async function cleanDatabase() {
  assertTestDatabase();
  await prisma.$transaction([
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
  ]);
}

async function createTestUser(email = 'experiment@shopscale.test') {
  return prisma.user.create({
    data: {
      name: 'Experiment User',
      email,
      passwordHash: 'dummy-hash-not-used-for-api-auth',
      role: 'USER',
    },
  });
}

async function createTestCategory() {
  return prisma.category.create({ data: { name: 'Experiment Category' } });
}

async function createTestProduct(categoryId, stock = 10, name = 'Experiment Product', price = 25.00) {
  return prisma.product.create({
    data: { name, price, stock, categoryId },
  });
}

function getToken(user) {
  return generateAccessToken({ sub: user.id, role: user.role });
}

async function getDbState(productId) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  const orders = await prisma.order.findMany({
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });
  return { stock: product?.stock, orderCount: orders.length, orders };
}

function printResult(name, data) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  EXPERIMENT: ${name}`);
  console.log(`${'='.repeat(70)}`);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null) {
      console.log(`  ${key}:`);
      console.log(`    ${JSON.stringify(value, null, 2).replace(/\n/g, '\n    ')}`);
    } else {
      console.log(`  ${key}: ${value}`);
    }
  }
}

// ─── Experiment 1: Sequential Duplicate Checkout ───────────────────────
async function experiment1() {
  await cleanDatabase();
  const user = await createTestUser();
  const token = getToken(user);
  const category = await createTestCategory();
  const product = await createTestProduct(category.id, 10);

  const payload = { items: [{ productId: product.id, quantity: 2 }] };

  const stateBefore = await getDbState(product.id);

  // First request
  const res1 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);

  const stateAfterFirst = await getDbState(product.id);

  // Second request — identical payload, same user
  const res2 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);

  const stateAfterSecond = await getDbState(product.id);

  const order1Id = res1.body?.data?.order?.id || 'N/A';
  const order2Id = res2.body?.data?.order?.id || 'N/A';

  printResult('1 - Sequential Duplicate Checkout', {
    'Stock before': stateBefore.stock,
    'Request 1 status': res1.status,
    'Request 1 order ID': order1Id,
    'Stock after request 1': stateAfterFirst.stock,
    'Orders after request 1': stateAfterFirst.orderCount,
    'Request 2 status': res2.status,
    'Request 2 order ID': order2Id,
    'Stock after request 2': stateAfterSecond.stock,
    'Orders after request 2': stateAfterSecond.orderCount,
    'Same order ID?': order1Id === order2Id,
    'DEFECT - Duplicate order created': order1Id !== order2Id && res2.status === 201,
    'Stock double-decremented': stateAfterSecond.stock === stateBefore.stock - 4,
  });

  return {
    duplicateCreated: order1Id !== order2Id && res2.status === 201,
    stockDoubleDecremented: stateAfterSecond.stock === stateBefore.stock - 4,
  };
}

// ─── Experiment 2: Concurrent Same-Payload Checkout ────────────────────
async function experiment2() {
  await cleanDatabase();
  const user = await createTestUser();
  const token = getToken(user);
  const category = await createTestCategory();
  const product = await createTestProduct(category.id, 10);

  const payload = { items: [{ productId: product.id, quantity: 1 }] };
  const stateBefore = await getDbState(product.id);

  // Fire 10 concurrent requests — same user, same payload, NO idempotency key
  const concurrency = 10;
  const promises = Array.from({ length: concurrency }, () =>
    request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
  );

  const responses = await Promise.all(promises);
  const stateAfter = await getDbState(product.id);

  const successful = responses.filter(r => r.status === 201);
  const failed = responses.filter(r => r.status !== 201);
  const uniqueOrderIds = new Set(successful.map(r => r.body?.data?.order?.id));

  printResult('2 - Concurrent Same-Payload Checkout (10 requests)', {
    'Stock before': stateBefore.stock,
    'Concurrent requests': concurrency,
    'Successful (201)': successful.length,
    'Failed (non-201)': failed.length,
    'Unique order IDs': uniqueOrderIds.size,
    'Stock after': stateAfter.stock,
    'Orders in DB': stateAfter.orderCount,
    'Multiple orders from identical payload': stateAfter.orderCount > 1
      ? `YES - ${stateAfter.orderCount} orders created`
      : 'No',
    'Stock calculation correct': stateAfter.stock === stateBefore.stock - successful.length,
  });

  return {
    ordersCreated: stateAfter.orderCount,
    stockCorrect: stateAfter.stock === stateBefore.stock - successful.length,
  };
}

// ─── Experiment 3: Lost Response Simulation ────────────────────────────
async function experiment3() {
  await cleanDatabase();
  const user = await createTestUser();
  const token = getToken(user);
  const category = await createTestCategory();
  const product = await createTestProduct(category.id, 5);

  const payload = { items: [{ productId: product.id, quantity: 1 }] };

  // Step 1: Request succeeds and commits
  const res1 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);

  const order1Id = res1.body?.data?.order?.id;
  const stateAfterCommit = await getDbState(product.id);

  // Step 2: Client "lost" the response — retries with identical payload
  const res2 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);

  const order2Id = res2.body?.data?.order?.id;
  const stateAfterRetry = await getDbState(product.id);

  printResult('3 - Lost Response Simulation (retry after commit)', {
    'First request status': res1.status,
    'First order ID': order1Id,
    'Stock after commit': stateAfterCommit.stock,
    'Orders after commit': stateAfterCommit.orderCount,
    'Retry request status': res2.status,
    'Retry order ID': order2Id,
    'Stock after retry': stateAfterRetry.stock,
    'Orders after retry': stateAfterRetry.orderCount,
    'Same order returned?': order1Id === order2Id,
    'DEFECT - Duplicate order on retry': order1Id !== order2Id && res2.status === 201,
    'NOTE': 'Without an idempotency key, the server cannot distinguish a retry from a new order.',
  });

  return {
    duplicateOnRetry: order1Id !== order2Id && res2.status === 201,
  };
}

// ─── Experiment 4: Same Key, Different Payload (current behavior) ──────
async function experiment4() {
  await cleanDatabase();
  const user = await createTestUser();
  const token = getToken(user);
  const category = await createTestCategory();
  const product1 = await createTestProduct(category.id, 10, 'Product Alpha', 10.00);
  const product2 = await createTestProduct(category.id, 10, 'Product Beta', 20.00);

  // Three different payloads submitted sequentially
  const res1 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: product1.id, quantity: 1 }] });

  const res2 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: product1.id, quantity: 3 }] });

  const res3 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: product2.id, quantity: 1 }] });

  const p1Final = await prisma.product.findUnique({ where: { id: product1.id } });
  const p2Final = await prisma.product.findUnique({ where: { id: product2.id } });
  const totalOrders = await prisma.order.count();

  printResult('4 - Different Payloads (no idempotency key, no mismatch detection)', {
    'Request 1 (p1, qty=1)': `${res1.status} - order ${res1.body?.data?.order?.id?.substring(0, 8) || 'N/A'}`,
    'Request 2 (p1, qty=3)': `${res2.status} - order ${res2.body?.data?.order?.id?.substring(0, 8) || 'N/A'}`,
    'Request 3 (p2, qty=1)': `${res3.status} - order ${res3.body?.data?.order?.id?.substring(0, 8) || 'N/A'}`,
    'Product 1 stock': `${p1Final.stock} (started at 10, expected 6)`,
    'Product 2 stock': `${p2Final.stock} (started at 10, expected 9)`,
    'Total orders': totalOrders,
    'OBSERVATION': 'Every valid request creates a distinct order. No payload comparison exists.',
  });

  return { totalOrders };
}

// ─── Experiment 5: Rollback Consistency & Retry ────────────────────────
async function experiment5() {
  await cleanDatabase();
  const user = await createTestUser();
  const token = getToken(user);
  const category = await createTestCategory();

  const productA = await createTestProduct(category.id, 5, 'In-Stock Item', 15.00);
  const productB = await createTestProduct(category.id, 0, 'Zero-Stock Item', 30.00);

  const stateBefore = {
    stockA: (await prisma.product.findUnique({ where: { id: productA.id } })).stock,
    stockB: (await prisma.product.findUnique({ where: { id: productB.id } })).stock,
    orderCount: await prisma.order.count(),
    orderItemCount: await prisma.orderItem.count(),
  };

  // Multi-item order where item B will fail (stock=0)
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      items: [
        { productId: productA.id, quantity: 2 },
        { productId: productB.id, quantity: 1 },
      ],
    });

  const stateAfterFailure = {
    stockA: (await prisma.product.findUnique({ where: { id: productA.id } })).stock,
    stockB: (await prisma.product.findUnique({ where: { id: productB.id } })).stock,
    orderCount: await prisma.order.count(),
    orderItemCount: await prisma.orderItem.count(),
  };

  // Retry with ONLY productA (valid this time)
  const retryRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: productA.id, quantity: 2 }] });

  const stateAfterRetry = {
    stockA: (await prisma.product.findUnique({ where: { id: productA.id } })).stock,
    stockB: (await prisma.product.findUnique({ where: { id: productB.id } })).stock,
    orderCount: await prisma.order.count(),
    orderItemCount: await prisma.orderItem.count(),
  };

  const rollbackClean = stateAfterFailure.stockA === stateBefore.stockA &&
    stateAfterFailure.stockB === stateBefore.stockB &&
    stateAfterFailure.orderCount === 0 &&
    stateAfterFailure.orderItemCount === 0;

  printResult('5 - Rollback Consistency & Retry After Failure', {
    'State before': stateBefore,
    'Failed request status': res.status,
    'Failed request message': res.body?.message || 'N/A',
    'State after failure': stateAfterFailure,
    'Rollback fully clean': rollbackClean,
    'Retry status': retryRes.status,
    'Retry order ID': retryRes.body?.data?.order?.id || 'N/A',
    'State after retry': stateAfterRetry,
    'Stock A correctly decremented': stateAfterRetry.stockA === stateBefore.stockA - 2,
    'CONCLUSION': rollbackClean
      ? 'Transaction rollback is atomic - no partial state survives. Retry succeeds cleanly.'
      : 'WARNING: Partial state survived rollback!',
  });

  return { rollbackClean, retrySucceeded: retryRes.status === 201 };
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('======================================================================');
  console.log('  ShopScale V3 - Idempotency Controlled Experiments');
  console.log('  Target: ShopScale_test database');
  console.log('  Purpose: Document current behavior (no idempotency implementation)');
  console.log('======================================================================');

  const results = {};

  try {
    results.exp1 = await experiment1();
    results.exp2 = await experiment2();
    results.exp3 = await experiment3();
    results.exp4 = await experiment4();
    results.exp5 = await experiment5();

    console.log(`\n${'='.repeat(70)}`);
    console.log('  SUMMARY');
    console.log(`${'='.repeat(70)}`);
    console.log(`  Exp 1 (Sequential duplicate):    Duplicate created = ${results.exp1.duplicateCreated}`);
    console.log(`  Exp 2 (Concurrent same-payload):  ${results.exp2.ordersCreated} orders, Stock correct = ${results.exp2.stockCorrect}`);
    console.log(`  Exp 3 (Lost response retry):      Duplicate on retry = ${results.exp3.duplicateOnRetry}`);
    console.log(`  Exp 4 (Different payloads):        ${results.exp4.totalOrders} orders (expected: 3 distinct)`);
    console.log(`  Exp 5 (Rollback + retry):          Rollback clean = ${results.exp5.rollbackClean}, Retry OK = ${results.exp5.retrySucceeded}`);
    console.log(`${'='.repeat(70)}\n`);
  } catch (err) {
    console.error('EXPERIMENT FAILED:', err);
  } finally {
    await cleanDatabase();
    await prisma.$disconnect();
  }
}

main();
