const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');

async function createOrder(userId, items) {
  // 1. Fetch all products involved in this order
  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
  });

  if (products.length !== productIds.length) {
    throw new ApiError(404, 'One or more products not found');
  }

  const productMap = new Map(products.map((p) => [p.id, p]));

  // 2. Validate stock availability and calculate prices
  let totalPrice = 0;
  const orderItemsData = [];

  for (const item of items) {
    const product = productMap.get(item.productId);

    if (product.stock < item.quantity) {
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

  // 3. Atomically decrement stock and persist order
  const order = await prisma.$transaction(async (tx) => {
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: {
          stock: {
            decrement: item.quantity,
          },
        },
      });
    }

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

  return order;
}

module.exports = { createOrder };
