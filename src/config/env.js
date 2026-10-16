const dotenv = require('dotenv');
dotenv.config();

const parseDuration = require('../utils/parseDuration');

// --- DATABASE_URL presence check ---
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. Set it in your .env file or environment.\n' +
      '  Example: DATABASE_URL=postgresql://user:pass@localhost:5432/dbname'
  );
}

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  // Only true when NODE_ENV is explicitly set to 'development'.
  // When NODE_ENV is unset, isDevMode is false — debug info is hidden.
  isDevMode: process.env.NODE_ENV === 'development',
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET,
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
  authRateLimitMax: 20, // default; validated below
};

// --- Startup validation ---
if (!env.accessTokenSecret) {
  throw new Error(
    'ACCESS_TOKEN_SECRET is required. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
  );
}

if (env.nodeEnv === 'production' && env.accessTokenSecret.length < 32) {
  throw new Error(
    'ACCESS_TOKEN_SECRET must be at least 32 characters in production.'
  );
}

// --- Token duration validation ---
// Reject invalid format or zero-duration tokens at startup.
// Warn (do not fail) when a valid duration is unusually long.
function validateTokenDuration(value, name) {
  let ms;
  try {
    ms = parseDuration(value);
  } catch {
    throw new Error(
      `${name} has invalid duration "${value}". Expected format: "15m", "1h", "7d".`
    );
  }
  if (ms === 0) {
    throw new Error(
      `${name} must not be zero ("${value}"). Tokens would expire immediately.`
    );
  }
  return ms;
}

const accessMs = validateTokenDuration(env.accessTokenExpiresIn, 'ACCESS_TOKEN_EXPIRES_IN');
const refreshMs = validateTokenDuration(env.refreshTokenExpiresIn, 'REFRESH_TOKEN_EXPIRES_IN');

const ONE_HOUR = 60 * 60 * 1000;
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

if (accessMs > ONE_HOUR) {
  console.warn(
    `[config] WARNING: ACCESS_TOKEN_EXPIRES_IN="${env.accessTokenExpiresIn}" is longer than 1 hour.`
  );
}
if (refreshMs > NINETY_DAYS) {
  console.warn(
    `[config] WARNING: REFRESH_TOKEN_EXPIRES_IN="${env.refreshTokenExpiresIn}" is longer than 90 days.`
  );
}

// --- Auth rate limit validation ---
if (process.env.AUTH_RATE_LIMIT_MAX !== undefined) {
  const parsed = parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    console.warn(
      `[config] WARNING: AUTH_RATE_LIMIT_MAX="${process.env.AUTH_RATE_LIMIT_MAX}" is invalid. Using default (20).`
    );
  } else {
    env.authRateLimitMax = parsed;
  }
}

// --- Production CORS warning ---
if (env.nodeEnv === 'production' && env.cors.origin === 'http://localhost:5173') {
  console.warn(
    '[config] WARNING: CORS_ORIGIN is still set to the development default in production.'
  );
}

module.exports = env;
