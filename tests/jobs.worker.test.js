const JobQueue = require('../src/modules/jobs/job.queue');
const JobRegistry = require('../src/modules/jobs/job.registry');
const JobWorker = require('../src/modules/jobs/job.worker');
const RetryPolicy = require('../src/modules/jobs/job.retry');
const { resetShutdownState, setShuttingDown } = require('../src/utils/shutdown');

// Minimal logger that satisfies worker's interface
function createTestLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

describe('JobWorker', () => {
  let queue;
  let registry;
  let retryPolicy;
  let logger;

  beforeEach(() => {
    resetShutdownState();
    queue = new JobQueue({ maxCapacity: 100 });
    registry = new JobRegistry();
    retryPolicy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 });
    logger = createTestLogger();
  });

  afterEach(() => {
    resetShutdownState();
  });

  describe('constructor', () => {
    it('throws without required dependencies', () => {
      expect(() => new JobWorker({ registry, retryPolicy, logger })).toThrow('queue is required');
      expect(() => new JobWorker({ queue, retryPolicy, logger })).toThrow('registry is required');
      expect(() => new JobWorker({ queue, registry, logger })).toThrow('retryPolicy is required');
      expect(() => new JobWorker({ queue, registry, retryPolicy })).toThrow('logger is required');
    });

    it('creates a worker with defaults', () => {
      const worker = new JobWorker({ queue, registry, retryPolicy, logger });
      expect(worker.isRunning()).toBe(false);
      expect(worker.getCurrentJob()).toBeNull();
    });
  });

  describe('processing', () => {
    it('processes jobs serially in FIFO order', async () => {
      const executionOrder = [];
      registry.register('order_test', async (payload) => {
        executionOrder.push(payload.n);
      });

      queue.enqueue({ id: '1', type: 'order_test', payload: { n: 1 } });
      queue.enqueue({ id: '2', type: 'order_test', payload: { n: 2 } });
      queue.enqueue({ id: '3', type: 'order_test', payload: { n: 3 } });

      const worker = new JobWorker({ queue, registry, retryPolicy, logger, pollIntervalMs: 10 });
      worker.start();

      // Wait for jobs to process
      await new Promise((resolve) => setTimeout(resolve, 200));
      worker.stop();
      await worker.drain(1000);

      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('calls onJobComplete callback on success', async () => {
      const onJobComplete = jest.fn();
      registry.register('success_test', async () => 'done');

      queue.enqueue({ id: '1', type: 'success_test', payload: {} });

      const worker = new JobWorker({
        queue, registry, retryPolicy, logger,
        pollIntervalMs: 10,
        onJobComplete,
      });
      worker.start();

      await new Promise((resolve) => setTimeout(resolve, 200));
      worker.stop();
      await worker.drain(1000);

      expect(onJobComplete).toHaveBeenCalledTimes(1);
      expect(onJobComplete).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1', type: 'success_test' }),
        'done'
      );
    });

    it('calls onJobFailed callback on failure', async () => {
      const onJobFailed = jest.fn();
      const testError = new Error('handler failed');
      registry.register('fail_test', async () => { throw testError; });

      // Use a no-retry policy so the job fails once and stops
      const noRetry = new RetryPolicy({ maxAttempts: 1 });

      queue.enqueue({ id: '1', type: 'fail_test', payload: {} });

      const worker = new JobWorker({
        queue, registry, retryPolicy: noRetry, logger,
        pollIntervalMs: 10,
        onJobFailed,
      });
      worker.start();

      await new Promise((resolve) => setTimeout(resolve, 200));
      worker.stop();
      await worker.drain(1000);

      expect(onJobFailed).toHaveBeenCalledTimes(1);
      expect(onJobFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1' }),
        testError,
        false // willRetry is false with maxAttempts=1
      );
    });

    it('does not crash on handler errors', async () => {
      const results = [];
      let callCount = 0;
      registry.register('mixed_test', async (payload) => {
        callCount++;
        if (payload.shouldFail) {
          throw new Error('intentional failure');
        }
        results.push(payload.n);
      });

      queue.enqueue({ id: '1', type: 'mixed_test', payload: { shouldFail: true } });
      queue.enqueue({ id: '2', type: 'mixed_test', payload: { n: 2, shouldFail: false } });

      const worker = new JobWorker({
        queue, registry, retryPolicy, logger,
        pollIntervalMs: 10,
      });
      worker.start();

      await new Promise((resolve) => setTimeout(resolve, 300));
      worker.stop();
      await worker.drain(1000);

      // The second job should have been processed despite the first failing
      expect(results).toContain(2);
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('stop and drain', () => {
    it('stops the poll loop', async () => {
      registry.register('noop', async () => {});

      const worker = new JobWorker({ queue, registry, retryPolicy, logger, pollIntervalMs: 10 });
      worker.start();
      expect(worker.isRunning()).toBe(true);

      worker.stop();
      await worker.drain(1000);
      expect(worker.isRunning()).toBe(false);
    });

    it('drain resolves immediately when idle', async () => {
      registry.register('noop', async () => {});

      const worker = new JobWorker({ queue, registry, retryPolicy, logger, pollIntervalMs: 10 });

      // Not even started — drain should resolve immediately
      const start = Date.now();
      await worker.drain(5000);
      expect(Date.now() - start).toBeLessThan(100);
    });

    it('drain waits for running job to complete', async () => {
      let jobCompleted = false;
      registry.register('slow_job', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        jobCompleted = true;
      });

      queue.enqueue({ id: '1', type: 'slow_job', payload: {} });

      const worker = new JobWorker({ queue, registry, retryPolicy, logger, pollIntervalMs: 10 });
      worker.start();

      // Wait for the job to start processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop and drain
      worker.stop();
      await worker.drain(5000);

      expect(jobCompleted).toBe(true);
    });

    it('drain resolves at deadline even if job is still running', async () => {
      registry.register('very_slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      });

      queue.enqueue({ id: '1', type: 'very_slow', payload: {} });

      const worker = new JobWorker({ queue, registry, retryPolicy, logger, pollIntervalMs: 10 });
      worker.start();

      await new Promise((resolve) => setTimeout(resolve, 50));

      worker.stop();
      const start = Date.now();
      await worker.drain(200);
      const elapsed = Date.now() - start;

      // Should resolve around the deadline, not wait for the 10s job
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('shutdown integration', () => {
    it('stops polling when shutdown is detected', async () => {
      const handlerCalls = [];
      registry.register('shutdown_test', async (payload) => {
        handlerCalls.push(payload.n);
      });

      queue.enqueue({ id: '1', type: 'shutdown_test', payload: { n: 1 } });

      const worker = new JobWorker({ queue, registry, retryPolicy, logger, pollIntervalMs: 10 });
      worker.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Trigger shutdown
      setShuttingDown();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(worker.isRunning()).toBe(false);
    });
  });

  describe('retry scheduling', () => {
    it('re-enqueues failed jobs with incremented attempt', async () => {
      let attemptsSeen = [];
      registry.register('retry_test', async (payload) => {
        attemptsSeen.push(payload._attempt || 'unknown');
        throw new Error('always fail');
      });

      // Use very short retry delays for test speed
      const fastRetry = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 50 });

      queue.enqueue({ id: 'r1', type: 'retry_test', payload: {} });

      const worker = new JobWorker({
        queue, registry, retryPolicy: fastRetry, logger,
        pollIntervalMs: 10,
      });
      worker.start();

      // Wait long enough for retries to fire
      await new Promise((resolve) => setTimeout(resolve, 1000));
      worker.stop();
      await worker.drain(1000);

      // The job should have been attempted multiple times
      // Original + re-enqueued retries
      const infoLogs = logger.info.mock.calls;
      const retryLogs = logger.info.mock.calls.filter(
        (call) => call[0]?.event === 'job.retry_scheduled'
      );
      expect(retryLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
