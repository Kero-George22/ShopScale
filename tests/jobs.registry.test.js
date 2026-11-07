const JobRegistry = require('../src/modules/jobs/job.registry');

describe('JobRegistry', () => {
  describe('register', () => {
    it('registers a handler for a job type', () => {
      const registry = new JobRegistry();
      const handler = async () => {};
      registry.register('test_job', handler);

      expect(registry.hasHandler('test_job')).toBe(true);
      expect(registry.getHandler('test_job')).toBe(handler);
    });

    it('throws on duplicate registration', () => {
      const registry = new JobRegistry();
      registry.register('test_job', async () => {});

      expect(() =>
        registry.register('test_job', async () => {})
      ).toThrow('already registered');
    });

    it('throws on empty type', () => {
      const registry = new JobRegistry();
      expect(() => registry.register('', async () => {})).toThrow('non-empty string');
    });

    it('throws on non-string type', () => {
      const registry = new JobRegistry();
      expect(() => registry.register(123, async () => {})).toThrow('non-empty string');
    });

    it('throws on non-function handler', () => {
      const registry = new JobRegistry();
      expect(() => registry.register('test_job', 'not a function')).toThrow('must be a function');
    });
  });

  describe('getHandler', () => {
    it('returns the registered handler', () => {
      const registry = new JobRegistry();
      const handler = async (payload) => payload;
      registry.register('test_job', handler);

      expect(registry.getHandler('test_job')).toBe(handler);
    });

    it('throws for unregistered type', () => {
      const registry = new JobRegistry();
      expect(() => registry.getHandler('unknown')).toThrow('No handler registered');
    });
  });

  describe('hasHandler', () => {
    it('returns true for registered types', () => {
      const registry = new JobRegistry();
      registry.register('test_job', async () => {});
      expect(registry.hasHandler('test_job')).toBe(true);
    });

    it('returns false for unregistered types', () => {
      const registry = new JobRegistry();
      expect(registry.hasHandler('unknown')).toBe(false);
    });
  });

  describe('getTypes', () => {
    it('returns all registered type names', () => {
      const registry = new JobRegistry();
      registry.register('type_a', async () => {});
      registry.register('type_b', async () => {});

      const types = registry.getTypes();
      expect(types).toContain('type_a');
      expect(types).toContain('type_b');
      expect(types).toHaveLength(2);
    });

    it('returns empty array when no types registered', () => {
      const registry = new JobRegistry();
      expect(registry.getTypes()).toEqual([]);
    });
  });
});
