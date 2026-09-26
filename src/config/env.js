const dotenv = require('dotenv');
dotenv.config();

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET,
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
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

module.exports = env;
