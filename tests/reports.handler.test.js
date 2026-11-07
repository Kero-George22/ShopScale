const { prisma, cleanDatabase } = require('./helpers');
const { handleGenerateReport } = require('../src/modules/reports/report.handler');

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Helper: create a user
async function createTestUser() {
  return prisma.user.create({
    data: {
      name: 'Report Test User',
      email: `handler-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: '$2b$12$dummyhash.that.is.long.enough.for.bcrypt.format',
    },
  });
}

describe('Report Handler', () => {
  describe('handleGenerateReport', () => {
    it('generates a sales summary report', async () => {
      const user = await createTestUser();

      // Create some test data: a category, product, and order
      const category = await prisma.category.create({
        data: { name: `Test Category ${Date.now()}` },
      });
      const product = await prisma.product.create({
        data: {
          name: 'Test Product',
          price: 29.99,
          stock: 100,
          categoryId: category.id,
        },
      });
      await prisma.order.create({
        data: {
          userId: user.id,
          status: 'CONFIRMED',
          totalPrice: 59.98,
          items: {
            create: [
              { productId: product.id, quantity: 2, price: 29.99 },
            ],
          },
        },
      });

      // Create a report record
      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: user.id,
        },
      });

      // Run the handler
      const result = await handleGenerateReport({ reportId: report.id });
      expect(result.status).toBe('COMPLETED');

      // Verify the report was updated in the DB
      const updated = await prisma.report.findUnique({ where: { id: report.id } });
      expect(updated.status).toBe('COMPLETED');
      expect(updated.result).toBeDefined();
      expect(updated.result.totalOrders).toBe(1);
      expect(updated.result.totalRevenue).toBe(59.98);
      expect(updated.result.generatedAt).toBeDefined();
    });

    it('generates a sales summary with empty data', async () => {
      const user = await createTestUser();

      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: user.id,
        },
      });

      const result = await handleGenerateReport({ reportId: report.id });
      expect(result.status).toBe('COMPLETED');

      const updated = await prisma.report.findUnique({ where: { id: report.id } });
      expect(updated.result.totalOrders).toBe(0);
      expect(updated.result.totalRevenue).toBe(0);
    });

    it('is idempotent — skips already completed reports', async () => {
      const user = await createTestUser();

      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: user.id,
          status: 'COMPLETED',
          result: { totalOrders: 42 },
        },
      });

      const result = await handleGenerateReport({ reportId: report.id });
      expect(result.status).toBe('COMPLETED');

      // Result should not have changed
      const unchanged = await prisma.report.findUnique({ where: { id: report.id } });
      expect(unchanged.result.totalOrders).toBe(42);
    });

    it('transitions to PROCESSING then COMPLETED', async () => {
      const user = await createTestUser();

      const report = await prisma.report.create({
        data: {
          type: 'sales_summary',
          parameters: {},
          requestedById: user.id,
        },
      });

      expect(report.status).toBe('QUEUED');

      await handleGenerateReport({ reportId: report.id });

      const completed = await prisma.report.findUnique({ where: { id: report.id } });
      expect(completed.status).toBe('COMPLETED');
    });

    it('throws for non-existent report', async () => {
      await expect(
        handleGenerateReport({ reportId: 'non-existent-id' })
      ).rejects.toThrow('not found');
    });

    it('throws for missing reportId', async () => {
      await expect(
        handleGenerateReport({})
      ).rejects.toThrow('reportId is required');
    });

    it('marks report as FAILED and re-throws on unknown report type', async () => {
      const user = await createTestUser();

      // Manually insert a report with an unknown type
      const report = await prisma.report.create({
        data: {
          type: 'nonexistent_type',
          parameters: {},
          requestedById: user.id,
        },
      });

      await expect(
        handleGenerateReport({ reportId: report.id })
      ).rejects.toThrow('Unknown report type');

      const failed = await prisma.report.findUnique({ where: { id: report.id } });
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toMatch(/Unknown report type/);
    });
  });
});
