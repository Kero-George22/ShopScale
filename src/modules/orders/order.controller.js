const crypto = require('crypto');
const catchAsync = require('../../utils/catchAsync');
const orderService = require('./order.service');
const ApiError = require('../../utils/ApiError');
const { logger } = require('../../utils/logger');

function getSafeKeyIdentifier(idempotencyKey) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return undefined;
  }
  return crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
}

const createOrder = catchAsync(async (req, res) => {
  const userId = req.user?.id;
  const idempotencyKey = req.headers['idempotency-key'];
  const log = req.log || logger;
  const startTime = process.hrtime.bigint();
  const keyHash = getSafeKeyIdentifier(idempotencyKey);

  try {
    if (idempotencyKey === undefined) {
      throw new ApiError(400, 'Idempotency-Key header is required');
    }

    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      throw new ApiError(400, 'Idempotency-Key header must not be empty');
    }

    if (idempotencyKey.length > 256) {
      throw new ApiError(400, 'Idempotency-Key header must not exceed 256 characters');
    }

    if (!/^[\x20-\x7E]+$/.test(idempotencyKey)) {
      throw new ApiError(400, 'Idempotency-Key header contains invalid characters');
    }

    const { items } = req.body;

    const result = await orderService.createOrder(userId, items, idempotencyKey);
    const durationMs = Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;
    const orderId = result.responseBody?.data?.order?.id;

    if (result.outcome === 'completed' || !result.cached) {
      log.info(
        {
          event: 'checkout.completed',
          requestId: req.requestId,
          userId,
          orderId,
          durationMs,
          duration: durationMs,
          keyHash,
          statusCode: result.responseCode,
        },
        'Checkout completed successfully'
      );
    } else {
      log.info(
        {
          event: 'checkout.idempotency_replay',
          requestId: req.requestId,
          userId,
          orderId,
          durationMs,
          duration: durationMs,
          keyHash,
          statusCode: result.responseCode,
        },
        'Checkout idempotency replay'
      );
    }

    res.status(result.responseCode).json(result.responseBody);
  } catch (err) {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startTime) / 1e4) / 100;
    const statusCode = err.statusCode || (err.status || 500);
    const errorClassification = err.isOperational
      ? statusCode >= 400 && statusCode < 500
        ? 'validation_or_client_error'
        : 'operational_error'
      : 'unexpected_error';

    const logLevel = statusCode >= 500 ? 'error' : 'warn';
    log[logLevel](
      {
        event: 'checkout.failed',
        requestId: req.requestId,
        userId,
        durationMs,
        duration: durationMs,
        keyHash,
        statusCode,
        errorClassification,
        errorMessage: err.message,
      },
      'Checkout failed'
    );

    throw err;
  }
});

module.exports = { createOrder };
