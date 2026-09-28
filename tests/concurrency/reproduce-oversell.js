const { performance } = require('perf_hooks');
const prisma = require('../../src/database/prisma');
const { generateAccessToken } = require('../../src/utils/token');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function calculatePercentile(values, percentile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runScenario(concurrency) {
  // 1. Setup isolated test user and product
  const category = await prisma.category.upsert({
    where: { name: 'Concurrency Test Category' },
    update: {},
    create: { name: 'Concurrency Test Category' },
  });

  const testUser = await prisma.user.upsert({
    where: { email: 'concurrency-tester@shopscale.test' },
    update: {},
    create: {
      name: 'Concurrency Tester',
      email: 'concurrency-tester@shopscale.test',
      passwordHash: 'dummy-hash',
      role: 'USER',
    },
  });

  const token = generateAccessToken({ sub: testUser.id, role: testUser.role });

  const product = await prisma.product.create({
    data: {
      name: `Concurrency Product (C=${concurrency})`,
      description: 'Product with stock=1 for race condition testing',
      price: 25.0,
      stock: 1, // EXACTLY 1 IN STOCK
      categoryId: category.id,
    },
  });

  // 2. Fire concurrent checkout requests
  const overallStart = performance.now();

  const requests = Array.from({ length: concurrency }, async (_, i) => {
    const reqStart = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          items: [{ productId: product.id, quantity: 1 }],
        }),
      });
      const reqEnd = performance.now();
      const body = await res.json().catch(() => ({}));
      return {
        id: i + 1,
        status: res.status,
        body,
        duration: reqEnd - reqStart,
      };
    } catch (err) {
      const reqEnd = performance.now();
      return {
        id: i + 1,
        status: 0,
        error: err.message,
        duration: reqEnd - reqStart,
      };
    }
  });

  const responses = await Promise.all(requests);
  const overallEnd = performance.now();
  const totalDurationSeconds = (overallEnd - overallStart) / 1000;

  // 3. Inspect final database state
  const updatedProduct = await prisma.product.findUnique({
    where: { id: product.id },
  });

  const orderItemsCount = await prisma.orderItem.count({
    where: { productId: product.id },
  });

  // 4. Compute metrics
  const successful = responses.filter((r) => r.status === 201).length;
  const rejected = responses.filter((r) => r.status === 400).length;
  const otherErrors = responses.filter((r) => r.status !== 201 && r.status !== 400).length;
  const finalStock = updatedProduct ? updatedProduct.stock : null;
  const oversoldAmount = Math.max(0, successful - 1);

  const durations = responses.map((r) => r.duration);
  const avgLatency = durations.reduce((a, b) => a + b, 0) / durations.length;
  const p95Latency = calculatePercentile(durations, 95);
  const p99Latency = calculatePercentile(durations, 99);
  const rps = (concurrency / totalDurationSeconds).toFixed(1);

  // 5. Cleanup orders created for this test product to keep DB clean
  await prisma.orderItem.deleteMany({ where: { productId: product.id } });
  await prisma.order.deleteMany({ where: { userId: testUser.id } });
  await prisma.product.delete({ where: { id: product.id } });

  return {
    concurrency,
    totalRequests: concurrency,
    successful,
    rejected,
    otherErrors,
    finalStock,
    oversoldAmount,
    orderItemsInDB: orderItemsCount,
    avgLatency: avgLatency.toFixed(2),
    p95Latency: p95Latency.toFixed(2),
    p99Latency: p99Latency.toFixed(2),
    rps,
  };
}

async function main() {
  console.log('='.repeat(80));
  console.log('ShopScale V2 Concurrency Lab — Experiment 1: Reproduce Overselling');
  console.log('Target: 1 product with stock = 1 under concurrent checkouts');
  console.log('='.repeat(80));

  const concurrencyLevels = [2, 5, 10, 25, 50, 100];
  const results = [];

  for (const c of concurrencyLevels) {
    process.stdout.write(`Testing concurrency = ${c}... `);
    const result = await runScenario(c);
    results.push(result);
    console.log(
      `Done. Success: ${result.successful}, Rejected: ${result.rejected}, Final Stock: ${result.finalStock}, Oversold: ${result.oversoldAmount}`
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('Summary Table:');
  console.log('='.repeat(80));
  console.table(
    results.map((r) => ({
      'VUs (Concurrency)': r.concurrency,
      'Total Reqs': r.totalRequests,
      'Successful (201)': r.successful,
      'Rejected (400)': r.rejected,
      'Final Stock': r.finalStock,
      'Oversold Qty': r.oversoldAmount,
      'Avg Latency (ms)': r.avgLatency,
      'p95 (ms)': r.p95Latency,
      'p99 (ms)': r.p99Latency,
      RPS: r.rps,
    }))
  );

  console.log('='.repeat(80));
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
