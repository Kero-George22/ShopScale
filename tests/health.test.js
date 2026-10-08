const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/database/prisma');
const { captureLogs } = require('../src/utils/logger');

describe('V4.2A — Health & Readiness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.HEALTH_CHECK_TIMEOUT_MS;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('1. Liveness (/health/live)', () => {
    it('returns 200 OK with safe deterministic status', async () => {
      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });

      // Ensure no infrastructure details are exposed
      expect(res.body.memory).toBeUndefined();
      expect(res.body.env).toBeUndefined();
      expect(res.body.database).toBeUndefined();
    });

    it('succeeds even when PostgreSQL is unavailable', async () => {
      // Mock database error to verify liveness does NOT depend on PostgreSQL
      jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('PostgreSQL connection refused'));

      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('2. Readiness (/health/ready) — Healthy Database', () => {
    it('returns 200 OK when database is connected', async () => {
      const querySpy = jest.spyOn(prisma, '$queryRaw');

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.database).toBe('connected');

      // Verify the SELECT 1 query was actually executed
      expect(querySpy).toHaveBeenCalledTimes(1);

      // Verify no sensitive internal details are leaked
      expect(res.body.host).toBeUndefined();
      expect(res.body.credentials).toBeUndefined();
      expect(res.body.connectionString).toBeUndefined();
      expect(res.body.sql).toBeUndefined();
    });
  });

  describe('3. Readiness (/health/ready) — Database Unavailable', () => {
    it('returns 503 Service Unavailable and logs error internally without leaking details to client', async () => {
      const logCapture = captureLogs();

      jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 127.0.0.1:5432 (simulated db crash)')
      );

      const res = await request(app)
        .get('/health/ready')
        .set('X-Request-ID', 'probe-unavail-test-1');

      logCapture.release();

      // Verify client response
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Service unavailable');

      // Must NOT leak error details, host, port, credentials, or stack trace
      expect(res.body.stack).toBeUndefined();
      expect(res.body.err).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(res.body)).not.toContain('127.0.0.1:5432');

      // Verify server log emitted at ERROR level with requestId
      const errorLog = logCapture.logs.find(
        (l) => l.requestId === 'probe-unavail-test-1' && l.level === 50
      );

      expect(errorLog).toBeDefined();
      expect(errorLog.msg).toBe('Readiness check failed: database unavailable');
      expect(errorLog.err.message).toContain('ECONNREFUSED');
    });
  });

  describe('4. Readiness (/health/ready) — Timeout Protection', () => {
    it('fails predictably with 503 within configured timeout when database hangs', async () => {
      process.env.HEALTH_CHECK_TIMEOUT_MS = '50';
      const logCapture = captureLogs();

      // Simulate a hung database query that never resolves in time
      jest.spyOn(prisma, '$queryRaw').mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      );

      const startTime = Date.now();
      const res = await request(app)
        .get('/health/ready')
        .set('X-Request-ID', 'probe-timeout-test-1');
      const elapsed = Date.now() - startTime;

      logCapture.release();

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Service unavailable');

      // Must fail quickly within timeout boundary (~50-200ms) rather than waiting 500ms
      expect(elapsed).toBeLessThan(350);

      // Verify server log emitted timeout failure
      const errorLog = logCapture.logs.find(
        (l) => l.requestId === 'probe-timeout-test-1' && l.level === 50
      );

      expect(errorLog).toBeDefined();
      expect(errorLog.err.message).toContain('timed out after 50ms');
    });
  });

  describe('5. Middleware Integration (Request IDs & Logging)', () => {
    it('propagates and generates Request IDs on health endpoints', async () => {
      // 1. Missing request ID generates UUID
      const res1 = await request(app).get('/health/live');
      expect(res1.headers['x-request-id']).toBeDefined();
      expect(res1.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      // 2. Supplied request ID is echoed
      const customId = 'k8s-liveness-probe-xyz';
      const res2 = await request(app)
        .get('/health/live')
        .set('X-Request-ID', customId);
      expect(res2.headers['x-request-id']).toBe(customId);
    });

    it('produces structured completed HTTP request log for health checks', async () => {
      const logCapture = captureLogs();

      await request(app)
        .get('/health/live')
        .set('X-Request-ID', 'probe-access-log-check');

      logCapture.release();

      const accessLog = logCapture.logs.find(
        (l) => l.requestId === 'probe-access-log-check' && l.msg === 'HTTP request completed'
      );

      expect(accessLog).toBeDefined();
      expect(accessLog.statusCode).toBe(200);
      expect(accessLog.path).toBe('/health/live');
      expect(accessLog.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('4b. HEALTH_CHECK_TIMEOUT_MS validation', () => {
    const { getTimeoutMs } = require('../src/modules/health/health.controller');

    it.each([
      [undefined, 3000],
      ['', 3000],
      ['abc', 3000],
      ['0', 3000],
      ['-5', 3000],
      ['1e3', 3000],
      ['3000ms', 3000],
      ['2500', 2500],
      ['99999999999', 30000],
    ])('HEALTH_CHECK_TIMEOUT_MS=%p resolves to %p', (raw, expected) => {
      if (raw === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
      else process.env.HEALTH_CHECK_TIMEOUT_MS = raw;
      expect(getTimeoutMs()).toBe(expected);
    });
  });

  describe('6. Backward-Compatible Legacy /health Endpoint', () => {
    it('continues returning 200 OK with timestamp on GET /health', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });
});
