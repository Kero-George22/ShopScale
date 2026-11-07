const prisma = require('../../database/prisma');
const { logger } = require('../../utils/logger');

/**
 * Report handler — generates the actual report data.
 * Registered with JobRegistry as type 'generate_report'.
 *
 * This handler is idempotent: if the report is already COMPLETED,
 * it returns immediately without recomputing.
 *
 * @param {{ reportId: string }} payload
 * @returns {Promise<{ reportId: string, status: string }>}
 */
async function handleGenerateReport({ reportId }) {
  if (!reportId) {
    throw new Error('reportId is required in job payload');
  }

  const log = logger.child({ reportId, handler: 'generate_report' });

  // Load the report from DB
  const report = await prisma.report.findUnique({
    where: { id: reportId },
  });

  if (!report) {
    throw new Error(`Report ${reportId} not found in database`);
  }

  // Idempotency guard: if already completed, skip
  if (report.status === 'COMPLETED') {
    log.info({ event: 'report.already_completed' }, 'Report already completed; skipping');
    return { reportId, status: 'COMPLETED' };
  }

  // Transition to PROCESSING
  await prisma.report.update({
    where: { id: reportId },
    data: { status: 'PROCESSING' },
  });

  try {
    let result;

    switch (report.type) {
      case 'sales_summary':
        result = await generateSalesSummary(report.parameters);
        break;
      default:
        throw new Error(`Unknown report type: ${report.type}`);
    }

    // Write the result back to the database
    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'COMPLETED',
        result,
      },
    });

    log.info({ event: 'report.completed' }, 'Report generation completed successfully');
    return { reportId, status: 'COMPLETED' };
  } catch (err) {
    // Update the report with the error — the worker's retry logic
    // will handle re-enqueuing if appropriate.
    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'FAILED',
        error: err.message,
        attempts: { increment: 1 },
      },
    });

    throw err; // Re-throw so the worker can apply retry policy
  }
}

/**
 * Generates a sales summary report.
 *
 * Aggregates order data: total orders, total revenue, orders by status,
 * and top products by quantity sold.
 *
 * @param {object} _parameters - Report parameters (currently unused for MVP)
 * @returns {Promise<object>} Report result data
 */
async function generateSalesSummary(_parameters) {
  // Count total orders
  const totalOrders = await prisma.order.count();

  // Sum total revenue from all orders
  const revenueResult = await prisma.order.aggregate({
    _sum: { totalPrice: true },
  });
  const totalRevenue = revenueResult._sum.totalPrice
    ? Number(revenueResult._sum.totalPrice)
    : 0;

  // Count orders by status
  const ordersByStatus = await prisma.order.groupBy({
    by: ['status'],
    _count: { id: true },
  });

  const statusCounts = {};
  for (const group of ordersByStatus) {
    statusCounts[group.status] = group._count.id;
  }

  // Top 10 products by total quantity sold
  const topProducts = await prisma.orderItem.groupBy({
    by: ['productId'],
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: 10,
  });

  // Fetch product names for top products
  const productIds = topProducts.map((p) => p.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p.name]));

  const topProductsList = topProducts.map((p) => ({
    productId: p.productId,
    productName: productMap.get(p.productId) || 'Unknown',
    totalQuantitySold: p._sum.quantity,
  }));

  return {
    generatedAt: new Date().toISOString(),
    totalOrders,
    totalRevenue,
    ordersByStatus: statusCounts,
    topProducts: topProductsList,
  };
}

module.exports = { handleGenerateReport };
