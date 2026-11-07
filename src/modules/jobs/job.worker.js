const { isShuttingDown } = require('../../utils/shutdown');

/**
 * JobWorker — Serial job processor.
 *
 * Polls the queue for jobs, executes handlers via the registry,
 * and manages retry scheduling through the retry policy.
 *
 * Concurrency: 1 (processes one job at a time).
 * Lifecycle: start() → stop() → drain(deadline).
 */
class JobWorker {
  /**
   * @param {Object} options
   * @param {import('./job.queue')} options.queue - Job queue to poll
   * @param {import('./job.registry')} options.registry - Handler registry
   * @param {import('./job.retry')} options.retryPolicy - Retry policy
   * @param {Object} options.logger - Pino logger instance
   * @param {number} [options.pollIntervalMs=1000] - Polling interval in ms
   * @param {Function} [options.onJobComplete] - Optional callback(job, result) after success
   * @param {Function} [options.onJobFailed] - Optional callback(job, error, willRetry) after failure
   */
  constructor({ queue, registry, retryPolicy, logger, pollIntervalMs = 1000, onJobComplete, onJobFailed }) {
    if (!queue) throw new Error('queue is required');
    if (!registry) throw new Error('registry is required');
    if (!retryPolicy) throw new Error('retryPolicy is required');
    if (!logger) throw new Error('logger is required');

    this.queue = queue;
    this.registry = registry;
    this.retryPolicy = retryPolicy;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.onJobComplete = onJobComplete || null;
    this.onJobFailed = onJobFailed || null;

    this._running = false;
    this._stopped = false;
    this._pollTimer = null;
    this._currentJob = null;
    this._currentJobPromise = null;
    this._drainResolvers = [];
  }

  /**
   * Starts the worker poll loop.
   * Does nothing if already running.
   */
  start() {
    if (this._running) return;

    this._running = true;
    this._stopped = false;
    this.logger.info({ event: 'worker.started', pollIntervalMs: this.pollIntervalMs }, 'Job worker started');
    this._schedulePoll();
  }

  /**
   * Signals the worker to stop after the current poll cycle.
   * Does not interrupt a running job.
   */
  stop() {
    if (this._stopped) return;

    this._stopped = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }

    this.logger.info({ event: 'worker.stopping' }, 'Job worker stopping');

    // If no job is running, resolve drain immediately
    if (!this._currentJobPromise) {
      this._running = false;
      this._resolveDrains();
      this.logger.info({ event: 'worker.stopped' }, 'Job worker stopped (idle)');
    }
  }

  /**
   * Returns a promise that resolves when the currently running job finishes
   * or the deadline is reached, whichever comes first.
   *
   * @param {number} deadlineMs - Maximum time to wait
   * @returns {Promise<void>}
   */
  drain(deadlineMs) {
    // If no job is running, resolve immediately
    if (!this._currentJobPromise) {
      this._running = false;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      // Resolve when the current job finishes
      this._drainResolvers.push(resolve);

      // Or resolve when the deadline passes
      const timer = setTimeout(() => {
        this.logger.warn(
          { event: 'worker.drain_timeout', deadlineMs },
          `Worker drain deadline reached after ${deadlineMs}ms; abandoning current job`
        );
        this._running = false;
        resolve();
      }, deadlineMs);

      // Don't let the timer keep the process alive
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  /**
   * Returns true if the worker is currently running.
   * @returns {boolean}
   */
  isRunning() {
    return this._running;
  }

  /**
   * Returns the job currently being processed, or null.
   * @returns {{ id: string, type: string, payload: *, attempt: number } | null}
   */
  getCurrentJob() {
    return this._currentJob;
  }

  /** @private */
  _schedulePoll() {
    if (this._stopped) return;

    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this._poll();
    }, this.pollIntervalMs);

    // Don't let the timer keep the process alive during shutdown
    if (typeof this._pollTimer.unref === 'function') {
      this._pollTimer.unref();
    }
  }

  /** @private */
  async _poll() {
    if (this._stopped || isShuttingDown()) {
      this._running = false;
      this._resolveDrains();
      this.logger.info({ event: 'worker.stopped', reason: 'shutdown_or_stopped' }, 'Job worker stopped');
      return;
    }

    const job = this.queue.reserve();

    if (!job) {
      // No job available — schedule next poll
      this._schedulePoll();
      return;
    }

    // Process the job
    this._currentJob = job;
    this._currentJobPromise = this._processJob(job);

    try {
      await this._currentJobPromise;
    } finally {
      this._currentJob = null;
      this._currentJobPromise = null;
    }

    // If stopped while processing, resolve drains and exit
    if (this._stopped || isShuttingDown()) {
      this._running = false;
      this._resolveDrains();
      this.logger.info({ event: 'worker.stopped', reason: 'shutdown_after_job' }, 'Job worker stopped after completing job');
      return;
    }

    // Schedule next poll
    this._schedulePoll();
  }

  /** @private */
  async _processJob(job) {
    const startTime = process.hrtime.bigint();

    this.logger.info(
      { event: 'job.started', jobId: job.id, jobType: job.type, attempt: job.attempt },
      `Processing job ${job.id} (type: ${job.type}, attempt: ${job.attempt})`
    );

    try {
      const handler = this.registry.getHandler(job.type);
      const result = await handler(job.payload);

      const durationMs = Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;

      this.logger.info(
        { event: 'job.completed', jobId: job.id, jobType: job.type, attempt: job.attempt, durationMs },
        `Job ${job.id} completed successfully in ${durationMs}ms`
      );

      if (this.onJobComplete) {
        try {
          await this.onJobComplete(job, result);
        } catch (callbackErr) {
          this.logger.error(
            { event: 'job.callback_error', jobId: job.id, err: callbackErr },
            'Error in onJobComplete callback'
          );
        }
      }
    } catch (err) {
      const durationMs = Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;
      const willRetry = this.retryPolicy.shouldRetry(job.attempt);

      this.logger.error(
        {
          event: 'job.failed',
          jobId: job.id,
          jobType: job.type,
          attempt: job.attempt,
          durationMs,
          willRetry,
          error: err.message,
        },
        `Job ${job.id} failed on attempt ${job.attempt}: ${err.message}`
      );

      if (this.onJobFailed) {
        try {
          await this.onJobFailed(job, err, willRetry);
        } catch (callbackErr) {
          this.logger.error(
            { event: 'job.callback_error', jobId: job.id, err: callbackErr },
            'Error in onJobFailed callback'
          );
        }
      }

      if (willRetry && !this._stopped && !isShuttingDown()) {
        const delay = this.retryPolicy.getDelay(job.attempt);
        this.logger.info(
          { event: 'job.retry_scheduled', jobId: job.id, attempt: job.attempt + 1, delayMs: delay },
          `Scheduling retry for job ${job.id} in ${delay}ms (attempt ${job.attempt + 1})`
        );

        const retryTimer = setTimeout(() => {
          try {
            this.queue.enqueue({
              id: job.id,
              type: job.type,
              payload: job.payload,
              attempt: job.attempt + 1,
            });
          } catch (enqueueErr) {
            this.logger.warn(
              { event: 'job.retry_enqueue_failed', jobId: job.id, error: enqueueErr.message },
              `Failed to re-enqueue job ${job.id} for retry: ${enqueueErr.message}`
            );
          }
        }, delay);

        // Don't let retry timers keep the process alive
        if (typeof retryTimer.unref === 'function') {
          retryTimer.unref();
        }
      }
    }
  }

  /** @private */
  _resolveDrains() {
    const resolvers = this._drainResolvers;
    this._drainResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

module.exports = JobWorker;
