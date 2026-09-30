const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');

/**
 * Computes a deterministic SHA-256 fingerprint for the checkout items payload.
 * Normalizes each line item to { productId, quantity } and sorts by productId
 * so equivalent payloads with different line ordering produce identical hashes.
 */
function computeRequestHash(items) {
  const normalized = items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
  }));

  normalized.sort((a, b) => a.productId.localeCompare(b.productId));

  const canonical = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Identifies whether a Prisma error is specifically a unique constraint
 * violation on the idempotency_keys composite primary key (key, user_id).
 * Avoids misclassifying P2002 errors from any other models or constraints.
 */
function isIdempotencyKeyConflict(err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    if (err.meta?.modelName === 'IdempotencyKey') {
      return true;
    }
    if (
      Array.isArray(err.meta?.target) &&
      err.meta.target.includes('key') &&
      err.meta.target.includes('user_id')
    ) {
      return true;
    }
  }
  return false;
}

async function createOrder(userId, items, idempotencyKey) {
  const requestHash = computeRequestHash(items);

  // 1. Pre-transaction fast-path check for existing completed operation
  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      key_userId: {
        key: idempotencyKey,
        userId,
      },
    },
  });

  if (existing && existing.responseCode !== 0) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError(
        422,
        'Idempotency key has already been used with a different request payload'
      );
    }
    return {
      cached: true,
      responseCode: existing.responseCode,
      responseBody: existing.responseBody,
    };
  }

  // 2. Transactional checkout with atomic idempotency key reservation
  try {
    return await prisma.$transaction(async (tx) => {
      // Step 0: Reserve the idempotency key in the same transaction
      await tx.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          userId,
          requestHash,
          responseCode: 0,
          responseBody: {},
        },
      });

      // Step 1: Sort items deterministically by productId to ensure consistent lock acquisition
      // order across concurrent transactions and eliminate potential deadlocks. (V2 logic)
      const sortedItems = [...items].sort((a, b) =>
        a.productId.localeCompare(b.productId)
      );
      const productIds = sortedItems.map((i) => i.productId);

      // Step 2: Fetch products inside transaction (V2 logic)
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
      });

      if (products.length !== productIds.length) {
        throw new ApiError(404, 'One or more products not found');
      }

      const productMap = new Map(products.map((p) => [p.id, p]));

      let totalPrice = 0;
      const orderItemsData = [];

      // Step 3: Atomically decrement stock with conditional check (V2 logic)
      for (const item of sortedItems) {
        const product = productMap.get(item.productId);

        // Fast in-memory pre-check
        if (product.stock < item.quantity) {
          throw new ApiError(400, `Insufficient stock for product: ${product.name}`);
        }

        // Atomic conditional UPDATE:
        // UPDATE "products" SET "stock" = "stock" - $qty WHERE "id" = $id AND "stock" >= $qty
        // If a concurrent transaction decremented stock first, row count will be 0.
        const updateResult = await tx.product.updateMany({
          where: {
            id: item.productId,
            stock: { gte: item.quantity },
          },
          data: {
            stock: {
              decrement: item.quantity,
            },
          },
        });

        if (updateResult.count === 0) {
          throw new ApiError(400, `Insufficient stock for product: ${product.name}`);
        }

        const itemPrice = Number(product.price);
        totalPrice += itemPrice * item.quantity;

        orderItemsData.push({
          productId: item.productId,
          quantity: item.quantity,
          price: product.price,
        });
      }

      // Step 4: Persist order and items atomically (V2 logic)
      const order = await tx.order.create({
        data: {
          userId,
          status: 'PENDING',
          totalPrice: totalPrice.toFixed(2),
          items: {
            create: orderItemsData,
          },
        },
        include: {
          items: true,
        },
      });

      // Step 5: Update the idempotency key record with the committed outcome before commit.
      // Pre-serialize so Decimal and Date types are formatted identically in both
      // the immediate in-memory response and the stored JSONB record.
      const responseBody = JSON.parse(
        JSON.stringify({
          status: 'success',
          data: { order },
        })
      );

      await tx.idempotencyKey.update({
        where: {
          key_userId: {
            key: idempotencyKey,
            userId,
          },
        },
        data: {
          responseCode: 201,
          responseBody,
        },
      });

      return {
        cached: false,
        responseCode: 201,
        responseBody,
      };
    });
  } catch (err) {
    // 3. Handle concurrent same-key race condition: if another transaction won the race
    // and committed, read its committed outcome outside the aborted transaction.
    if (isIdempotencyKeyConflict(err)) {
      const completed = await prisma.idempotencyKey.findUnique({
        where: {
          key_userId: {
            key: idempotencyKey,
            userId,
          },
        },
      });

      if (completed && completed.responseCode !== 0) {
        if (completed.requestHash !== requestHash) {
          throw new ApiError(
            422,
            'Idempotency key has already been used with a different request payload'
          );
        }
        return {
          cached: true,
          responseCode: completed.responseCode,
          responseBody: completed.responseBody,
        };
      }
    }

    throw err;
  }
}

module.exports = { createOrder, computeRequestHash, isIdempotencyKeyConflict };
