const http = require('http');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/database/prisma');
const { captureLogs, logger } = require('../src/utils/logger');
const {
  isShuttingDown,
  setShuttingDown,
  resetShutdownState,
  getShutdownTimeoutMs,
  createShutdownCoordinator,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
} = require('../src/utils/shutdown');

describe('V4.2B — Graceful Shutdown & Lifecycle Management', () => {
  afterEach(() => {
    resetShutdownState();
    delete process.env.SHUTDOWN_TIMEOUT_MS;
    jest.restoreAllMocks();
  });

  describe('1. Configuration Validation (SHUTDOWN_TIMEOUT_MS)', () => {
    it.each([
      [undefined, DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['', DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['abc', DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['0', DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['-5', DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['1e4', DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['10s', DEFAULT_SHUTDOWN_TIMEOUT_MS],
      ['5000', 5000],
      ['15000', 15000],
      ['99999999999', MAX_SHUTDOWN_TIMEOUT_MS],
    ])('SHUTDOWN_TIMEOUT_MS=%p resolves to %p', (raw, expected) => {
      if (raw === undefined) {
        delete process.env.SHUTDOWN_TIMEOUT_MS;
      } else {
        process.env.SHUTDOWN_TIMEOUT_MS = raw;
      }
      expect(getShutdownTimeoutMs()).toBe(expected);
    });
  });

  describe('2. Readiness and Liveness Behavior During Shutdown', () => {
    it('Gate 1: GET /health/ready immediately returns 503 during shutdown without querying Prisma', async () => {
      setShuttingDown();
      const querySpy = jest.spyOn(prisma, '$queryRaw');

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Service unavailable',
      });
      // Verification: database query must NOT be invoked when already shutting down
      expect(querySpy).not.toHaveBeenCalled();
    });

    it('Gate 2: GET /health/ready returns 503 if shutdown begins while database check is in-flight', async () => {
      // Simulate database query running, but shutdown starting while it was in-flight
      jest.spyOn(prisma, '$queryRaw').mockImplementationOnce(async () => {
        setShuttingDown();
        return [{ '?column?': 1 }];
      });

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Service unavailable',
      });
    });

    it('GET /health/live remains 200 OK during shutdown', async () => {
      setShuttingDown();

      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('3. Shutdown Coordinator Lifecycle & Drain Semantics', () => {
    it('Normal drain: in-flight request finishes before Prisma disconnects and exits 0', async () => {
      const exitMock = jest.fn();
      let disconnectCalled = false;
      let requestFinished = false;

      const mockPrisma = {
        $disconnect: jest.fn().mockImplementation(async () => {
          disconnectCalled = true;
          // Verify that the in-flight request finished BEFORE disconnect was called
          expect(requestFinished).toBe(true);
        }),
      };

      // Create an ephemeral HTTP server
      const testServer = http.createServer((req, res) => {
        if (req.url === '/delayed-work') {
          setTimeout(() => {
            requestFinished = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ done: true }));
          }, 40);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve) => testServer.listen(0, resolve));
      const port = testServer.address().port;

      const logCapture = captureLogs();

      const shutdown = createShutdownCoordinator({
        server: testServer,
        prisma: mockPrisma,
        logger,
        timeoutMs: 1000,
        exit: exitMock,
      });

      // Launch an in-flight HTTP request
      const requestPromise = new Promise((resolve, reject) => {
        http
          .get(`http://localhost:${port}/delayed-work`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
          })
          .on('error', reject);
      });

      // Small delay to ensure request is received and in-flight, then initiate shutdown
      await new Promise((r) => setTimeout(r, 10));
      const shutdownPromise = shutdown('SIGTERM');

      const [res] = await Promise.all([requestPromise, shutdownPromise]);

      logCapture.release();

      expect(res.status).toBe(200);
      expect(res.body.done).toBe(true);
      expect(disconnectCalled).toBe(true);
      expect(exitMock).toHaveBeenCalledWith(0);

      // Verify lifecycle logs
      const events = logCapture.logs.map((l) => l.event).filter(Boolean);
      expect(events).toContain('shutdown.initiated');
      expect(events).toContain('shutdown.http_drained');
      expect(events).toContain('shutdown.prisma_disconnected');
      expect(events).toContain('shutdown.completed');
    });

    it('Drain timeout: forces connection close when in-flight request exceeds deadline and exits 1', async () => {
      const exitMock = jest.fn();

      const mockPrisma = {
        $disconnect: jest.fn().mockResolvedValue(),
      };

      // Create an ephemeral server with a request that hangs indefinitely
      const testServer = http.createServer((req, res) => {
        // Deliberately never calls res.end()
      });

      await new Promise((resolve) => testServer.listen(0, resolve));
      const port = testServer.address().port;

      const logCapture = captureLogs();

      const shutdown = createShutdownCoordinator({
        server: testServer,
        prisma: mockPrisma,
        logger,
        timeoutMs: 50, // Short deadline for testing
        exit: exitMock,
      });

      // Initiate in-flight request that will be aborted by timeout
      const clientReq = http.get(`http://localhost:${port}/hang`);
      clientReq.on('error', () => {}); // Catch expected socket hang up

      await new Promise((r) => setTimeout(r, 10));
      await shutdown('SIGINT');

      logCapture.release();

      expect(exitMock).toHaveBeenCalledWith(1);
      expect(mockPrisma.$disconnect).toHaveBeenCalled();

      const events = logCapture.logs.map((l) => l.event).filter(Boolean);
      expect(events).toContain('shutdown.initiated');
      expect(events).toContain('shutdown.drain_timeout');
      expect(events).toContain('shutdown.completed');
    });

    it('Prisma disconnect rejection: marks exitCode 1 and logs failure', async () => {
      const exitMock = jest.fn();

      const mockPrisma = {
        $disconnect: jest.fn().mockRejectedValueOnce(new Error('Connection pool destruction failed')),
      };

      const testServer = http.createServer((req, res) => res.end());
      await new Promise((resolve) => testServer.listen(0, resolve));

      const logCapture = captureLogs();

      const shutdown = createShutdownCoordinator({
        server: testServer,
        prisma: mockPrisma,
        logger,
        timeoutMs: 500,
        exit: exitMock,
      });

      await shutdown('SIGTERM');

      logCapture.release();

      expect(exitMock).toHaveBeenCalledWith(1);

      const failLog = logCapture.logs.find(
        (l) => l.event === 'shutdown.prisma_disconnect_failed'
      );
      expect(failLog).toBeDefined();
      expect(failLog.err.message).toContain('Connection pool destruction failed');
    });

    it('Prisma disconnect timeout: marks exitCode 1 and logs timeout', async () => {
      const exitMock = jest.fn();

      // Simulate a hung prisma.$disconnect that never resolves
      const mockPrisma = {
        $disconnect: jest.fn().mockImplementationOnce(() => new Promise(() => {})),
      };

      const testServer = http.createServer((req, res) => res.end());
      await new Promise((resolve) => testServer.listen(0, resolve));

      const logCapture = captureLogs();

      const shutdown = createShutdownCoordinator({
        server: testServer,
        prisma: mockPrisma,
        logger,
        timeoutMs: 40, // Disconnect timeout will be min(40, 5000) = 40ms
        exit: exitMock,
      });

      await shutdown('SIGTERM');

      logCapture.release();

      expect(exitMock).toHaveBeenCalledWith(1);

      const timeoutLog = logCapture.logs.find(
        (l) => l.event === 'shutdown.prisma_disconnect_timeout'
      );
      expect(timeoutLog).toBeDefined();
      expect(timeoutLog.timeoutMs).toBe(40);
    });

    it('Duplicate signals: suppresses redundant cleanup and returns existing promise', async () => {
      const exitMock = jest.fn();

      const mockPrisma = {
        $disconnect: jest.fn().mockResolvedValue(),
      };

      const testServer = http.createServer((req, res) => res.end());
      await new Promise((resolve) => testServer.listen(0, resolve));

      const logCapture = captureLogs();

      const shutdown = createShutdownCoordinator({
        server: testServer,
        prisma: mockPrisma,
        logger,
        timeoutMs: 500,
        exit: exitMock,
      });

      const p1 = shutdown('SIGTERM');
      const p2 = shutdown('SIGINT'); // Duplicate signal

      expect(p1).toBe(p2); // Exactly same promise returned

      await Promise.all([p1, p2]);

      logCapture.release();

      expect(exitMock).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);

      const ignoredLog = logCapture.logs.find(
        (l) => l.event === 'shutdown.signal_ignored'
      );
      expect(ignoredLog).toBeDefined();
      expect(ignoredLog.signal).toBe('SIGINT');
    });
  });
});
