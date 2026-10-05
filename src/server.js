const app = require('./app');
const env = require('./config/env');
const { logger } = require('./utils/logger');

app.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, `Server running on port ${env.port} in ${env.nodeEnv} mode`);
});
