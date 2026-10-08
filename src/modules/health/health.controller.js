const prisma = require('../../database/prisma');
const { logger } = require('../../utils/logger');

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 30000;

/**
 * Resolves the readiness timeout. Accepts only a plain positive integer string.
 * Anything else (missing, non-numeric, "1e3", zero, negative) falls back to the
 * default; values above MAX_TIMEOUT_MS are clamped. This also keeps the value
 * well below the 2^31-1 setTimeout limit, above which Node silently fires after 1ms
 * and would make readiness fail permanently.
 */
function getTimeoutMs() {
  const raw = process.env.HEALTH_CHECK_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_TIMEOUT_MS;
  }
  const value = parseInt(raw.trim(), 10);
  if (value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(value, MAX_TIMEOUT_MS);
}

/**
 * NOTE: the timeout below is an HTTP-level timeout, NOT query cancellation.
 * Promise.race only stops *waiting*; the underlying Prisma query keeps running
 * (and holds its pool connection) until PostgreSQL finishes it or the socket fails.
 */

async function checkDatabase(timeoutMs = getTimeoutMs()) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Database health check timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const liveness = (req, res) => {
  res.status(200).json({
    status: 'ok',
  });
};

const readiness = async (req, res) => {
  const log = req.log || logger;

  try {
    await checkDatabase();

    res.status(200).json({
      status: 'ok',
      database: 'connected',
    });
  } catch (err) {
    log.error(
      {
        requestId: req.requestId,
        err,
      },
      'Readiness check failed: database unavailable'
    );

    res.status(503).json({
      status: 'error',
      message: 'Service unavailable',
    });
  }
};

const legacyHealth = (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
  });
};

module.exports = {
  liveness,
  readiness,
  legacyHealth,
  checkDatabase,
  getTimeoutMs,
};
