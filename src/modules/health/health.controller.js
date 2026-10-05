const prisma = require('../../database/prisma');
const { logger } = require('../../utils/logger');

function getTimeoutMs() {
  return parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || 3000;
}

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
