class JobRegistry {
  constructor() {
    this._handlers = new Map();
  }

  /**
   * Registers a handler function for a given job type.
   * Throws if a handler is already registered for that type.
   *
   * @param {string} type - The job type identifier (e.g., 'generate_report')
   * @param {Function} handler - Async function (payload) => result
   */
  register(type, handler) {
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new Error('Job type must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    if (this._handlers.has(type)) {
      throw new Error(`Handler already registered for job type "${type}"`);
    }

    this._handlers.set(type, handler);
  }

  /**
   * Returns the handler function for the given job type.
   * Throws if no handler is registered.
   *
   * @param {string} type
   * @returns {Function}
   */
  getHandler(type) {
    const handler = this._handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for job type "${type}"`);
    }
    return handler;
  }

  /**
   * Returns true if a handler is registered for the given type.
   * @param {string} type
   * @returns {boolean}
   */
  hasHandler(type) {
    return this._handlers.has(type);
  }

  /**
   * Returns all registered job type names.
   * @returns {string[]}
   */
  getTypes() {
    return Array.from(this._handlers.keys());
  }
}

module.exports = JobRegistry;
