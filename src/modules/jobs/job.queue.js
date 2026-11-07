const { isShuttingDown } = require('../../utils/shutdown');

const DEFAULT_MAX_CAPACITY = 100;

class JobQueue {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxCapacity=100] - Maximum number of waiting jobs
   */
  constructor({ maxCapacity = DEFAULT_MAX_CAPACITY } = {}) {
    if (typeof maxCapacity !== 'number' || maxCapacity < 1) {
      throw new TypeError('maxCapacity must be a positive integer');
    }
    this.maxCapacity = maxCapacity;
    this._queue = [];
  }

  /**
   * Adds a job to the end of the queue.
   * Throws if the queue is full or the application is shutting down.
   *
   * @param {{ id: string, type: string, payload: *, attempt?: number }} job
   */
  enqueue(job) {
    if (!job || typeof job.id !== 'string' || typeof job.type !== 'string') {
      throw new Error('Job must have a string id and type');
    }

    if (isShuttingDown()) {
      throw new Error('Cannot enqueue jobs during shutdown');
    }

    if (this._queue.length >= this.maxCapacity) {
      throw new Error(
        `Queue is at capacity (${this.maxCapacity}). Cannot enqueue more jobs.`
      );
    }

    this._queue.push({
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempt: job.attempt || 1,
      enqueuedAt: Date.now(),
    });
  }

  /**
   * Removes and returns the next job from the front of the queue.
   * Returns null if the queue is empty.
   *
   * @returns {{ id: string, type: string, payload: *, attempt: number, enqueuedAt: number } | null}
   */
  reserve() {
    if (this._queue.length === 0) {
      return null;
    }
    return this._queue.shift();
  }

  /**
   * Returns the number of waiting jobs.
   * @returns {number}
   */
  size() {
    return this._queue.length;
  }

  /**
   * Returns true if the queue has reached its maximum capacity.
   * @returns {boolean}
   */
  isFull() {
    return this._queue.length >= this.maxCapacity;
  }

  /**
   * Removes all jobs from the queue.
   */
  clear() {
    this._queue = [];
  }
}

module.exports = JobQueue;
