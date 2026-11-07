const request = require('supertest');
const app = require('../src/app');
const { prisma, cleanDatabase } = require('./helpers');
const reportService = require('../src/modules/reports/report.service');
const JobQueue = require('../src/modules/jobs/job.queue');
const { generateAccessToken } = require('../src/utils/token');
const { resetShutdownState } = require('../src/utils/shutdown');

// Create and inject a test queue
let testQueue;

beforeAll(() => {
  testQueue = new JobQueue({ maxCapacity: 100 });
  reportService.setQueue(testQueue);
});

beforeEach(async () => {
  resetShutdownState();
  testQueue.clear();
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Helper: create a user and return token + userId
async function createTestUser(role = 'USER') {
  const user = await prisma.user.create({
    data: {
      name: 'Test User',
      email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: '$2b$12$dummyhash.that.is.long.enough.for.bcrypt.format',
      role,
    },
  });
  const token = generateAccessToken({ sub: user.id, role: user.role });
  return { userId: user.id, token, role: user.role };
}

describe('Reports API', () => {
  describe('POST /api/reports', () => {
    it('creates a report and enqueues a job', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'sales_summary' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.report).toMatchObject({
        type: 'sales_summary',
        status: 'QUEUED',
      });
      expect(res.body.data.report.id).toBeDefined();

      // Job should be enqueued
      expect(testQueue.size()).toBe(1);
    });

    it('creates a report with custom parameters', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'sales_summary', parameters: { startDate: '2026-01-01' } });

      expect(res.status).toBe(201);
      expect(res.body.data.report.type).toBe('sales_summary');
    });

    it('rejects invalid report type', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'invalid_type' });

      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/reports')
        .send({ type: 'sales_summary' });

      expect(res.status).toBe(401);
    });

    it('returns 503 when queue is full', async () => {
      const { token } = await createTestUser();

      // Fill the queue
      const smallQueue = new JobQueue({ maxCapacity: 2 });
      reportService.setQueue(smallQueue);
      smallQueue.enqueue({ id: '1', type: 'x', payload: {} });
      smallQueue.enqueue({ id: '2', type: 'x', payload: {} });

      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'sales_summary' });

      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/capacity/i);

      // Restore test queue
      reportService.setQueue(testQueue);
    });
  });

  describe('GET /api/reports/:id', () => {
    it('returns a report by ID', async () => {
      const { userId, token } = await createTestUser();

      // Create a report directly in DB
      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: userId,
          status: 'COMPLETED',
          result: { totalOrders: 5 },
        },
      });

      const res = await request(app)
        .get(`/api/reports/${report.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.report.id).toBe(report.id);
      expect(res.body.data.report.status).toBe('COMPLETED');
      expect(res.body.data.report.result).toEqual({ totalOrders: 5 });
    });

    it('returns 404 for non-existent report', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .get('/api/reports/non-existent-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('enforces ownership — user cannot see another user\'s report', async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();

      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: userA.userId,
        },
      });

      const res = await request(app)
        .get(`/api/reports/${report.id}`)
        .set('Authorization', `Bearer ${userB.token}`);

      expect(res.status).toBe(404);
    });

    it('allows admin to see any user\'s report', async () => {
      const user = await createTestUser('USER');
      const admin = await createTestUser('ADMIN');

      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: user.userId,
        },
      });

      const res = await request(app)
        .get(`/api/reports/${report.id}`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.report.id).toBe(report.id);
    });
  });

  describe('GET /api/reports', () => {
    it('returns paginated list of user\'s reports', async () => {
      const { userId, token } = await createTestUser();

      // Create 3 reports
      for (let i = 0; i < 3; i++) {
        await prisma.report.create({
          data: {
            type: 'sales_summary',
            parameters: {},
            requestedById: userId,
          },
        });
      }

      const res = await request(app)
        .get('/api/reports')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(3);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(1);
    });

    it('does not return other user\'s reports for non-admin', async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();

      await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: userA.userId,
        },
      });

      const res = await request(app)
        .get('/api/reports')
        .set('Authorization', `Bearer ${userB.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(0);
      expect(res.body.data.total).toBe(0);
    });

    it('admin sees all reports', async () => {
      const user = await createTestUser('USER');
      const admin = await createTestUser('ADMIN');

      await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: user.userId,
        },
      });

      const res = await request(app)
        .get('/api/reports')
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(1);
    });

    it('respects pagination limits', async () => {
      const { userId, token } = await createTestUser();

      for (let i = 0; i < 5; i++) {
        await prisma.report.create({
          data: {
            type: 'sales_summary',
            parameters: {},
            requestedById: userId,
          },
        });
      }

      const res = await request(app)
        .get('/api/reports?page=1&limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(2);
      expect(res.body.data.total).toBe(5);
    });
  });
});
