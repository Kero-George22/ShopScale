const env = require('../config/env');

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  if (env.nodeEnv === 'development') {
    console.error(err);
  }

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
    ...(err.errors && { errors: err.errors }),
    ...(env.nodeEnv === 'development' && !err.isOperational && { stack: err.stack }),
  });
};

module.exports = errorHandler;
