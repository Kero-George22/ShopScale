const app = require('./app');
const env = require('./config/env');
const prisma = require('./database/prisma');
const { logger } = require('./utils/logger');
const {
  createShutdownCoordinator,
  getShutdownTimeoutMs,
} = require('./utils/shutdown');

const server = app.listen(env.port, () => {
  logger.info(
    { port: env.port, env: env.nodeEnv },
    `Server running on port ${env.port} in ${env.nodeEnv} mode`
  );
});

const shutdown = createShutdownCoordinator({
  server,
  prisma,
  logger,
  timeoutMs: getShutdownTimeoutMs(),
  exit: process.exit,
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, shutdown };
