const app = require('./app');
const env = require('./config/env');
const prisma = require('./database/prisma');
const { logger } = require('./utils/logger');
const {
  createShutdownCoordinator,
  getShutdownTimeoutMs,
} = require('./utils/shutdown');

// Jobs infrastructure
const JobQueue = require('./modules/jobs/job.queue');
const JobRegistry = require('./modules/jobs/job.registry');
const JobWorker = require('./modules/jobs/job.worker');
const RetryPolicy = require('./modules/jobs/job.retry');

// Reports module
const reportService = require('./modules/reports/report.service');
const { handleGenerateReport } = require('./modules/reports/report.handler');

// --- Initialize job infrastructure ---
const queue = new JobQueue({ maxCapacity: 100 });
const registry = new JobRegistry();
const retryPolicy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 });

// Register handlers
registry.register('generate_report', handleGenerateReport);

// Inject queue into report service
reportService.setQueue(queue);

// Create worker (started after server listen)
const worker = new JobWorker({
  queue,
  registry,
  retryPolicy,
  logger,
  pollIntervalMs: 1000,
});

const server = app.listen(env.port, async () => {
  logger.info(
    { port: env.port, env: env.nodeEnv },
    `Server running on port ${env.port} in ${env.nodeEnv} mode`
  );

  // Startup recovery: re-enqueue reports interrupted by previous crash
  try {
    const { requeued, failed } = await reportService.recoverInterruptedReports(
      retryPolicy.maxAttempts,
      logger
    );
    if (requeued > 0 || failed > 0) {
      logger.info(
        { event: 'recovery.completed', requeued, failed },
        `Startup recovery: ${requeued} reports re-enqueued, ${failed} marked failed`
      );
    }
  } catch (err) {
    logger.error(
      { event: 'recovery.error', err },
      'Error during startup recovery'
    );
  }

  // Start the background worker
  worker.start();
});

const shutdown = createShutdownCoordinator({
  server,
  prisma,
  logger,
  timeoutMs: getShutdownTimeoutMs(),
  exit: process.exit,
  worker,
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, shutdown, worker, queue, registry };
