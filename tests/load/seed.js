const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const prisma = require('../../src/database/prisma');

const BENCH_USER_EMAIL = 'benchmark@shopscale.test';
const BENCH_USER_PASSWORD = 'Password123!';
const BENCH_CATEGORY_NAME = 'Benchmark Category';
const BENCH_DATA_PATH = path.join(__dirname, 'bench-data.json');

async function resetBenchmarkData() {
  console.log('[seed] Cleaning existing benchmark data...');

  const user = await prisma.user.findUnique({
    where: { email: BENCH_USER_EMAIL },
  });

  if (user) {
    // Delete orders and tokens for this user
    await prisma.orderItem.deleteMany({
      where: { order: { userId: user.id } },
    });
    await prisma.order.deleteMany({
      where: { userId: user.id },
    });
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });
    await prisma.cartItem.deleteMany({
      where: { cart: { userId: user.id } },
    });
    await prisma.cart.deleteMany({
      where: { userId: user.id },
    });
    await prisma.user.delete({
      where: { id: user.id },
    });
  }

  const category = await prisma.category.findUnique({
    where: { name: BENCH_CATEGORY_NAME },
    include: { products: true },
  });

  if (category) {
    // Delete items referencing these products
    const productIds = category.products.map((p) => p.id);
    if (productIds.length > 0) {
      await prisma.orderItem.deleteMany({
        where: { productId: { in: productIds } },
      });
      await prisma.cartItem.deleteMany({
        where: { productId: { in: productIds } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: productIds } },
      });
    }
    await prisma.category.delete({
      where: { id: category.id },
    });
  }

  if (fs.existsSync(BENCH_DATA_PATH)) {
    fs.unlinkSync(BENCH_DATA_PATH);
  }

  console.log('[seed] Reset complete.');
}

async function seedBenchmarkData() {
  await resetBenchmarkData();

  console.log('[seed] Creating benchmark user...');
  const passwordHash = await bcrypt.hash(BENCH_USER_PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      name: 'Benchmark Tester',
      email: BENCH_USER_EMAIL,
      passwordHash,
      role: 'USER',
    },
  });

  console.log('[seed] Creating benchmark category...');
  const category = await prisma.category.create({
    data: { name: BENCH_CATEGORY_NAME },
  });

  console.log('[seed] Creating benchmark products...');
  // 1. Dedicated single-product target
  const targetProduct = await prisma.product.create({
    data: {
      name: 'Benchmark Target Single Product',
      description: 'Used for GET /api/products/:id load testing',
      price: 49.99,
      stock: 1000000,
      categoryId: category.id,
    },
  });

  // 2. Dedicated order creation target with large stock
  const orderProduct = await prisma.product.create({
    data: {
      name: 'Benchmark Checkout Product',
      description: 'Used for POST /api/orders load testing',
      price: 19.99,
      stock: 1000000,
      categoryId: category.id,
    },
  });

  // 3. Batch of 23 catalog items for paginated list testing
  const catalogProducts = [];
  for (let i = 1; i <= 23; i++) {
    catalogProducts.push({
      name: `Benchmark Catalog Item ${i}`,
      description: `Catalog item description for item ${i}`,
      price: (10 + i * 2.5).toFixed(2),
      stock: 5000,
      categoryId: category.id,
    });
  }

  await prisma.product.createMany({
    data: catalogProducts,
  });

  const metadata = {
    user: {
      id: user.id,
      email: BENCH_USER_EMAIL,
      password: BENCH_USER_PASSWORD,
    },
    category: {
      id: category.id,
      name: category.name,
    },
    targetProductId: targetProduct.id,
    orderProductId: orderProduct.id,
    seededAt: new Date().toISOString(),
  };

  fs.writeFileSync(BENCH_DATA_PATH, JSON.stringify(metadata, null, 2));
  console.log(`[seed] Benchmark data seeded and written to ${BENCH_DATA_PATH}`);
}

async function main() {
  const isResetOnly = process.argv.includes('--reset');
  if (isResetOnly) {
    await resetBenchmarkData();
  } else {
    await seedBenchmarkData();
  }
}

main()
  .catch((err) => {
    console.error('[seed] Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
