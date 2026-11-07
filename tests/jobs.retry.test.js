const RetryPolicy = require('../src/modules/jobs/job.retry');

describe('RetryPolicy', () => {
  describe('constructor', () => {
    it('uses default values', () => {
      const policy = new RetryPolicy();
      expect(policy.maxAttempts).toBe(3);
      expect(policy.baseDelayMs).toBe(1000);
      expect(policy.maxDelayMs).toBe(30000);
    });

    it('accepts custom values', () => {
      const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10000 });
      expect(policy.maxAttempts).toBe(5);
      expect(policy.baseDelayMs).toBe(500);
      expect(policy.maxDelayMs).toBe(10000);
    });

    it('throws on invalid maxAttempts', () => {
      expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow('positive integer');
      expect(() => new RetryPolicy({ maxAttempts: -1 })).toThrow('positive integer');
    });

    it('throws on invalid baseDelayMs', () => {
      expect(() => new RetryPolicy({ baseDelayMs: -1 })).toThrow('non-negative');
    });

    it('throws on invalid maxDelayMs', () => {
      expect(() => new RetryPolicy({ maxDelayMs: -1 })).toThrow('non-negative');
    });
  });

  describe('shouldRetry', () => {
    it('returns true when attempt is below maxAttempts', () => {
      const policy = new RetryPolicy({ maxAttempts: 3 });
      expect(policy.shouldRetry(1)).toBe(true);
      expect(policy.shouldRetry(2)).toBe(true);
    });

    it('returns false when attempt equals maxAttempts', () => {
      const policy = new RetryPolicy({ maxAttempts: 3 });
      expect(policy.shouldRetry(3)).toBe(false);
    });

    it('returns false when attempt exceeds maxAttempts', () => {
      const policy = new RetryPolicy({ maxAttempts: 3 });
      expect(policy.shouldRetry(4)).toBe(false);
    });
  });

  describe('getDelay', () => {
    it('increases delay exponentially', () => {
      const policy = new RetryPolicy({ baseDelayMs: 1000, maxDelayMs: 100000 });

      // Run multiple times and check the exponential base is correct
      // Delay = base * 2^(attempt-1) + jitter, where jitter ∈ [0, base)
      // Attempt 1: 1000 * 1 + jitter => [1000, 2000)
      // Attempt 2: 1000 * 2 + jitter => [2000, 3000)
      // Attempt 3: 1000 * 4 + jitter => [4000, 5000)

      const delays = [];
      for (let i = 0; i < 100; i++) {
        delays.push(policy.getDelay(1));
      }
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(1000);
      expect(Math.max(...delays)).toBeLessThan(2000);

      const delays2 = [];
      for (let i = 0; i < 100; i++) {
        delays2.push(policy.getDelay(2));
      }
      expect(Math.min(...delays2)).toBeGreaterThanOrEqual(2000);
      expect(Math.max(...delays2)).toBeLessThan(3000);
    });

    it('caps delay at maxDelayMs', () => {
      const policy = new RetryPolicy({ baseDelayMs: 1000, maxDelayMs: 5000 });

      // Attempt 10: base * 2^9 = 512000 >> 5000
      for (let i = 0; i < 50; i++) {
        expect(policy.getDelay(10)).toBeLessThanOrEqual(5000);
      }
    });

    it('includes jitter (delays for same attempt vary)', () => {
      const policy = new RetryPolicy({ baseDelayMs: 1000, maxDelayMs: 100000 });

      const delays = new Set();
      for (let i = 0; i < 50; i++) {
        delays.add(policy.getDelay(1));
      }
      // With jitter, we should get multiple different values
      expect(delays.size).toBeGreaterThan(1);
    });
  });
});
