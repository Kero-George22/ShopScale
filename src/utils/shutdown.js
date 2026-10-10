const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60000;

let shuttingDown = false;

function isShuttingDown() {
  return shuttingDown;
}

function setShuttingDown() {
  shuttingDown = true;
}

function resetShutdownState() {
  shuttingDown = false;
}

function getShutdownTimeoutMs() {
  const raw = process.env.SHUTDOWN_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  const value = parseInt(raw.trim(), 10);
  if (value <= 0) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return Math.min(value, MAX_SHUTDOWN_TIMEOUT_MS);
}

function createShutdownCoordinator({
  server,
  prisma,
  logger,
  timeoutMs = getShutdownTimeoutMs(),
  exit = process.exit,
}) {
  let shutdownPromise = null;

  return function shutdown(signal = 'SIGTERM') {
    if (shutdownPromise) {
      logger.warn(
        { event: 'shutdown.signal_ignored', signal },
        'Shutdown already in progress; subsequent signal ignored'
      );
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const startTime = process.hrtime.bigint();
      let exitCode = 0;

      setShuttingDown();
      logger.info(
        { event: 'shutdown.initiated', signal, timeoutMs },
        `Graceful shutdown initiated by ${signal}`
      );

      // --- Phase 1: HTTP Server Drain ---
      let idleInterval;
      const serverClosePromise = new Promise((resolve, reject) => {
        if (!server || typeof server.close !== 'function') {
          return resolve();
        }
        server.close((err) => {
          if (idleInterval) {
            clearInterval(idleInterval);
          }
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // Close idle connections immediately, and periodically close any connections
      // that become idle as in-flight requests complete (preventing keep-alive sockets
      // from hanging for the full keepAliveTimeout duration without aborting active requests).
      if (server && typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
        idleInterval = setInterval(() => {
          server.closeIdleConnections();
        }, 20);
        if (typeof idleInterval.unref === 'function') {
          idleInterval.unref();
        }
      }

      let drainTimer;
      const drainDeadline = new Promise((resolve) => {
        drainTimer = setTimeout(() => {
          const elapsedMs =
            Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;
          logger.error(
            { event: 'shutdown.drain_timeout', timeoutMs, elapsedMs },
            `HTTP drain deadline reached after ${timeoutMs}ms; force-closing remaining connections`
          );

          if (idleInterval) {
            clearInterval(idleInterval);
          }
          if (server && typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          exitCode = 1;
          resolve();
        }, timeoutMs);
        if (typeof drainTimer.unref === 'function') {
          drainTimer.unref();
        }
      });

      try {
        await Promise.race([serverClosePromise, drainDeadline]);
      } catch (closeErr) {
        logger.error(
          { event: 'shutdown.server_close_error', err: closeErr },
          'Error occurred while closing HTTP server'
        );
        exitCode = 1;
      }

      // Always confirm the server is fully closed before proceeding to Prisma disconnect
      try {
        await serverClosePromise;
      } catch {
        // Any error was already recorded above
      }

      if (idleInterval) {
        clearInterval(idleInterval);
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
      }

      if (exitCode === 0) {
        const drainElapsedMs =
          Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;
        logger.info(
          { event: 'shutdown.http_drained', elapsedMs: drainElapsedMs },
          'HTTP server closed and all connections drained'
        );
      }

      // --- Phase 2: Database Disconnect ---
      const disconnectTimeoutMs = Math.min(timeoutMs, 5000);
      let disconnectTimer;
      const disconnectDeadline = new Promise((_, reject) => {
        disconnectTimer = setTimeout(() => {
          const err = new Error(
            `Prisma disconnect timed out after ${disconnectTimeoutMs}ms`
          );
          err.code = 'ETIMEDOUT';
          reject(err);
        }, disconnectTimeoutMs);
        if (typeof disconnectTimer.unref === 'function') {
          disconnectTimer.unref();
        }
      });

      try {
        if (prisma && typeof prisma.$disconnect === 'function') {
          await Promise.race([prisma.$disconnect(), disconnectDeadline]);
          logger.info(
            { event: 'shutdown.prisma_disconnected' },
            'Prisma client disconnected successfully'
          );
        }
      } catch (err) {
        if (err && err.code === 'ETIMEDOUT') {
          logger.error(
            { event: 'shutdown.prisma_disconnect_timeout', timeoutMs: disconnectTimeoutMs },
            `Prisma disconnect timed out after ${disconnectTimeoutMs}ms`
          );
        } else {
          logger.error(
            { event: 'shutdown.prisma_disconnect_failed', err },
            'Error disconnecting Prisma client'
          );
        }
        exitCode = 1;
      } finally {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
        }
      }

      // --- Phase 3: Final Exit ---
      const totalElapsedMs =
        Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;
      const logFn = exitCode === 0 ? logger.info.bind(logger) : logger.error.bind(logger);
      logFn(
        {
          event: 'shutdown.completed',
          signal,
          exitCode,
          durationMs: totalElapsedMs,
        },
        `Graceful shutdown completed with exit code ${exitCode}`
      );

      process.exitCode = exitCode;
      if (typeof exit === 'function') {
        exit(exitCode);
      }
    })();

    return shutdownPromise;
  };
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
  isShuttingDown,
  setShuttingDown,
  resetShutdownState,
  getShutdownTimeoutMs,
  createShutdownCoordinator,
};
