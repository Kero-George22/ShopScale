const { z } = require('zod');

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid('Invalid product ID'),
        quantity: z.number().int().positive('Quantity must be greater than 0'),
      })
    )
    .min(1, 'Order must contain at least one item')
    .max(100, 'Order must not exceed 100 items'),
});

module.exports = { createOrderSchema };
