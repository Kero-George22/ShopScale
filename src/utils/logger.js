const pino = require('pino');
const { PassThrough } = require('stream');

const SENSITIVE_PATHS = [
  'password',
  '*.password',
  '*.*.password',
  '*.*.*.password',
  'passwordHash',
  '*.passwordHash',
  '*.*.passwordHash',
  'token',
  '*.token',
  '*.*.token',
  'accessToken',
  '*.accessToken',
  '*.*.accessToken',
  'refreshToken',
  '*.refreshToken',
  '*.*.refreshToken',
  'tokenHash',
  '*.tokenHash',
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'cookie',
  '*.cookie',
  'headers.cookie',
  '*.headers.cookie',
  'set-cookie',
  '*.set-cookie',
  'headers["set-cookie"]',
  '*.headers["set-cookie"]',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'databaseUrl',
  '*.databaseUrl',
  'secret',
  '*.secret',
  'accessTokenSecret',
  '*.accessTokenSecret',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
];

const logStream = new PassThrough();
logStream.resume();

if (process.env.NODE_ENV !== 'test') {
  logStream.pipe(process.stdout);
}

function createLogger(options = {}, destination = logStream) {
  const defaultLevel = process.env.LOG_LEVEL || 'info';

  const pinoOptions = {
    level: defaultLevel,
    redact: {
      paths: SENSITIVE_PATHS,
      censor: '[REDACTED]',
    },
    ...options,
  };

  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

const logger = createLogger();

function captureLogs() {
  const captured = [];
  const listener = (chunk) => {
    try {
      captured.push(JSON.parse(chunk.toString().trim()));
    } catch {
      captured.push(chunk.toString().trim());
    }
  };
  logStream.on('data', listener);
  return {
    logs: captured,
    release: () => logStream.off('data', listener),
  };
}

module.exports = {
  logger,
  createLogger,
  captureLogs,
  logStream,
  SENSITIVE_PATHS,
};
