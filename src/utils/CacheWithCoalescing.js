/**
 * CacheWithCoalescing
 *
 * In-memory Cache-Aside implementation featuring:
 * 1. Time-to-Live (TTL) expiration per entry.
 * 2. Least Recently Used (LRU) capacity eviction via JavaScript Map insertion order.
 * 3. In-flight request coalescing (single-flight) to prevent cache stampedes
 *    on concurrent misses for the same key.
 */
class CacheWithCoalescing {
  /**
   * @param {Object} options
   * @param {Function} [options.fetchFn] - Default async fetch function (args) => Promise<result>
   * @param {number} [options.ttlMs=30000] - Time to live in milliseconds (default: 30s)
   * @param {number} [options.maxEntries=200] - Maximum cache entries before LRU eviction (default: 200)
   * @param {Function} [options.now=Date.now] - Clock function for deterministic testing
   */
  constructor({
    fetchFn,
    ttlMs = 30000,
    maxEntries = 200,
    now = Date.now,
  } = {}) {
    if (fetchFn !== undefined && typeof fetchFn !== 'function') {
      throw new TypeError('fetchFn must be a function if provided');
    }
    if (typeof ttlMs !== 'number' || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive number');
    }
    if (typeof maxEntries !== 'number' || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this.fetchFn = fetchFn;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;

    // JavaScript Map preserves insertion order.
    // Oldest/least recently accessed items are at the beginning;
    // most recently accessed items are re-inserted at the end.
    this.cache = new Map();

    // Map<key, Promise> tracking in-flight fetches to coalesce concurrent misses.
    this.inFlightRequests = new Map();
  }

  /**
   * Retrieves an item from cache if present and not expired.
   * On hit, refreshes LRU position. On expired, deletes and returns undefined.
   *
   * @param {string} key
   * @returns {*} Cached value or undefined
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    const currentTime = this.now();
    if (currentTime >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh LRU position by deleting and re-inserting at the end
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Stores an item with a fresh TTL and enforces LRU capacity.
   *
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs] - Optional override for TTL
   */
  set(key, value, ttlMs = this.ttlMs) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict least recently used (first key in insertion order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    });
  }

  /**
   * Retrieves a cached value or executes the fetch function to populate the cache.
   * Coalesces concurrent calls for the same key so only one fetch is executed.
   *
   * @param {string} key
   * @param {Function|*} [fetchFnOrArgs] - Either a fetch function override, or arguments for default fetchFn
   * @param {...*} [extraArgs] - Additional arguments if fetchFnOrArgs is a function
   * @returns {Promise<*>}
   */
  async getOrFetch(key, fetchFnOrArgs, ...extraArgs) {
    // 1. Fast path: check cache
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // 2. Coalescing: check if a fetch is already in flight for this key
    if (this.inFlightRequests.has(key)) {
      return await this.inFlightRequests.get(key);
    }

    // Resolve which fetch function and arguments to use
    let fn;
    let args;

    if (typeof fetchFnOrArgs === 'function') {
      fn = fetchFnOrArgs;
      args = extraArgs;
    } else if (typeof this.fetchFn === 'function') {
      fn = this.fetchFn;
      args = fetchFnOrArgs !== undefined ? [fetchFnOrArgs, ...extraArgs] : extraArgs;
    } else {
      throw new TypeError(`No fetchFn provided for key "${key}"`);
    }

    // 3. Initiate single-flight fetch
    const fetchPromise = (async () => {
      const result = await fn(...args);
      this.set(key, result);
      return result;
    })();

    this.inFlightRequests.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inFlightRequests.delete(key);
    }
  }

  /**
   * Deletes a specific key from the cache.
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clears all cache entries and in-flight tracking.
   */
  clear() {
    this.cache.clear();
    this.inFlightRequests.clear();
  }

  /**
   * Returns current count of cached entries.
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Returns current count of in-flight requests.
   * @returns {number}
   */
  get inFlightCount() {
    return this.inFlightRequests.size;
  }
}

module.exports = CacheWithCoalescing;
