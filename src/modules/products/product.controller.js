const catchAsync = require('../../utils/catchAsync');
const productService = require('./product.service');

const list = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;

  const result = await productService.list({ page, limit });
  res.json({
    status: 'success',
    data: result,
  });
});

const getById = catchAsync(async (req, res) => {
  const product = await productService.getById(req.params.id);
  res.json({
    status: 'success',
    data: { product },
  });
});

module.exports = { list, getById };
