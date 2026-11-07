const crypto = require('crypto');
const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');

// These are injected during bootstrap in server.js
let _queue = null;

/**
 * Injects the job queue dependency. Called once during server startup.
 * @param {import('../jobs/job.queue')} queue
 */
function setQueue(queue) {
  _queue = queue;
}

/**
 * Returns the injected queue. Throws if not initialized.
 * @returns {import('../jobs/job.queue')}
 */
function getQueue() {
  if (!_queue) {
    throw new Error('Report service not initialized: queue not set. Call setQueue() during startup.');
  }
  return _queue;
}

/**
 * Creates a new report request, persists it to the database, and enqueues
 * a background job for processing.
 *
 * @param {string} userId - The requesting user's ID
 * @param {{ type: string, parameters: object }} params
 * @returns {Promise<{ report: object }>}
 */
async function createReport(userId, { type, parameters }) {
  const queue = getQueue();

  // Pre-check: reject early if queue is full
  if (queue.isFull()) {
    throw new ApiError(503, 'Report generation service is at capacity. Please try again later.');
  }

  // Create the report record in the database
  const report = await prisma.report.create({
    data: {
      type,
      parameters: parameters || {},
      requestedById: userId,
    },
    select: {
      id: true,
      type: true,
      status: true,
      parameters: true,
      createdAt: true,
    },
  });

  // Enqueue the background job
  try {
    queue.enqueue({
      id: crypto.randomUUID(),
      type: 'generate_report',
      payload: { reportId: report.id },
    });
  } catch (enqueueErr) {
    // Dual-write gap: DB record exists but queue rejected.
    // Update the report to FAILED so the user isn't left waiting.
    await prisma.report.update({
      where: { id: report.id },
      data: {
        status: 'FAILED',
        error: `Failed to enqueue job: ${enqueueErr.message}`,
      },
    });

    throw new ApiError(503, 'Report generation service is temporarily unavailable. Please try again later.');
  }

  return { report };
}

/**
 * Fetches a single report by ID, enforcing ownership.
 * Admins can view any report.
 *
 * @param {string} reportId
 * @param {string} userId
 * @param {string} userRole
 * @returns {Promise<object>}
 */
async function getReport(reportId, userId, userRole) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
  });

  if (!report) {
    throw new ApiError(404, 'Report not found');
  }

  // Enforce ownership: users can only see their own reports; admins see all
  if (report.requestedById !== userId && userRole !== 'ADMIN') {
    throw new ApiError(404, 'Report not found');
  }

  return report;
}

/**
 * Lists reports for a user with pagination.
 * Admins see all reports; users see only their own.
 *
 * @param {string} userId
 * @param {string} userRole
 * @param {{ page?: number, limit?: number }} options
 * @returns {Promise<{ reports: object[], total: number, page: number, limit: number }>}
 */
async function listReports(userId, userRole, { page = 1, limit = 20 } = {}) {
  const where = userRole === 'ADMIN' ? {} : { requestedById: userId };
  const skip = (page - 1) * limit;

  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.report.count({ where }),
  ]);

  return { reports, total, page, limit };
}

/**
 * Startup recovery: finds reports stuck in QUEUED or PROCESSING status
 * (from a previous crash) and re-enqueues them, or marks them FAILED
 * if they've exceeded max attempts.
 *
 * @param {number} maxAttempts - Maximum total attempts before marking FAILED
 * @param {Object} logger - Pino logger instance
 * @returns {Promise<{ requeued: number, failed: number }>}
 */
async function recoverInterruptedReports(maxAttempts, logger) {
  const queue = getQueue();

  const interrupted = await prisma.report.findMany({
    where: {
      status: { in: ['QUEUED', 'PROCESSING'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  let requeued = 0;
  let failed = 0;

  for (const report of interrupted) {
    const nextAttempt = report.attempts + 1;

    if (nextAttempt > maxAttempts) {
      // Max attempts exceeded — mark as FAILED
      await prisma.report.update({
        where: { id: report.id },
        data: {
          status: 'FAILED',
          error: `Max attempts (${maxAttempts}) exceeded after process restart`,
        },
      });
      failed++;
      logger.warn(
        { event: 'recovery.report_failed', reportId: report.id, attempts: report.attempts },
        `Report ${report.id} marked FAILED after exceeding max attempts`
      );
    } else {
      // Re-enqueue for processing
      try {
        await prisma.report.update({
          where: { id: report.id },
          data: { status: 'QUEUED', attempts: nextAttempt },
        });

        queue.enqueue({
          id: crypto.randomUUID(),
          type: 'generate_report',
          payload: { reportId: report.id },
          attempt: nextAttempt,
        });

        requeued++;
        logger.info(
          { event: 'recovery.report_requeued', reportId: report.id, attempt: nextAttempt },
          `Report ${report.id} re-enqueued for processing (attempt ${nextAttempt})`
        );
      } catch (err) {
        await prisma.report.update({
          where: { id: report.id },
          data: {
            status: 'FAILED',
            error: `Recovery re-enqueue failed: ${err.message}`,
          },
        });
        failed++;
        logger.error(
          { event: 'recovery.requeue_failed', reportId: report.id, error: err.message },
          `Failed to re-enqueue report ${report.id} during recovery`
        );
      }
    }
  }

  return { requeued, failed };
}

module.exports = {
  createReport,
  getReport,
  listReports,
  recoverInterruptedReports,
  setQueue,
  getQueue,
};
