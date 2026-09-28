const catchAsync = require('../../utils/catchAsync');
const orderService = require('./order.service');

const createOrder = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const { items } = req.body;

  const order = await orderService.createOrder(userId, items);

  res.status(201).json({
    status: 'success',
    data: { order },
  });
});

module.exports = { createOrder };
