const { Router } = require('express');
const orderController = require('./order.controller');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { createOrderSchema } = require('./order.validation');

const router = Router();

router.post(
  '/',
  authenticate,
  validate(createOrderSchema),
  orderController.createOrder
);

module.exports = router;
