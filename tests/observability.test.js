const request = require('supertest');
const app = require('../src/app');
const { prisma, cleanDatabase } = require('./helpers');
const { generateAccessToken } = require('../src/utils/token');
const { logger, captureLogs, SENSITIVE_PATHS } = require('../src/utils/logger');
const productService = require('../src/modules/products/product.service');

describe('V4.1 — Observability Foundation', () => {
  let user;
  let token;
  let category;
  let product;

  beforeEach(async () => {
    await cleanDatabase();

    user = await prisma.user.create({
      data: {
        name: 'Observability User',
        email: 'obs@shopscale.test',
        passwordHash: 'dummy-hash-obs',
        role: 'USER',
      },
    });

    token = generateAccessToken({ sub: user.id, role: user.role });

    category = await prisma.category.create({
      data: { name: 'Observability Category' },
    });

    product = await prisma.product.create({
      data: {
        name: 'Observability Item',
        price: 25.0,
        stock: 50,
        categoryId: category.id,
      },
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  describe('1. Request IDs', () => {
    it('generates a new UUID request ID when X-Request-ID is missing', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      const requestId = res.headers['x-request-id'];
      expect(requestId).toBeDefined();
      // Standard UUID format
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('propagates supplied valid X-Request-ID header in response', async () => {
      const customId = 'client-req-abc-12345';
      const res = await request(app)
        .get('/health')
        .set('X-Request-ID', customId);

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(customId);
    });

    it('replaces malformed/unbounded X-Request-ID with a freshly generated UUID', async () => {
      const maliciousId = '<script>bad_id</script> ' + 'x'.repeat(200);
      const res = await request(app)
        .get('/health')
        .set('X-Request-ID', maliciousId);

      expect(res.status).toBe(200);
      const requestId = res.headers['x-request-id'];
      expect(requestId).not.toBe(maliciousId);
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('2. HTTP Request Logging', () => {
    it('produces one structured request log on completion with required fields', async () => {
      const logCapture = captureLogs();

      const res = await request(app)
        .get('/health')
        .set('X-Request-ID', 'req-log-test-1');

      logCapture.release();

      expect(res.status).toBe(200);

      const reqLog = logCapture.logs.find(
        (l) => l.requestId === 'req-log-test-1' && l.msg === 'HTTP request completed'
      );

      expect(reqLog).toBeDefined();
      expect(reqLog.level).toBe(30); // Pino INFO
      expect(reqLog.method).toBe('GET');
      expect(reqLog.path).toBe('/health');
      expect(reqLog.statusCode).toBe(200);
      expect(reqLog.status).toBe(200);
      expect(typeof reqLog.durationMs).toBe('number');
      expect(reqLog.durationMs).toBeGreaterThanOrEqual(0);
      expect(reqLog.userId).toBeNull();
    });

    it('includes authenticated userId in request log when user is authenticated', async () => {
      const logCapture = captureLogs();

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'req-user-test-key')
        .set('X-Request-ID', 'req-user-test-2')
        .send({
          items: [{ productId: product.id, quantity: 1 }],
        });

      logCapture.release();

      expect(res.status).toBe(201);

      const reqLog = logCapture.logs.find(
        (l) => l.requestId === 'req-user-test-2' && l.msg === 'HTTP request completed'
      );

      expect(reqLog).toBeDefined();
      expect(reqLog.userId).toBe(user.id);
    });
  });

  describe('3. Error Logging', () => {
    it('logs unexpected 500 error at ERROR level with stack, omitting stack from client response', async () => {
      const logCapture = captureLogs();

      // Spy on productService to trigger an unexpected internal error
      const spy = jest
        .spyOn(productService, 'getById')
        .mockImplementationOnce(() => {
          throw new Error('Simulated database connection failure');
        });

      const res = await request(app)
        .get(`/api/products/${product.id}`)
        .set('X-Request-ID', 'req-error-500-test');

      spy.mockRestore();
      logCapture.release();

      // Verify client response
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('error');
      expect(res.body.statusCode).toBe(500);
      expect(res.body.message).toBe('Internal server error');
      expect(res.body.stack).toBeUndefined(); // Stack NOT leaked to client

      // Verify server log
      const errorLog = logCapture.logs.find(
        (l) => l.requestId === 'req-error-500-test' && l.level === 50 // Pino ERROR
      );

      expect(errorLog).toBeDefined();
      expect(errorLog.err).toBeDefined();
      expect(errorLog.err.message).toBe('Simulated database connection failure');
      expect(errorLog.err.stack).toContain('Error: Simulated database connection failure');
      expect(errorLog.statusCode).toBe(500);
      expect(errorLog.method).toBe('GET');
      expect(errorLog.path).toBe(`/api/products/${product.id}`);
    });

    it('logs expected 4xx operational errors at WARN level without stack traces', async () => {
      const logCapture = captureLogs();

      const res = await request(app)
        .get('/api/products/non-existent-id')
        .set('X-Request-ID', 'req-warn-404-test');

      logCapture.release();

      expect(res.status).toBe(404);

      const warnLog = logCapture.logs.find(
        (l) => l.requestId === 'req-warn-404-test' && l.level === 40 // Pino WARN
      );

      expect(warnLog).toBeDefined();
      expect(warnLog.statusCode).toBe(404);
      expect(warnLog.err).toBeUndefined();
      expect(warnLog.error).toBeDefined();
      expect(warnLog.error.name).toBe('ApiError');
    });
  });

  describe('4. Sensitive Data Redaction', () => {
    it('redacts passwords, tokens, auth headers, cookies, connection strings, and secrets', () => {
      const logCapture = captureLogs();

      const sensitivePayload = {
        password: 'superSecretPassword123!',
        passwordHash: '$2b$10$dummyHashString123456789',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
        accessToken: 'access-token-raw-secret',
        refreshToken: 'refresh-token-raw-secret',
        authorization: 'Bearer secret_jwt_token_value',
        cookie: 'refresh_token=sensitive_cookie_value_xyz',
        DATABASE_URL: 'postgres://admin:secretPass@localhost:5432/shopscale',
        secret: 'api_master_secret_key_999',
        user: {
          password: 'nestedPassword456',
          token: 'nestedToken789',
        },
      };

      logger.info(sensitivePayload, 'Sensitive test log event');
      logCapture.release();

      const logged = logCapture.logs.find((l) => l.msg === 'Sensitive test log event');
      expect(logged).toBeDefined();

      const serialized = JSON.stringify(logged);

      // Verify that none of the raw sensitive values appear anywhere in the serialized log
      expect(serialized).not.toContain('superSecretPassword123!');
      expect(serialized).not.toContain('$2b$10$dummyHashString123456789');
      expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy');
      expect(serialized).not.toContain('access-token-raw-secret');
      expect(serialized).not.toContain('refresh-token-raw-secret');
      expect(serialized).not.toContain('Bearer secret_jwt_token_value');
      expect(serialized).not.toContain('sensitive_cookie_value_xyz');
      expect(serialized).not.toContain('secretPass');
      expect(serialized).not.toContain('api_master_secret_key_999');
      expect(serialized).not.toContain('nestedPassword456');
      expect(serialized).not.toContain('nestedToken789');

      // Verify that redacted placeholders are used
      expect(logged.password).toBe('[REDACTED]');
      expect(logged.passwordHash).toBe('[REDACTED]');
      expect(logged.token).toBe('[REDACTED]');
      expect(logged.accessToken).toBe('[REDACTED]');
      expect(logged.refreshToken).toBe('[REDACTED]');
      expect(logged.authorization).toBe('[REDACTED]');
      expect(logged.cookie).toBe('[REDACTED]');
      expect(logged.DATABASE_URL).toBe('[REDACTED]');
      expect(logged.secret).toBe('[REDACTED]');
      expect(logged.user.password).toBe('[REDACTED]');
      expect(logged.user.token).toBe('[REDACTED]');
    });
  });

  describe('5. Checkout Outcome Observability', () => {
    it('emits checkout.completed event on fresh successful checkout with safe metadata', async () => {
      const logCapture = captureLogs();
      const rawKey = 'test-idemp-fresh-001';

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', rawKey)
        .set('X-Request-ID', 'req-checkout-fresh-001')
        .send({
          items: [{ productId: product.id, quantity: 2 }],
        });

      logCapture.release();

      expect(res.status).toBe(201);
      const orderId = res.body.data.order.id;

      const checkoutEvent = logCapture.logs.find(
        (l) => l.event === 'checkout.completed'
      );

      expect(checkoutEvent).toBeDefined();
      expect(checkoutEvent.requestId).toBe('req-checkout-fresh-001');
      expect(checkoutEvent.userId).toBe(user.id);
      expect(checkoutEvent.orderId).toBe(orderId);
      expect(checkoutEvent.statusCode).toBe(201);
      expect(typeof checkoutEvent.durationMs).toBe('number');
      expect(checkoutEvent.durationMs).toBeGreaterThanOrEqual(0);

      // Safe key hash verification (16 char sha256 prefix)
      expect(checkoutEvent.keyHash).toBeDefined();
      expect(checkoutEvent.keyHash.length).toBe(16);
      expect(checkoutEvent.keyHash).not.toBe(rawKey);

      // Raw key must NOT be logged
      const serialized = JSON.stringify(checkoutEvent);
      expect(serialized).not.toContain(rawKey);
    });

    it('emits checkout.idempotency_replay event on duplicate request with same key', async () => {
      const rawKey = 'test-idemp-replay-001';

      // First request (creates the order)
      const firstRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', rawKey)
        .set('X-Request-ID', 'req-first-call')
        .send({
          items: [{ productId: product.id, quantity: 1 }],
        });

      expect(firstRes.status).toBe(201);
      const originalOrderId = firstRes.body.data.order.id;

      // Second request (replays the order)
      const logCapture = captureLogs();

      const replayRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', rawKey)
        .set('X-Request-ID', 'req-replay-call')
        .send({
          items: [{ productId: product.id, quantity: 1 }],
        });

      logCapture.release();

      expect(replayRes.status).toBe(201);
      expect(replayRes.body.data.order.id).toBe(originalOrderId);

      const replayEvent = logCapture.logs.find(
        (l) => l.event === 'checkout.idempotency_replay'
      );

      expect(replayEvent).toBeDefined();
      expect(replayEvent.requestId).toBe('req-replay-call');
      expect(replayEvent.userId).toBe(user.id);
      expect(replayEvent.orderId).toBe(originalOrderId);
      expect(replayEvent.statusCode).toBe(201);
      expect(typeof replayEvent.durationMs).toBe('number');
      expect(replayEvent.keyHash.length).toBe(16);

      // Raw key must NOT be logged
      const serialized = JSON.stringify(replayEvent);
      expect(serialized).not.toContain(rawKey);
    });

    it('emits checkout.failed event on checkout error (e.g. insufficient stock)', async () => {
      const logCapture = captureLogs();
      const rawKey = 'test-idemp-fail-stock';

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', rawKey)
        .set('X-Request-ID', 'req-checkout-fail-001')
        .send({
          items: [{ productId: product.id, quantity: 99999 }], // Exceeds stock (50)
        });

      logCapture.release();

      expect(res.status).toBe(400);

      const failEvent = logCapture.logs.find(
        (l) => l.event === 'checkout.failed'
      );

      expect(failEvent).toBeDefined();
      expect(failEvent.requestId).toBe('req-checkout-fail-001');
      expect(failEvent.userId).toBe(user.id);
      expect(failEvent.statusCode).toBe(400);
      expect(failEvent.errorClassification).toBe('validation_or_client_error');
      expect(failEvent.errorMessage).toContain('Insufficient stock');
      expect(typeof failEvent.durationMs).toBe('number');
      expect(failEvent.keyHash.length).toBe(16);

      // Raw key must NOT be logged
      const serialized = JSON.stringify(failEvent);
      expect(serialized).not.toContain(rawKey);
    });

    it('emits checkout.failed event when Idempotency-Key header is missing', async () => {
      const logCapture = captureLogs();

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Request-ID', 'req-checkout-missing-key')
        .send({
          items: [{ productId: product.id, quantity: 1 }],
        });

      logCapture.release();

      expect(res.status).toBe(400);

      const failEvent = logCapture.logs.find(
        (l) => l.event === 'checkout.failed'
      );

      expect(failEvent).toBeDefined();
      expect(failEvent.requestId).toBe('req-checkout-missing-key');
      expect(failEvent.statusCode).toBe(400);
      expect(failEvent.errorMessage).toBe('Idempotency-Key header is required');
    });
  });
});
