const catchAsync = require('../../utils/catchAsync');
const orderService = require('./order.service');
const ApiError = require('../../utils/ApiError');

const createOrder = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const idempotencyKey = req.headers['idempotency-key'];

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

  res.status(result.responseCode).json(result.responseBody);
});

module.exports = { createOrder };
