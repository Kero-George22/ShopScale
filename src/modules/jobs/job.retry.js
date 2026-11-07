/**
 * RetryPolicy — Exponential backoff with jitter for job retries.
 *
 * delay = min(baseDelayMs * 2^(attempt-1) + jitter, maxDelayMs)
 *
 * Jitter is a random value between 0 and baseDelayMs to prevent
 * thundering-herd retries from concurrent failures.
 */
class RetryPolicy {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxAttempts=3] - Maximum total attempts (including first)
   * @param {number} [options.baseDelayMs=1000] - Base delay for exponential backoff
   * @param {number} [options.maxDelayMs=30000] - Maximum delay cap
   */
  constructor({ maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000 } = {}) {
    if (typeof maxAttempts !== 'number' || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer');
    }
    if (typeof baseDelayMs !== 'number' || baseDelayMs < 0) {
      throw new TypeError('baseDelayMs must be a non-negative number');
    }
    if (typeof maxDelayMs !== 'number' || maxDelayMs < 0) {
      throw new TypeError('maxDelayMs must be a non-negative number');
    }

    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  /**
   * Returns true if the job should be retried based on the current attempt number.
   * Attempt numbers are 1-based: attempt 1 is the first try.
   *
   * @param {number} attempt - Current attempt number (1-based)
   * @returns {boolean}
   */
  shouldRetry(attempt) {
    return attempt < this.maxAttempts;
  }

  /**
   * Calculates the delay before the next retry using exponential backoff with jitter.
   *
   * @param {number} attempt - Current attempt number (1-based)
   * @returns {number} Delay in milliseconds
   */
  getDelay(attempt) {
    // Exponential: baseDelay * 2^(attempt-1)
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1);

    // Jitter: random value between 0 and baseDelayMs
    const jitter = Math.random() * this.baseDelayMs;

    // Cap at maxDelayMs
    return Math.min(exponentialDelay + jitter, this.maxDelayMs);
  }
}

module.exports = RetryPolicy;
