const env = require('../config/env');
const { Prisma } = require('@prisma/client');

const errorHandler = (err, req, res, next) => {
  // --- Prisma error safety net ---
  // Catches any Prisma error that a service layer forgot to handle.
  // Returns safe, generic messages — never leaks database internals.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (env.nodeEnv === 'development') {
      console.error(`Prisma error [${err.code}]:`, err.message);
    }

    switch (err.code) {
      case 'P2002':
        return res.status(409).json({
          status: 'error',
          statusCode: 409,
          message: 'A record with this value already exists',
          ...(env.nodeEnv === 'development' && {
            field: err.meta?.target?.join(', '),
          }),
        });
      case 'P2025':
        return res.status(404).json({
          status: 'error',
          statusCode: 404,
          message: 'Resource not found',
        });
      default:
        return res.status(500).json({
          status: 'error',
          statusCode: 500,
          message: 'A database error occurred',
        });
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    if (env.nodeEnv === 'development') {
      console.error('Prisma validation error:', err.message);
    }
    return res.status(400).json({
      status: 'error',
      statusCode: 400,
      message: 'Invalid request data',
    });
  }

  // --- Operational errors (ApiError) ---
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
