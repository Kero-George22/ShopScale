const JobQueue = require('../src/modules/jobs/job.queue');
const { setShuttingDown, resetShutdownState } = require('../src/utils/shutdown');

describe('JobQueue', () => {
  afterEach(() => {
    resetShutdownState();
  });

  describe('constructor', () => {
    it('creates a queue with default capacity of 100', () => {
      const queue = new JobQueue();
      expect(queue.maxCapacity).toBe(100);
      expect(queue.size()).toBe(0);
    });

    it('creates a queue with custom capacity', () => {
      const queue = new JobQueue({ maxCapacity: 5 });
      expect(queue.maxCapacity).toBe(5);
    });

    it('throws on invalid maxCapacity', () => {
      expect(() => new JobQueue({ maxCapacity: 0 })).toThrow('positive integer');
      expect(() => new JobQueue({ maxCapacity: -1 })).toThrow('positive integer');
      expect(() => new JobQueue({ maxCapacity: 'abc' })).toThrow('positive integer');
    });
  });

  describe('enqueue and reserve', () => {
    it('enqueues and reserves jobs in FIFO order', () => {
      const queue = new JobQueue();
      queue.enqueue({ id: 'a', type: 'test', payload: { n: 1 } });
      queue.enqueue({ id: 'b', type: 'test', payload: { n: 2 } });
      queue.enqueue({ id: 'c', type: 'test', payload: { n: 3 } });

      const first = queue.reserve();
      const second = queue.reserve();
      const third = queue.reserve();

      expect(first.id).toBe('a');
      expect(second.id).toBe('b');
      expect(third.id).toBe('c');
    });

    it('sets default attempt to 1', () => {
      const queue = new JobQueue();
      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      const job = queue.reserve();
      expect(job.attempt).toBe(1);
    });

    it('preserves explicit attempt value', () => {
      const queue = new JobQueue();
      queue.enqueue({ id: 'a', type: 'test', payload: {}, attempt: 3 });
      const job = queue.reserve();
      expect(job.attempt).toBe(3);
    });

    it('adds enqueuedAt timestamp', () => {
      const queue = new JobQueue();
      const before = Date.now();
      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      const job = queue.reserve();
      expect(job.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(job.enqueuedAt).toBeLessThanOrEqual(Date.now());
    });

    it('returns null when reserving from empty queue', () => {
      const queue = new JobQueue();
      expect(queue.reserve()).toBeNull();
    });
  });

  describe('size and isFull', () => {
    it('tracks size accurately', () => {
      const queue = new JobQueue();
      expect(queue.size()).toBe(0);

      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      expect(queue.size()).toBe(1);

      queue.enqueue({ id: 'b', type: 'test', payload: {} });
      expect(queue.size()).toBe(2);

      queue.reserve();
      expect(queue.size()).toBe(1);
    });

    it('reports isFull correctly', () => {
      const queue = new JobQueue({ maxCapacity: 2 });
      expect(queue.isFull()).toBe(false);

      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      expect(queue.isFull()).toBe(false);

      queue.enqueue({ id: 'b', type: 'test', payload: {} });
      expect(queue.isFull()).toBe(true);
    });
  });

  describe('capacity enforcement', () => {
    it('rejects enqueue when queue is full', () => {
      const queue = new JobQueue({ maxCapacity: 2 });
      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      queue.enqueue({ id: 'b', type: 'test', payload: {} });

      expect(() =>
        queue.enqueue({ id: 'c', type: 'test', payload: {} })
      ).toThrow('at capacity');
    });

    it('allows enqueue after reserve frees a slot', () => {
      const queue = new JobQueue({ maxCapacity: 2 });
      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      queue.enqueue({ id: 'b', type: 'test', payload: {} });

      queue.reserve(); // free a slot
      expect(() =>
        queue.enqueue({ id: 'c', type: 'test', payload: {} })
      ).not.toThrow();
    });
  });

  describe('shutdown rejection', () => {
    it('rejects enqueue during shutdown', () => {
      const queue = new JobQueue();
      setShuttingDown();

      expect(() =>
        queue.enqueue({ id: 'a', type: 'test', payload: {} })
      ).toThrow('shutdown');
    });

    it('allows reserve during shutdown (drain existing jobs)', () => {
      const queue = new JobQueue();
      queue.enqueue({ id: 'a', type: 'test', payload: {} });

      setShuttingDown();
      const job = queue.reserve();
      expect(job.id).toBe('a');
    });
  });

  describe('validation', () => {
    it('rejects jobs without id', () => {
      const queue = new JobQueue();
      expect(() => queue.enqueue({ type: 'test', payload: {} })).toThrow('string id');
    });

    it('rejects jobs without type', () => {
      const queue = new JobQueue();
      expect(() => queue.enqueue({ id: 'a', payload: {} })).toThrow('string id and type');
    });

    it('rejects null jobs', () => {
      const queue = new JobQueue();
      expect(() => queue.enqueue(null)).toThrow();
    });
  });

  describe('clear', () => {
    it('removes all jobs', () => {
      const queue = new JobQueue();
      queue.enqueue({ id: 'a', type: 'test', payload: {} });
      queue.enqueue({ id: 'b', type: 'test', payload: {} });

      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.reserve()).toBeNull();
    });
  });
});
