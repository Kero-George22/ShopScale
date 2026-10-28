const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');
const CacheWithCoalescing = require('../../utils/CacheWithCoalescing');

const PRODUCT_LIST_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const PRODUCT_LIST_CACHE_MAX_ENTRIES = 200;

async function fetchProductListFromDb({ page, limit }) {
  const skip = (page - 1) * limit;

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      skip,
      take: limit,
      include: { category: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' }, // indexed via products_created_at_idx
    }),
    prisma.product.count(),
  ]);

  return { products, total, page, limit };
}

const productListCache = new CacheWithCoalescing({
  fetchFn: fetchProductListFromDb,
  ttlMs: PRODUCT_LIST_CACHE_TTL_MS,
  maxEntries: PRODUCT_LIST_CACHE_MAX_ENTRIES,
});

async function list({ page = 1, limit = 20 }) {
  const cacheKey = `products:list:page=${page}:limit=${limit}`;
  return productListCache.getOrFetch(cacheKey, { page, limit });
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

module.exports = { list, getById, productListCache };
