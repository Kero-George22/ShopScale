const env = require('../config/env');
const { Prisma } = require('@prisma/client');
const { logger } = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  const log = req.log || logger;
  const requestId = req.requestId;
  const path = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
  const method = req.method;

  // --- Prisma error safety net ---
  // Catches any Prisma error that a service layer forgot to handle.
  // Returns safe, generic messages — never leaks database internals.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        log.warn(
          {
            requestId,
            method,
            path,
            statusCode: 409,
            error: { code: err.code, name: err.name, message: err.message },
          },
          'Prisma known request error [P2002 conflict]'
        );

        return res.status(409).json({
          status: 'error',
          statusCode: 409,
          message: 'A record with this value already exists',
          ...(env.nodeEnv === 'development' && {
            field: err.meta?.target?.join(', '),
          }),
        });
      }
      case 'P2025': {
        log.warn(
          {
            requestId,
            method,
            path,
            statusCode: 404,
            error: { code: err.code, name: err.name, message: err.message },
          },
          'Prisma known request error [P2025 not found]'
        );

        return res.status(404).json({
          status: 'error',
          statusCode: 404,
          message: 'Resource not found',
        });
      }
      default: {
        log.error(
          {
            requestId,
            method,
            path,
            statusCode: 500,
            err,
          },
          'Unhandled Prisma database error'
        );

        return res.status(500).json({
          status: 'error',
          statusCode: 500,
          message: 'A database error occurred',
        });
      }
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    log.warn(
      {
        requestId,
        method,
        path,
        statusCode: 400,
        error: { name: err.name, message: err.message },
      },
      'Prisma validation error'
    );

    return res.status(400).json({
      status: 'error',
      statusCode: 400,
      message: 'Invalid request data',
    });
  }

  // --- Operational errors (ApiError) vs Unexpected application errors ---
  const statusCode = err.statusCode || 500;
  const isUnexpected = !err.isOperational || statusCode >= 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  if (isUnexpected) {
    log.error(
      {
        requestId,
        method,
        path,
        statusCode,
        err,
      },
      'Unexpected application error'
    );
  } else {
    log.warn(
      {
        requestId,
        method,
        path,
        statusCode,
        error: {
          name: err.constructor?.name || err.name || 'ApiError',
          message: err.message,
        },
      },
      'Client operational error'
    );
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
