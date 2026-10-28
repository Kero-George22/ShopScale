const CacheWithCoalescing = require('../src/utils/CacheWithCoalescing');
const productService = require('../src/modules/products/product.service');
const prisma = require('../src/database/prisma');
const { cleanDatabase } = require('./helpers');

describe('CacheWithCoalescing Unit Tests', () => {
  test('validates constructor arguments', () => {
    expect(() => new CacheWithCoalescing({ ttlMs: 0 })).toThrow(TypeError);
    expect(() => new CacheWithCoalescing({ ttlMs: -100 })).toThrow(TypeError);
    expect(() => new CacheWithCoalescing({ maxEntries: 0 })).toThrow(TypeError);
    expect(() => new CacheWithCoalescing({ maxEntries: -5 })).toThrow(TypeError);
    expect(() => new CacheWithCoalescing({ now: 'not a function' })).toThrow(TypeError);
    expect(() => new CacheWithCoalescing({ fetchFn: 'not a function' })).toThrow(TypeError);

    // Default construction is valid
    const defaultCache = new CacheWithCoalescing();
    expect(defaultCache.ttlMs).toBe(30000);
    expect(defaultCache.maxEntries).toBe(200);
    expect(defaultCache.size).toBe(0);
  });

  test('cache miss calls fetchFn and caches successful result', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ data: 'test-1' });
    const cache = new CacheWithCoalescing({ fetchFn });

    const result = await cache.getOrFetch('key-1');
    expect(result).toEqual({ data: 'test-1' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  test('cache hit returns stored value without calling fetchFn', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ data: 'test-1' });
    const cache = new CacheWithCoalescing({ fetchFn });

    const first = await cache.getOrFetch('key-1');
    const second = await cache.getOrFetch('key-1');

    expect(first).toEqual({ data: 'test-1' });
    expect(second).toEqual({ data: 'test-1' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('different keys fetch independently', async () => {
    const fetchFn = jest.fn((id) => Promise.resolve({ id }));
    const cache = new CacheWithCoalescing({ fetchFn });

    const resA = await cache.getOrFetch('k:1', 1);
    const resB = await cache.getOrFetch('k:2', 2);

    expect(resA).toEqual({ id: 1 });
    expect(resB).toEqual({ id: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  test('expired entry triggers a new fetch (TTL expiration using injectable clock)', async () => {
    let mockTime = 10000;
    const now = () => mockTime;

    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });

    const cache = new CacheWithCoalescing({
      fetchFn,
      ttlMs: 5000,
      now,
    });

    // Initial fetch at t = 10000
    const first = await cache.getOrFetch('key-1');
    expect(first).toEqual({ version: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Read at t = 14000 (4000ms elapsed, TTL is 5000ms -> still valid)
    mockTime = 14000;
    const second = await cache.getOrFetch('key-1');
    expect(second).toEqual({ version: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Read at t = 15000 (5000ms elapsed -> expired)
    mockTime = 15000;
    const third = await cache.getOrFetch('key-1');
    expect(third).toEqual({ version: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('LRU eviction removes least recently used entry when maxEntries is reached', async () => {
    const cache = new CacheWithCoalescing({ maxEntries: 3 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(3);

    // Adding 4th entry 'd' should evict 'a' (oldest inserted)
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  test('accessing an entry refreshes its LRU position (touch-on-read)', async () => {
    const cache = new CacheWithCoalescing({ maxEntries: 3 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Access 'a' so it becomes the most recently used
    expect(cache.get('a')).toBe(1);

    // Now adding 'd' should evict 'b' (least recently used, since 'a' was touched)
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  test('updating existing key does not increase size or evict other keys', () => {
    const cache = new CacheWithCoalescing({ maxEntries: 2 });

    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);

    // Update 'a'
    cache.set('a', 99);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(99);
    expect(cache.get('b')).toBe(2);
  });

  test('concurrent misses for the same key call fetchFn exactly once (single-flight coalescing)', async () => {
    let resolvePromise;
    const deferredPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const fetchFn = jest.fn(() => deferredPromise);
    const cache = new CacheWithCoalescing({ fetchFn });

    // Launch 5 concurrent requests for the same key
    const promise1 = cache.getOrFetch('hot-key');
    const promise2 = cache.getOrFetch('hot-key');
    const promise3 = cache.getOrFetch('hot-key');
    const promise4 = cache.getOrFetch('hot-key');
    const promise5 = cache.getOrFetch('hot-key');

    // While in flight, inFlightRequests map should have exactly 1 entry
    expect(cache.inFlightCount).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Resolve the single in-flight fetch
    resolvePromise({ payload: 'single-flight-success' });

    const results = await Promise.all([promise1, promise2, promise3, promise4, promise5]);

    // All callers get the identical result
    expect(results).toEqual([
      { payload: 'single-flight-success' },
      { payload: 'single-flight-success' },
      { payload: 'single-flight-success' },
      { payload: 'single-flight-success' },
      { payload: 'single-flight-success' },
    ]);

    // In-flight entry cleaned up after completion
    expect(cache.inFlightCount).toBe(0);
    // Cached for future hits
    expect(cache.size).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('concurrent misses for different keys remain independent', async () => {
    let resolveA;
    let resolveB;
    const promiseA = new Promise((resolve) => { resolveA = resolve; });
    const promiseB = new Promise((resolve) => { resolveB = resolve; });

    const fetchFn = jest.fn((key) => (key === 'key-A' ? promiseA : promiseB));
    const cache = new CacheWithCoalescing({ fetchFn });

    const reqA = cache.getOrFetch('key-A', 'key-A');
    const reqB = cache.getOrFetch('key-B', 'key-B');

    expect(cache.inFlightCount).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    resolveA('result-A');
    resolveB('result-B');

    const [resA, resB] = await Promise.all([reqA, reqB]);
    expect(resA).toBe('result-A');
    expect(resB).toBe('result-B');
    expect(cache.inFlightCount).toBe(0);
  });

  test('failed fetch is not cached and in-flight tracking is cleaned up', async () => {
    const error = new Error('Database connection failed');
    const fetchFn = jest.fn().mockRejectedValue(error);
    const cache = new CacheWithCoalescing({ fetchFn });

    await expect(cache.getOrFetch('error-key')).rejects.toThrow('Database connection failed');

    // In-flight tracking cleaned up
    expect(cache.inFlightCount).toBe(0);
    // Failure not cached
    expect(cache.size).toBe(0);
    expect(cache.get('error-key')).toBeUndefined();
  });

  test('after a failed fetch, subsequent request can retry and succeed', async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Transient failure'))
      .mockResolvedValueOnce({ status: 'recovered' });

    const cache = new CacheWithCoalescing({ fetchFn });

    await expect(cache.getOrFetch('retry-key')).rejects.toThrow('Transient failure');
    expect(cache.size).toBe(0);

    const retryResult = await cache.getOrFetch('retry-key');
    expect(retryResult).toEqual({ status: 'recovered' });
    expect(cache.size).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('all concurrent waiters receive the rejection on failed fetch', async () => {
    let rejectPromise;
    const deferredPromise = new Promise((_, reject) => {
      rejectPromise = reject;
    });

    const fetchFn = jest.fn(() => deferredPromise);
    const cache = new CacheWithCoalescing({ fetchFn });

    const p1 = cache.getOrFetch('fail-key');
    const p2 = cache.getOrFetch('fail-key');
    const p3 = cache.getOrFetch('fail-key');

    expect(cache.inFlightCount).toBe(1);

    const testError = new Error('Shared error');
    rejectPromise(testError);

    await expect(p1).rejects.toThrow('Shared error');
    await expect(p2).rejects.toThrow('Shared error');
    await expect(p3).rejects.toThrow('Shared error');

    expect(cache.inFlightCount).toBe(0);
    expect(cache.size).toBe(0);
  });

  test('empty valid results are cached (not treated as misses)', async () => {
    const emptyResult = { products: [], total: 0, page: 99, limit: 20 };
    const fetchFn = jest.fn().mockResolvedValue(emptyResult);
    const cache = new CacheWithCoalescing({ fetchFn });

    const first = await cache.getOrFetch('empty-page');
    const second = await cache.getOrFetch('empty-page');

    expect(first).toEqual(emptyResult);
    expect(second).toEqual(emptyResult);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  test('direct methods: delete, clear, and size work as expected', () => {
    const cache = new CacheWithCoalescing();

    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    expect(cache.size).toBe(2);

    expect(cache.delete('k1')).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBe('v2');

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('k2')).toBeUndefined();
  });
});

describe('Product Service Cache Integration Tests', () => {
  beforeEach(async () => {
    productService.productListCache.clear();
    await cleanDatabase();
  });

  afterAll(async () => {
    productService.productListCache.clear();
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('list() populates cache on initial miss and serves from cache on subsequent hit', async () => {
    // Seed one product
    const category = await prisma.category.create({
      data: { name: 'Cache Test Category' },
    });
    await prisma.product.create({
      data: {
        name: 'Cache Test Product',
        price: 29.99,
        stock: 10,
        categoryId: category.id,
      },
    });

    const cacheKey = 'products:list:page=1:limit=20';
    expect(productService.productListCache.get(cacheKey)).toBeUndefined();

    // 1st call: Miss, queries DB
    const res1 = await productService.list({ page: 1, limit: 20 });
    expect(res1.products).toHaveLength(1);
    expect(res1.total).toBe(1);
    expect(productService.productListCache.get(cacheKey)).toBeDefined();

    // Directly insert another product into the database bypassing service
    await prisma.product.create({
      data: {
        name: 'Sneaky Product Not in Cache',
        price: 99.99,
        stock: 5,
        categoryId: category.id,
      },
    });

    // 2nd call: Hit, returns cached data (still total: 1, products length: 1)
    const res2 = await productService.list({ page: 1, limit: 20 });
    expect(res2.products).toHaveLength(1);
    expect(res2.total).toBe(1);
    expect(res2.products[0].name).toBe('Cache Test Product');

    // After clearing cache, 3rd call queries DB and sees new product
    productService.productListCache.clear();
    const res3 = await productService.list({ page: 1, limit: 20 });
    expect(res3.products).toHaveLength(2);
    expect(res3.total).toBe(2);
  });

  test('different page and limit produce separate cache keys', async () => {
    const resP1L20 = await productService.list({ page: 1, limit: 20 });
    const resP2L20 = await productService.list({ page: 2, limit: 20 });
    const resP1L10 = await productService.list({ page: 1, limit: 10 });

    expect(productService.productListCache.get('products:list:page=1:limit=20')).toBeDefined();
    expect(productService.productListCache.get('products:list:page=2:limit=20')).toBeDefined();
    expect(productService.productListCache.get('products:list:page=1:limit=10')).toBeDefined();
    expect(productService.productListCache.size).toBe(3);
  });

  test('concurrent list() calls for same page and limit coalesce into single execution', async () => {
    const prismaSpy = jest.spyOn(prisma.product, 'findMany');

    const [r1, r2, r3] = await Promise.all([
      productService.list({ page: 1, limit: 20 }),
      productService.list({ page: 1, limit: 20 }),
      productService.list({ page: 1, limit: 20 }),
    ]);

    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    // Despite 3 concurrent calls, Prisma findMany was called only once
    expect(prismaSpy).toHaveBeenCalledTimes(1);

    prismaSpy.mockRestore();
  });

  test('getById() remains uncached and always queries database', async () => {
    const category = await prisma.category.create({
      data: { name: 'Direct Category' },
    });
    const product = await prisma.product.create({
      data: {
        name: 'Direct Product',
        price: 15.0,
        stock: 100,
        categoryId: category.id,
      },
    });

    const res1 = await productService.getById(product.id);
    expect(res1.stock).toBe(100);

    // Update stock directly in database
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: 50 },
    });

    // getById must immediately reflect the fresh stock
    const res2 = await productService.getById(product.id);
    expect(res2.stock).toBe(50);
  });
});
