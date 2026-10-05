const prisma = require('../src/database/prisma');
const { assertTestDatabase } = require('./test-db-guard');

/**
 * Deletes all data from all tables in the correct order (respects FK constraints).
 * Protected by assertTestDatabase() to prevent wiping non-test databases.
 * Call in beforeEach() to isolate tests from each other.
 */
async function cleanDatabase() {
  assertTestDatabase();

  await prisma.$transaction([
    prisma.idempotencyKey.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
  ]);
}

module.exports = { prisma, cleanDatabase };
