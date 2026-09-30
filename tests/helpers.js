const prisma = require('../src/database/prisma');

/**
 * Deletes all data from all tables in the correct order (respects FK constraints).
 * Call in beforeEach() to isolate tests from each other.
 */
async function cleanDatabase() {
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
