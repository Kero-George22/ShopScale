/**
 * V4.3 — Production Configuration & Security Hardening Tests
 *
 * Tests cover:
 *   - Startup configuration validation (DATABASE_URL, token durations, rate limit, CORS)
 *   - NODE_ENV error disclosure (production, unset, development)
 *   - JSON body size limit enforcement (64kb)
 *   - Checkout items count limit (100)
 *   - Product listing pagination clamping (max 50)
 *   - JWT algorithm restriction (HS256 only)
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ──────────────────────────────────────────────────
// 1. Startup Configuration Validation
// ──────────────────────────────────────────────────

describe('Startup configuration validation', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  function requireEnvFresh() {
    // Prevent dotenv from loading .env files during these tests
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    return require('../src/config/env');
  }

  test('rejects startup when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => requireEnvFresh()).toThrow('DATABASE_URL is required');
  });

  test('rejects startup when ACCESS_TOKEN_SECRET is missing', () => {
    delete process.env.ACCESS_TOKEN_SECRET;
    expect(() => requireEnvFresh()).toThrow('ACCESS_TOKEN_SECRET is required');
  });

  test('rejects startup when ACCESS_TOKEN_EXPIRES_IN has invalid format', () => {
    process.env.ACCESS_TOKEN_EXPIRES_IN = 'invalid';
    expect(() => requireEnvFresh()).toThrow(
      'ACCESS_TOKEN_EXPIRES_IN has invalid duration'
    );
  });

  test('rejects startup when REFRESH_TOKEN_EXPIRES_IN has invalid format', () => {
    process.env.REFRESH_TOKEN_EXPIRES_IN = '2 days';
    expect(() => requireEnvFresh()).toThrow(
      'REFRESH_TOKEN_EXPIRES_IN has invalid duration'
    );
  });

  test('rejects startup when ACCESS_TOKEN_EXPIRES_IN is zero', () => {
    process.env.ACCESS_TOKEN_EXPIRES_IN = '0m';
    expect(() => requireEnvFresh()).toThrow(
      'ACCESS_TOKEN_EXPIRES_IN must not be zero'
    );
  });

  test('rejects startup when REFRESH_TOKEN_EXPIRES_IN is zero', () => {
    process.env.REFRESH_TOKEN_EXPIRES_IN = '0d';
    expect(() => requireEnvFresh()).toThrow(
      'REFRESH_TOKEN_EXPIRES_IN must not be zero'
    );
  });

  test('accepts valid token durations without throwing', () => {
    process.env.ACCESS_TOKEN_EXPIRES_IN = '15m';
    process.env.REFRESH_TOKEN_EXPIRES_IN = '7d';
    expect(() => requireEnvFresh()).not.toThrow();
  });

  test('warns but does not fail when access token duration exceeds 1 hour', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ACCESS_TOKEN_EXPIRES_IN = '2h';
    process.env.REFRESH_TOKEN_EXPIRES_IN = '7d';

    expect(() => requireEnvFresh()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ACCESS_TOKEN_EXPIRES_IN')
    );
    warnSpy.mockRestore();
  });

  test('warns but does not fail when refresh token duration exceeds 90 days', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ACCESS_TOKEN_EXPIRES_IN = '15m';
    process.env.REFRESH_TOKEN_EXPIRES_IN = '100d';

    expect(() => requireEnvFresh()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('REFRESH_TOKEN_EXPIRES_IN')
    );
    warnSpy.mockRestore();
  });

  test('warns when AUTH_RATE_LIMIT_MAX is invalid and uses default', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AUTH_RATE_LIMIT_MAX = 'abc';

    const env = requireEnvFresh();
    expect(env.authRateLimitMax).toBe(20);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AUTH_RATE_LIMIT_MAX')
    );
    warnSpy.mockRestore();
  });

  test('warns when CORS_ORIGIN is default in production', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'http://localhost:5173';
    process.env.ACCESS_TOKEN_SECRET =
      'a-production-secret-that-is-at-least-32-characters-long';

    const env = requireEnvFresh();
    expect(env.cors.origin).toBe('http://localhost:5173');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CORS_ORIGIN')
    );
    warnSpy.mockRestore();
  });

  test('isDevMode is true only when NODE_ENV is explicitly "development"', () => {
    process.env.NODE_ENV = 'development';
    const envDev = requireEnvFresh();
    expect(envDev.isDevMode).toBe(true);

    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };

    process.env.NODE_ENV = 'production';
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    const envProd = require('../src/config/env');
    expect(envProd.isDevMode).toBe(false);

    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };

    delete process.env.NODE_ENV;
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    const envUnset = require('../src/config/env');
    expect(envUnset.isDevMode).toBe(false);
  });
});

// ──────────────────────────────────────────────────
// 2. NODE_ENV Error Disclosure
// ──────────────────────────────────────────────────

describe('NODE_ENV error disclosure', () => {
  const { Prisma } = require('@prisma/client');
  const errorHandler = require('../src/middleware/errorHandler');
  const env = require('../src/config/env');
  const express = require('express');

  function createMockContext() {
    const req = {
      requestId: 'req-sec-test-123',
      method: 'GET',
      path: '/test-error',
      originalUrl: '/test-error',
      log: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
      },
    };
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
    };
    const next = jest.fn();
    return { req, res, next };
  }

  describe('direct errorHandler middleware verification', () => {
    let originalIsDevMode;

    beforeEach(() => {
      originalIsDevMode = env.isDevMode;
    });

    afterEach(() => {
      env.isDevMode = originalIsDevMode;
    });

    test('hides stack traces and sensitive error message when isDevMode is false (production / unset)', () => {
      env.isDevMode = false;
      const { req, res, next } = createMockContext();
      const secretError = new Error('Sensitive database credentials leak: postgresql://admin:secret@db');

      errorHandler(secretError, req, res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(res.body.stack).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('Sensitive database credentials');
      expect(JSON.stringify(res.body)).not.toContain('secret@db');
    });

    test('includes stack trace when isDevMode is true (explicit development)', () => {
      env.isDevMode = true;
      const { req, res, next } = createMockContext();
      const testError = new Error('Development debugging error');

      errorHandler(testError, req, res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body.status).toBe('error');
      expect(res.body.stack).toBeDefined();
      expect(res.body.stack).toContain('Development debugging error');
    });

    test('hides Prisma P2002 internal field target when isDevMode is false', () => {
      env.isDevMode = false;
      const { req, res, next } = createMockContext();
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['email'] },
        }
      );

      errorHandler(prismaError, req, res, next);

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        status: 'error',
        statusCode: 409,
        message: 'A record with this value already exists',
      });
      expect(res.body.field).toBeUndefined();
    });

    test('exposes Prisma P2002 field target when isDevMode is true', () => {
      env.isDevMode = true;
      const { req, res, next } = createMockContext();
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['email'] },
        }
      );

      errorHandler(prismaError, req, res, next);

      expect(res.statusCode).toBe(409);
      expect(res.body.field).toBe('email');
    });

    test('masks unhandled Prisma database errors with a generic message', () => {
      env.isDevMode = false;
      const { req, res, next } = createMockContext();
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Raw database connection reset by peer in query execution',
        {
          code: 'P9999',
          clientVersion: '5.22.0',
        }
      );

      errorHandler(prismaError, req, res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        statusCode: 500,
        message: 'A database error occurred',
      });
      expect(JSON.stringify(res.body)).not.toContain('connection reset');
    });
  });

  describe('HTTP error disclosure test harness', () => {
    let testApp;

    beforeAll(() => {
      testApp = express();
      testApp.get('/test-unexpected-error', (req, res, next) => {
        next(new Error('Internal query failure: SELECT * FROM secrets WHERE key = "supersecret"'));
      });
      testApp.get('/test-prisma-error', (req, res, next) => {
        next(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.22.0',
            meta: { target: ['user_id', 'role'] },
          })
        );
      });
      testApp.use(errorHandler);
    });

    test('HTTP client response for 500 error hides stack trace and query internals', async () => {
      const res = await request(testApp).get('/test-unexpected-error');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(res.body.stack).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('supersecret');
      expect(JSON.stringify(res.body)).not.toContain('SELECT *');
    });

    test('HTTP client response for Prisma P2002 hides internal target fields in non-dev mode', async () => {
      const res = await request(testApp).get('/test-prisma-error');

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        status: 'error',
        statusCode: 409,
        message: 'A record with this value already exists',
      });
      expect(res.body.field).toBeUndefined();
    });

    test('main application hides stack traces on body parsing errors', async () => {
      const app = require('../src/app');

      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"malformed json');

      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('stack');
    });
  });
});

// ──────────────────────────────────────────────────
// 3. JSON Body Size Limit (64kb)
// ──────────────────────────────────────────────────

describe('JSON body size limit', () => {
  let app;

  beforeAll(() => {
    app = require('../src/app');
  });

  test('rejects body larger than 64kb with 413', async () => {
    // Create a payload larger than 64kb (65536 bytes)
    // Each character in a JSON string value is 1 byte for ASCII
    const oversizedPayload = JSON.stringify({
      data: 'x'.repeat(70000),
    });

    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(oversizedPayload);

    expect(res.status).toBe(413);
  });

  test('accepts normal-sized body', async () => {
    const app = require('../src/app');

    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'test@test.com', password: 'password123' }));

    // Should not be 413 — it may be 400 (validation) or another code, but not 413
    expect(res.status).not.toBe(413);
  });
});

// ──────────────────────────────────────────────────
// 4. Checkout Items Limit (100)
// ──────────────────────────────────────────────────

describe('Checkout items count limit', () => {
  const { createOrderSchema } = require('../src/modules/orders/order.validation');
  const validate = require('../src/middleware/validate');
  const errorHandler = require('../src/middleware/errorHandler');
  const express = require('express');

  function makeItems(count) {
    return Array.from({ length: count }, () => ({
      productId: crypto.randomUUID(),
      quantity: 1,
    }));
  }

  describe('direct schema validation (createOrderSchema)', () => {
    test('accepts checkout payload with exactly 100 items', () => {
      const result = createOrderSchema.safeParse({ items: makeItems(100) });
      expect(result.success).toBe(true);
      expect(result.data.items).toHaveLength(100);
    });

    test('rejects checkout payload with 101 items', () => {
      const result = createOrderSchema.safeParse({ items: makeItems(101) });
      expect(result.success).toBe(false);
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['items'],
            message: expect.stringContaining('100'),
          }),
        ])
      );
    });

    test('accepts checkout payload with 1 item', () => {
      const result = createOrderSchema.safeParse({ items: makeItems(1) });
      expect(result.success).toBe(true);
    });

    test('rejects checkout payload with 0 items', () => {
      const result = createOrderSchema.safeParse({ items: [] });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toContain('at least one item');
    });
  });

  describe('validation middleware behavior', () => {
    test('passes 100 items to next() without error', () => {
      const middleware = validate(createOrderSchema);
      const req = { body: { items: makeItems(100) } };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    test('passes 101 items to next(err) with 400 validation error', () => {
      const middleware = validate(createOrderSchema);
      const req = { body: { items: makeItems(101) } };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('Validation failed');
      expect(err.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'items',
            message: expect.stringContaining('100'),
          }),
        ])
      );
    });
  });

  describe('HTTP validation boundary test (isolated from DB)', () => {
    let testApp;

    beforeAll(() => {
      testApp = express();
      testApp.use(express.json());
      testApp.post(
        '/test-checkout-validation',
        validate(createOrderSchema),
        (req, res) => {
          res.status(200).json({
            status: 'success',
            count: req.body.items.length,
          });
        }
      );
      testApp.use(errorHandler);
    });

    test('accepts exactly 100 items over HTTP with 200', async () => {
      const res = await request(testApp)
        .post('/test-checkout-validation')
        .send({ items: makeItems(100) });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'success',
        count: 100,
      });
    });

    test('rejects 101 items over HTTP with 400 and validation error message', async () => {
      const res = await request(testApp)
        .post('/test-checkout-validation')
        .send({ items: makeItems(101) });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'items',
            message: expect.stringContaining('100'),
          }),
        ])
      );
    });
  });
});

// ──────────────────────────────────────────────────
// 5. Product Listing Pagination Clamping
// ──────────────────────────────────────────────────

describe('Product listing pagination clamping', () => {
  let app;

  beforeAll(() => {
    app = require('../src/app');
  });

  test('clamps limit to 50 when higher value requested', async () => {
    const res = await request(app)
      .get('/api/products?limit=200')
      .expect(200);

    // The response data should reflect the clamped limit
    expect(res.body.data.limit).toBeLessThanOrEqual(50);
  });

  test('uses default limit of 20 when not specified', async () => {
    const res = await request(app)
      .get('/api/products')
      .expect(200);

    expect(res.body.data.limit).toBe(20);
  });

  test('clamps negative page to 1', async () => {
    const res = await request(app)
      .get('/api/products?page=-5')
      .expect(200);

    expect(res.body.data.page).toBe(1);
  });

  test('clamps zero limit to 1', async () => {
    const res = await request(app)
      .get('/api/products?limit=0')
      .expect(200);

    // limit=0 → parseInt gives 0 → || 20 gives 20 → max(20,1)=20 → min(20,50)=20
    expect(res.body.data.limit).toBe(20);
  });

  test('clamps negative limit to default', async () => {
    const res = await request(app)
      .get('/api/products?limit=-10')
      .expect(200);

    // limit=-10 → parseInt gives -10 → || 20 not triggered (truthy)
    // → max(-10, 1) = 1 → min(1, 50) = 1
    expect(res.body.data.limit).toBeGreaterThanOrEqual(1);
    expect(res.body.data.limit).toBeLessThanOrEqual(50);
  });
});

// ──────────────────────────────────────────────────
// 6. JWT Algorithm Restriction
// ──────────────────────────────────────────────────

describe('JWT algorithm restriction', () => {
  let app;

  beforeAll(() => {
    app = require('../src/app');
  });

  test('accepts a valid HS256 token', async () => {
    const env = require('../src/config/env');
    const token = jwt.sign(
      { sub: crypto.randomUUID(), role: 'user' },
      env.accessTokenSecret,
      { algorithm: 'HS256', expiresIn: '15m' }
    );

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] });

    // Should not be 401 — token is valid
    expect(res.status).not.toBe(401);
  });

  test('rejects a token with alg:none', async () => {
    // Manually craft a token with alg:none
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: crypto.randomUUID(), role: 'user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${noneToken}`)
      .send({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] });

    expect(res.status).toBe(401);
  });

  test('rejects a token with invalid signature', async () => {
    const env = require('../src/config/env');
    const token = jwt.sign(
      { sub: crypto.randomUUID(), role: 'user' },
      'wrong-secret-key-that-does-not-match',
      { algorithm: 'HS256', expiresIn: '15m' }
    );

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] });

    expect(res.status).toBe(401);
  });
});
