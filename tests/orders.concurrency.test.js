const request = require('supertest');
const app = require('../src/app');
const { prisma, cleanDatabase } = require('./helpers');
const { generateAccessToken } = require('../src/utils/token');

describe('Orders & Inventory Concurrency & Invariants', () => {
  let user;
  let token;
  let category;

  beforeEach(async () => {
    await cleanDatabase();

    user = await prisma.user.create({
      data: {
        name: 'Order Tester',
        email: 'ordertest@shopscale.test',
        passwordHash: 'dummy-hash',
        role: 'USER',
      },
    });

    token = generateAccessToken({ sub: user.id, role: user.role });

    category = await prisma.category.create({
      data: { name: 'Test Category' },
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it('1. stock = 1, concurrent purchase attempts (prevents overselling)', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'Limited Item',
        price: 50.0,
        stock: 1, // Exactly 1 available
        categoryId: category.id,
      },
    });

    // 5 concurrent requests fired simultaneously via Promise.all
    const requests = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({
          items: [{ productId: product.id, quantity: 1 }],
        })
    );

    const responses = await Promise.all(requests);

    const successful = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 400);

    // Business Invariant: For stock = 1, exactly 1 order succeeds
    expect(successful.length).toBe(1);
    expect(rejected.length).toBe(4);

    // Verify database state
    const updatedProduct = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(updatedProduct.stock).toBe(0);

    const ordersInDb = await prisma.order.count();
    expect(ordersInDb).toBe(1);
  });

  it('2. stock = 2, concurrent purchase attempts', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'Two-Stock Item',
        price: 30.0,
        stock: 2, // Exactly 2 available
        categoryId: category.id,
      },
    });

    // 6 concurrent requests trying to buy 1 item each
    const requests = Array.from({ length: 6 }, () =>
      request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({
          items: [{ productId: product.id, quantity: 1 }],
        })
    );

    const responses = await Promise.all(requests);

    const successful = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 400);

    expect(successful.length).toBe(2);
    expect(rejected.length).toBe(4);

    const updatedProduct = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(updatedProduct.stock).toBe(0);

    const ordersInDb = await prisma.order.count();
    expect(ordersInDb).toBe(2);
  });

  it('3. stock = 0, purchase attempt is rejected', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'Out of Stock Item',
        price: 15.0,
        stock: 0,
        categoryId: category.id,
      },
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient stock/i);

    const ordersInDb = await prisma.order.count();
    expect(ordersInDb).toBe(0);
  });

  it('4. insufficient stock for requested quantity', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'Low Stock Item',
        price: 20.0,
        stock: 3,
        categoryId: category.id,
      },
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 5 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient stock/i);

    const updatedProduct = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(updatedProduct.stock).toBe(3); // Unchanged

    const ordersInDb = await prisma.order.count();
    expect(ordersInDb).toBe(0);
  });

  it('5. successful purchase decrements stock correctly', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'Abundant Item',
        price: 10.0,
        stock: 10,
        categoryId: category.id,
      },
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 4 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(Number(res.body.data.order.totalPrice)).toBe(40);

    const updatedProduct = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(updatedProduct.stock).toBe(6); // 10 - 4 = 6
  });

  it('6. failed purchase does not create an invalid or partial order', async () => {
    const availableProduct = await prisma.product.create({
      data: {
        name: 'In Stock Item',
        price: 10.0,
        stock: 5,
        categoryId: category.id,
      },
    });

    const outOfStockProduct = await prisma.product.create({
      data: {
        name: 'Zero Stock Item',
        price: 20.0,
        stock: 0,
        categoryId: category.id,
      },
    });

    // Multi-item order: one available, one out of stock
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { productId: availableProduct.id, quantity: 2 },
          { productId: outOfStockProduct.id, quantity: 1 },
        ],
      });

    expect(res.status).toBe(400);

    // Atomicity check: availableProduct stock was NOT decremented
    const refreshedAvailable = await prisma.product.findUnique({
      where: { id: availableProduct.id },
    });
    expect(refreshedAvailable.stock).toBe(5);

    // No orphan orders in DB
    const ordersInDb = await prisma.order.count();
    expect(ordersInDb).toBe(0);
  });
});
