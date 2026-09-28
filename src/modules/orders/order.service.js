const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');




// Duplicate Items in Request (should be handled in the future)
async function createOrder(userId, items) {
  // Sort items deterministically by productId to ensure consistent lock acquisition
  // order across concurrent transactions and eliminate potential deadlocks.
  const sortedItems = [...items].sort((a, b) =>
    a.productId.localeCompare(b.productId)
  );
  const productIds = sortedItems.map((i) => i.productId);

  return await prisma.$transaction(async (tx) => {
    // 1. Fetch products inside transaction
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
    });

    if (products.length !== productIds.length) {
      throw new ApiError(404, 'One or more products not found');
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    let totalPrice = 0;
    const orderItemsData = [];

    // 2. Atomically decrement stock with conditional check
    for (const item of sortedItems) {
      const product = productMap.get(item.productId);

      // Fast in-memory pre-check
      if (product.stock < item.quantity) {
        throw new ApiError(400, `Insufficient stock for product: ${product.name}`);
      }

      // Atomic conditional UPDATE:
      // UPDATE "products" SET "stock" = "stock" - $qty WHERE "id" = $id AND "stock" >= $qty
      // If a concurrent transaction decremented stock first, row count will be 0.
      const updateResult = await tx.product.updateMany({
        where: {
          id: item.productId,
          stock: { gte: item.quantity },
        },
        data: {
          stock: {
            decrement: item.quantity,
          },
        },
      });

      if (updateResult.count === 0) {
        throw new ApiError(400, `Insufficient stock for product: ${product.name}`);
      }

      const itemPrice = Number(product.price);
      totalPrice += itemPrice * item.quantity;

      orderItemsData.push({
        productId: item.productId,
        quantity: item.quantity,
        price: product.price,
      });
    }

    // 3. Persist order and items atomically
    return tx.order.create({
      data: {
        userId,
        status: 'PENDING',
        totalPrice: totalPrice.toFixed(2),
        items: {
          create: orderItemsData,
        },
      },
      include: {
        items: true,
      },
    });
  });
}

module.exports = { createOrder };
