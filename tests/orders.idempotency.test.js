const crypto = require('crypto');
const request = require('supertest');
const { Prisma } = require('@prisma/client');
const app = require('../src/app');
const { prisma, cleanDatabase } = require('./helpers');
const { generateAccessToken } = require('../src/utils/token');
const {
  computeRequestHash,
  isIdempotencyKeyConflict,
} = require('../src/modules/orders/order.service');

describe('V3 Checkout Idempotency & Correctness Invariants', () => {
  let user1;
  let user2;
  let token1;
  let token2;
  let category;

  beforeEach(async () => {
    await cleanDatabase();

    user1 = await prisma.user.create({
      data: {
        name: 'Idempotency Tester 1',
        email: 'idemp1@shopscale.test',
        passwordHash: 'dummy-hash-1',
        role: 'USER',
      },
    });

    user2 = await prisma.user.create({
      data: {
        name: 'Idempotency Tester 2',
        email: 'idemp2@shopscale.test',
        passwordHash: 'dummy-hash-2',
        role: 'USER',
      },
    });

    token1 = generateAccessToken({ sub: user1.id, role: user1.role });
    token2 = generateAccessToken({ sub: user2.id, role: user2.role });

    category = await prisma.category.create({
      data: { name: 'Idempotency Test Category' },
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  describe('1. Header Validation API Contract', () => {
    it('rejects request when Idempotency-Key header is missing (400)', async () => {
      const product = await prisma.product.create({
        data: { name: 'Item P1', price: 20.0, stock: 10, categoryId: category.id },
      });

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Idempotency-Key header is required');

      // Database integrity: no orders created, stock unchanged
      expect(await prisma.order.count()).toBe(0);
      const p = await prisma.product.findUnique({ where: { id: product.id } });
      expect(p.stock).toBe(10);
    });

    it('rejects request when Idempotency-Key header is empty string or whitespace (400)', async () => {
      const product = await prisma.product.create({
        data: { name: 'Item P2', price: 20.0, stock: 10, categoryId: category.id },
      });

      const resEmpty = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', '')
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(resEmpty.status).toBe(400);
      expect(resEmpty.body.message).toBe('Idempotency-Key header must not be empty');

      const resWhitespace = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', '    ')
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(resWhitespace.status).toBe(400);
      expect(resWhitespace.body.message).toBe('Idempotency-Key header must not be empty');
      expect(await prisma.order.count()).toBe(0);
    });

    it('rejects request when Idempotency-Key exceeds 256 characters (400)', async () => {
      const product = await prisma.product.create({
        data: { name: 'Item P3', price: 20.0, stock: 10, categoryId: category.id },
      });

      const longKey = 'k'.repeat(257);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', longKey)
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Idempotency-Key header must not exceed 256 characters');
      expect(await prisma.order.count()).toBe(0);
    });

    it('rejects request when Idempotency-Key contains non-printable ASCII (400)', async () => {
      const product = await prisma.product.create({
        data: { name: 'Item P4', price: 20.0, stock: 10, categoryId: category.id },
      });

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', 'invalid-\u00FF-key')
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Idempotency-Key header contains invalid characters');
      expect(await prisma.order.count()).toBe(0);
    });
  });

  describe('2. Invariant A: Sequential Replay & Response Consistency', () => {
    it('sequential duplicate checkout returns identical response and does not double-decrement stock', async () => {
      const product = await prisma.product.create({
        data: { name: 'Replay Product', price: 35.0, stock: 10, categoryId: category.id },
      });

      const idempotencyKey = crypto.randomUUID();
      const payload = { items: [{ productId: product.id, quantity: 2 }] };

      // First request
      const res1 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res1.body.status).toBe('success');
      const order1 = res1.body.data.order;
      expect(order1.id).toBeDefined();

      const stockAfterFirst = (await prisma.product.findUnique({ where: { id: product.id } })).stock;
      expect(stockAfterFirst).toBe(8); // 10 - 2
      expect(await prisma.order.count()).toBe(1);

      // Second request (replay)
      const res2 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.body.status).toBe('success');
      const order2 = res2.body.data.order;

      // Invariant: Exact same order ID returned
      expect(order2.id).toBe(order1.id);
      expect(order2.userId).toBe(order1.userId);
      expect(order2.totalPrice).toBe(order1.totalPrice);
      expect(order2.items.length).toBe(order1.items.length);
      expect(order2.items[0].id).toBe(order1.items[0].id);

      // Invariant: Stock was NOT decremented again
      const stockAfterSecond = (await prisma.product.findUnique({ where: { id: product.id } })).stock;
      expect(stockAfterSecond).toBe(8);

      // Invariant: Exactly one order in DB
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.orderItem.count()).toBe(1);

      // Verify idempotency record in DB
      const idempRecord = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key: idempotencyKey, userId: user1.id } },
      });
      expect(idempRecord).not.toBeNull();
      expect(idempRecord.responseCode).toBe(201);
      expect(idempRecord.responseBody.data.order.id).toBe(order1.id);
    });
  });

  describe('3. Invariant B: Concurrent Same-Key Requests', () => {
    it('10 concurrent requests with the same user and key result in exactly 1 order', async () => {
      const product = await prisma.product.create({
        data: { name: 'Concurrent Item', price: 15.0, stock: 10, categoryId: category.id },
      });

      const sharedKey = crypto.randomUUID();
      const payload = { items: [{ productId: product.id, quantity: 1 }] };

      const requests = Array.from({ length: 10 }, () =>
        request(app)
          .post('/api/orders')
          .set('Authorization', `Bearer ${token1}`)
          .set('Idempotency-Key', sharedKey)
          .send(payload)
      );

      const responses = await Promise.all(requests);

      // All 10 requests should succeed with 201
      for (const res of responses) {
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('success');
      }

      // All 10 responses must return the EXACT same order ID
      const orderIds = responses.map((r) => r.body.data.order.id);
      const uniqueOrderIds = new Set(orderIds);
      expect(uniqueOrderIds.size).toBe(1);

      // Invariant: stock was decremented exactly ONCE (10 - 1 = 9)
      const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
      expect(updatedProduct.stock).toBe(9);

      // Invariant: exactly 1 order and 1 idempotency key row in DB
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.orderItem.count()).toBe(1);
      expect(await prisma.idempotencyKey.count()).toBe(1);
    });
  });

  describe('4. Invariant F: User Isolation', () => {
    it('different users can independently use the same idempotency key string', async () => {
      const product = await prisma.product.create({
        data: { name: 'Shared Key Item', price: 25.0, stock: 10, categoryId: category.id },
      });

      const sharedKey = 'client-generated-static-key-12345';
      const payload = { items: [{ productId: product.id, quantity: 1 }] };

      // User 1 checkout
      const resUser1 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', sharedKey)
        .send(payload);

      expect(resUser1.status).toBe(201);
      const order1 = resUser1.body.data.order;
      expect(order1.userId).toBe(user1.id);

      // User 2 checkout with the SAME key string
      const resUser2 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token2}`)
        .set('Idempotency-Key', sharedKey)
        .send(payload);

      expect(resUser2.status).toBe(201);
      const order2 = resUser2.body.data.order;
      expect(order2.userId).toBe(user2.id);

      // Invariant: Two distinct orders created for two distinct users
      expect(order1.id).not.toBe(order2.id);
      expect(await prisma.order.count()).toBe(2);

      // Invariant: Stock decremented for both purchases (10 - 1 - 1 = 8)
      const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
      expect(updatedProduct.stock).toBe(8);

      // Invariant: Two distinct idempotency_key rows scoped by composite PK (key, userId)
      const user1Key = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key: sharedKey, userId: user1.id } },
      });
      const user2Key = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key: sharedKey, userId: user2.id } },
      });
      expect(user1Key).not.toBeNull();
      expect(user2Key).not.toBeNull();
      expect(user1Key.responseBody.data.order.id).toBe(order1.id);
      expect(user2Key.responseBody.data.order.id).toBe(order2.id);
    });
  });

  describe('5. Invariant E: Payload Mismatch & Fingerprinting', () => {
    it('rejects key reuse when quantity changes (422)', async () => {
      const product = await prisma.product.create({
        data: { name: 'Fingerprint Item', price: 10.0, stock: 10, categoryId: category.id },
      });

      const key = crypto.randomUUID();

      // Original request: quantity = 1
      const res1 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(res1.status).toBe(201);
      expect(await prisma.order.count()).toBe(1);

      // Mismatched request: quantity = 2 with same key
      const res2 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: product.id, quantity: 2 }] });

      expect(res2.status).toBe(422);
      expect(res2.body.message).toMatch(/different request payload/i);

      // No second order created, stock only decremented by original quantity
      expect(await prisma.order.count()).toBe(1);
      const p = await prisma.product.findUnique({ where: { id: product.id } });
      expect(p.stock).toBe(9);
    });

    it('rejects key reuse when product changes (422)', async () => {
      const pA = await prisma.product.create({
        data: { name: 'Product A', price: 10.0, stock: 10, categoryId: category.id },
      });
      const pB = await prisma.product.create({
        data: { name: 'Product B', price: 20.0, stock: 10, categoryId: category.id },
      });

      const key = crypto.randomUUID();

      const res1 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: pA.id, quantity: 1 }] });
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: pB.id, quantity: 1 }] });

      expect(res2.status).toBe(422);
      expect(res2.body.message).toMatch(/different request payload/i);
    });

    it('accepts reordered items as semantically equivalent and returns cached replay (201)', async () => {
      const p1 = await prisma.product.create({
        data: { name: 'Item One', price: 12.0, stock: 10, categoryId: category.id },
      });
      const p2 = await prisma.product.create({
        data: { name: 'Item Two', price: 18.0, stock: 10, categoryId: category.id },
      });

      const key = crypto.randomUUID();

      // Original request: [p1, p2]
      const res1 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({
          items: [
            { productId: p1.id, quantity: 1 },
            { productId: p2.id, quantity: 2 },
          ],
        });

      expect(res1.status).toBe(201);
      const originalOrderId = res1.body.data.order.id;

      // Replay request with reverse order: [p2, p1]
      const res2 = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({
          items: [
            { productId: p2.id, quantity: 2 },
            { productId: p1.id, quantity: 1 },
          ],
        });

      expect(res2.status).toBe(201);
      expect(res2.body.data.order.id).toBe(originalOrderId);
      expect(await prisma.order.count()).toBe(1);
    });
  });

  describe('6. Invariant D: Rollback & Lenient Failure Policy', () => {
    it('failed checkout does not consume the idempotency key; key can be retried after restock', async () => {
      const product = await prisma.product.create({
        data: { name: 'Out of Stock Item', price: 50.0, stock: 0, categoryId: category.id },
      });

      const key = crypto.randomUUID();

      // Attempt 1: stock is 0 -> fails with 400
      const resFail = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(resFail.status).toBe(400);
      expect(resFail.body.message).toMatch(/insufficient stock/i);

      // Verify database state: no order, and crucially NO idempotency_keys record
      expect(await prisma.order.count()).toBe(0);
      const keyInDb = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key, userId: user1.id } },
      });
      expect(keyInDb).toBeNull(); // Transaction rolled back the key insertion!

      // Restock the product
      await prisma.product.update({
        where: { id: product.id },
        data: { stock: 5 },
      });

      // Attempt 2: Retry with the EXACT same idempotency key
      const resSuccess = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: product.id, quantity: 1 }] });

      expect(resSuccess.status).toBe(201);
      expect(resSuccess.body.status).toBe('success');
      expect(resSuccess.body.data.order.id).toBeDefined();

      // Database verification
      expect(await prisma.order.count()).toBe(1);
      const refreshedProduct = await prisma.product.findUnique({ where: { id: product.id } });
      expect(refreshedProduct.stock).toBe(4); // 5 - 1

      const savedKey = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key, userId: user1.id } },
      });
      expect(savedKey).not.toBeNull();
      expect(savedKey.responseCode).toBe(201);
    });

    it('multi-item rollback leaves no partial stock decrement or orphan idempotency record', async () => {
      const inStock = await prisma.product.create({
        data: { name: 'Available', price: 10.0, stock: 5, categoryId: category.id },
      });
      const zeroStock = await prisma.product.create({
        data: { name: 'Unavailable', price: 20.0, stock: 0, categoryId: category.id },
      });

      const key = crypto.randomUUID();

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send({
          items: [
            { productId: inStock.id, quantity: 2 },
            { productId: zeroStock.id, quantity: 1 },
          ],
        });

      expect(res.status).toBe(400);

      // Stock of available item must NOT be decremented
      const checkInStock = await prisma.product.findUnique({ where: { id: inStock.id } });
      expect(checkInStock.stock).toBe(5);

      // No idempotency record left in DB
      const checkKey = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key, userId: user1.id } },
      });
      expect(checkKey).toBeNull();
    });
  });

  describe('7. Invariant C: Lost HTTP Response Recovery', () => {
    it('recovers original outcome when client retries after simulated lost response', async () => {
      const product = await prisma.product.create({
        data: { name: 'Lost Response Item', price: 40.0, stock: 5, categoryId: category.id },
      });

      const key = crypto.randomUUID();
      const payload = { items: [{ productId: product.id, quantity: 1 }] };

      // Step 1: Initial checkout succeeds and commits
      const resOriginal = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send(payload);

      expect(resOriginal.status).toBe(201);
      const originalOrderId = resOriginal.body.data.order.id;

      // Simulate client never received resOriginal (network timeout after commit)
      // Step 2: Client retries with the SAME key and payload
      const resRetry = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send(payload);

      expect(resRetry.status).toBe(201);
      expect(resRetry.body.data.order.id).toBe(originalOrderId);

      // Verify no duplicate order or inventory deduction occurred
      expect(await prisma.order.count()).toBe(1);
      const p = await prisma.product.findUnique({ where: { id: product.id } });
      expect(p.stock).toBe(4); // 5 - 1
    });

    it('deterministically recovers when TCP socket is severed immediately after commit before client receives response bytes', async () => {
      const product = await prisma.product.create({
        data: { name: 'Socket Severed Item', price: 60.0, stock: 5, categoryId: category.id },
      });

      const key = crypto.randomUUID();
      const payload = { items: [{ productId: product.id, quantity: 1 }] };

      // Hook express.response.json to destroy the socket after commit but before response delivery
      const express = require('express');
      const originalJson = express.response.json;
      let socketDestroyed = false;

      express.response.json = function (body) {
        express.response.json = originalJson; // Restore immediately
        socketDestroyed = true;
        this.req.socket.destroy(); // Sever connection
      };

      // Attempt 1: Client sends request; order commits in PostgreSQL, but socket is destroyed
      let clientError = null;
      try {
        await request(app)
          .post('/api/orders')
          .set('Authorization', `Bearer ${token1}`)
          .set('Idempotency-Key', key)
          .send(payload);
      } catch (err) {
        clientError = err;
      } finally {
        express.response.json = originalJson; // Safety restore
      }

      // Verify client received a network failure (socket hang up)
      expect(socketDestroyed).toBe(true);
      expect(clientError).not.toBeNull();
      expect(clientError.message).toMatch(/socket hang up|ECONNRESET/i);

      // Evidence: Database committed the order before the socket was severed
      expect(await prisma.order.count()).toBe(1);
      const committedOrder = await prisma.order.findFirst();
      expect(committedOrder).not.toBeNull();

      // Evidence: Product stock was decremented once
      const productAfterDrop = await prisma.product.findUnique({ where: { id: product.id } });
      expect(productAfterDrop.stock).toBe(4);

      // Evidence: Idempotency record was committed with responseCode 201
      const savedKey = await prisma.idempotencyKey.findUnique({
        where: { key_userId: { key, userId: user1.id } },
      });
      expect(savedKey).not.toBeNull();
      expect(savedKey.responseCode).toBe(201);
      expect(savedKey.responseBody.data.order.id).toBe(committedOrder.id);

      // Attempt 2: Client retries with the exact same Idempotency-Key
      const resRetry = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', key)
        .send(payload);

      expect(resRetry.status).toBe(201);
      expect(resRetry.body.status).toBe('success');
      expect(resRetry.body.data.order.id).toBe(committedOrder.id);

      // Evidence: Zero duplicate orders and zero duplicate stock deductions
      expect(await prisma.order.count()).toBe(1);
      const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
      expect(finalProduct.stock).toBe(4);
    });
  });

  describe('8. Constraint Discrimination: Non-idempotency P2002', () => {
    it('isIdempotencyKeyConflict correctly discriminates IdempotencyKey P2002 from other P2002 errors', () => {
      // P2002 on IdempotencyKey composite PK
      const idempError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`key`,`user_id`)',
        {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { modelName: 'IdempotencyKey', target: ['key', 'user_id'] },
        }
      );

      // P2002 on User email unique constraint
      const userEmailError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the constraint: `users_email_key`',
        {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { modelName: 'User', target: ['email'] },
        }
      );

      // P2002 on Category name unique constraint
      const categoryError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the constraint: `categories_name_key`',
        {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { modelName: 'Category', target: ['name'] },
        }
      );

      expect(isIdempotencyKeyConflict(idempError)).toBe(true);
      expect(isIdempotencyKeyConflict(userEmailError)).toBe(false);
      expect(isIdempotencyKeyConflict(categoryError)).toBe(false);
      expect(isIdempotencyKeyConflict(new Error('Generic error'))).toBe(false);
    });
  });
});
