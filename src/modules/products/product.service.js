const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');

async function list({ page = 1, limit = 20 }) {
  const skip = (page - 1) * limit;

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      skip,
      take: limit,
      include: { category: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.product.count(),
  ]);

  return { products, total, page, limit };
}

async function getById(id) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { category: { select: { id: true, name: true } } },
  });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  return product;
}

module.exports = { list, getById };
