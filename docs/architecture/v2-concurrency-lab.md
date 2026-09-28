# Architecture Decision Record & Lab Report: V2 — Concurrency Lab

* **Status**: Accepted & Implemented
* **Date**: 2026-09-28
* **Scope**: Checkout, Inventory Reservation, and Stock Integrity

---

## 1. Problem

In an e-commerce platform, inventory is a finite and contentious shared resource. When multiple buyers attempt to purchase the final unit(s) of a product concurrently, the system must guarantee that:
1. **No Overselling**: For an initial inventory of $N$, the system must never complete more than $N$ purchases.
2. **Stock Integrity**: The persisted inventory must never transition into an invalid or negative state (`stock >= 0`).
3. **Atomicity**: An order is either fully reserved with all its required items, or rejected without partial stock deductions or orphan order records.

---

## 2. Current Implementation (Initial V1)

Prior to V2, the order creation logic in `src/modules/orders/order.service.js` operated in three phases:
```javascript
// Step 1: Read products outside any transaction
const products = await prisma.product.findMany({
  where: { id: { in: productIds } },
});

// Step 2: Validate stock in Node.js application memory
for (const item of items) {
  const product = productMap.get(item.productId);
  if (product.stock < item.quantity) {
    throw new ApiError(400, 'Insufficient stock');
  }
}

// Step 3: Enter transaction and decrement stock
await prisma.$transaction(async (tx) => {
  for (const item of items) {
    await tx.product.update({
      where: { id: item.productId },
      data: { stock: { decrement: item.quantity } },
    });
  }
  return tx.order.create({ ... });
});
```

### Execution Details:
* **Inventory Check**: Performed in JavaScript application memory based on a standard non-locking `SELECT` executed outside the transaction.
* **Inventory Decrement**: Executed via Prisma's `stock: { decrement: quantity }`, which compiles in PostgreSQL to:
  `UPDATE "products" SET "stock" = "stock" - $qty WHERE "id" = $id`
* **Transaction Scope**: The transaction only encapsulated the unconditional `UPDATE` and `INSERT INTO orders`.
* **Database Guarantees**: PostgreSQL guarantees atomicity between the `UPDATE` and `INSERT`. However, because the schema lacked a `CHECK (stock >= 0)` constraint and the SQL query lacked a conditional `WHERE stock >= $qty` clause, PostgreSQL subtracted values unconditionally into negative integers.
* **Application Assumption**: The application assumed that the stock read in Step 1 remained invariant until Step 3 executed.

---

## 3. Hypothesis

Under concurrent requests targeting the same product with `stock = 1`:
Multiple concurrent HTTP requests will execute Step 1 simultaneously, reading `stock = 1`. All requests will evaluate `1 >= 1` as true in Step 2. Each request will then enter Step 3 and execute an unconditional subtraction in PostgreSQL. Consequently, multiple orders will succeed, and the database inventory will drop below zero ($1 - N$).

---

## 4. Experiment Design

To evaluate this empirically without relying on assumptions:
* **Tooling**: Built a dedicated concurrent test harness [`tests/concurrency/reproduce-oversell.js`](file:///c:/ssss/projects/ShopScale/tests/concurrency/reproduce-oversell.js).
* **Controlled Target**: Created an isolated product with `stock = 1`.
* **Traffic Pattern**: Generated simultaneous HTTP requests (`Promise.all`) directly hitting `POST /api/orders` across increasing concurrency tiers: 2, 5, 10, 25, 50, and 100 concurrent requests.
* **Measured Signals**:
  * Successful orders (HTTP 201)
  * Rejected orders (HTTP 400)
  * Final stock in PostgreSQL (`SELECT stock FROM products`)
  * Oversold quantity (`successful - initialStock`)
  * Latency distribution (avg, p95, p99) and RPS

---

## 5. Reproduction Results (Before Fix)

The experiment confirmed the vulnerability immediately across every concurrency tier:

| Concurrent VUs | Total Reqs | Successful (201) | Rejected (400) | Final DB Stock | Oversold Qty | Invariant Preserved? |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **2** | 2 | **2** | 0 | **-1** | **+1** | ❌ VIOLATED |
| **5** | 5 | **5** | 0 | **-4** | **+4** | ❌ VIOLATED |
| **10** | 10 | **7** | 3 | **-6** | **+6** | ❌ VIOLATED |
| **25** | 25 | **10** | 15 | **-9** | **+9** | ❌ VIOLATED |
| **50** | 50 | **25** | 25 | **-24** | **+24** | ❌ VIOLATED |
| **100** | 100 | **50** | 50 | **-49** | **+49** | ❌ VIOLATED |

---

## 6. Root Cause Analysis

The bug is a classic **Time-of-Check to Time-of-Use (TOCTOU)** race condition:
```
Request A (VU 1)                           Request B (VU 2)
-----------------                         -----------------
1. SELECT stock FROM products (reads 1)
                                          1. SELECT stock FROM products (reads 1)
2. In-memory check: 1 >= 1 (PASS)
                                          2. In-memory check: 1 >= 1 (PASS)
3. BEGIN tx
   UPDATE products SET stock = stock - 1
   (Stock becomes 0)
   INSERT INTO orders
   COMMIT tx (Order A Created: 201)
                                          3. BEGIN tx
                                             UPDATE products SET stock = stock - 1
                                             (Stock becomes -1 ! No WHERE guard)
                                             INSERT INTO orders
                                             COMMIT tx (Order B Created: 201)
```

Because Step 1 and Step 3 are decoupled, the application made decisions on stale data. The database was never instructed that stock could not decrement below zero.

---

## 7. Candidate Solutions Analysis

| Solution | Mechanism | Pros | Cons / Trade-offs | Fit for ShopScale |
| :--- | :--- | :--- | :--- | :--- |
| **1. Naive Read-Then-Write** | Application memory pre-check. | Simple, zero lock overhead. | Completely broken under concurrency (TOCTOU). | ❌ Rejected |
| **2. Atomic Conditional UPDATE** | `UPDATE products SET stock = stock - qty WHERE id = $id AND stock >= qty` combined with checking updated row count. | Atomic, non-blocking for reads, minimal write lock duration, no distributed dependencies, handles high throughput natively. | Requires handling 0-row update in code as rejection. | ✅ **Recommended & Chosen** |
| **3. Pessimistic Row Lock (`SELECT FOR UPDATE`)** | Explicit row lock acquired at start of transaction. | Reads latest committed state within lock. | Contention overhead; holds locks throughout full transaction; vulnerable to deadlocks on multi-item checkouts unless sorted. | ⚠️ More complex than needed for simple decrements |
| **4. Serializable Isolation Level** | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`. | High conceptual purity; DB detects rw-conflicts. | Aborts concurrent transactions with serialization failures (error `40001`); mandates an application retry loop; unpredictable latency. | ❌ Overkill; adds retry complexity |
| **5. Database CHECK Constraint** | `ALTER TABLE products ADD CONSTRAINT products_stock_non_negative CHECK (stock >= 0)`. | Absolute safety net at the storage engine level; prevents bad data even from manual SQL or buggy code. | Throws database error instead of clean domain response unless caught. Best paired with Solution 2. | ✅ **Adopted as Safety Net** |

---

## 8. Chosen Solution & Architectural Rationale

### The Decision:
We implemented **Atomic Conditional Updates with Checked Row Count**, combined with:
1. **Deterministic item sorting** by `productId` to guarantee deadlock-free lock acquisition across multi-item orders.
2. **PostgreSQL `CHECK (stock >= 0)` constraint** as an engine-level integrity invariant.

### Code Implementation (`src/modules/orders/order.service.js`):
```javascript
// 1. Sort items deterministically to eliminate deadlocks
const sortedItems = [...items].sort((a, b) => a.productId.localeCompare(b.productId));

return await prisma.$transaction(async (tx) => {
  // 2. Fetch products inside transaction
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
  });

  // 3. Atomically decrement stock with conditional guard
  for (const item of sortedItems) {
    const updateResult = await tx.product.updateMany({
      where: {
        id: item.productId,
        stock: { gte: item.quantity }, // ATOMIC SQL GUARD
      },
      data: {
        stock: { decrement: item.quantity },
      },
    });

    if (updateResult.count === 0) {
      throw new ApiError(400, `Insufficient stock for product: ${product.name}`);
    }
  }

  // 4. Persist order
  return tx.order.create({ ... });
});
```

### Why this solution:
* **Database-native atomicity**: In PostgreSQL, the row lock is acquired and evaluated atomically during the `UPDATE` statement. If a preceding transaction reduced stock to 0, subsequent transactions will match 0 rows (`count === 0`), causing the application to throw an `ApiError(400)` and abort the transaction cleanly.
* **No external infrastructure**: Zero dependencies on Redis, message queues, or distributed locks.
* **Deadlock immunity**: Sorting item IDs alphabetically guarantees that any concurrent transaction touching multiple identical products acquires row locks in the exact same sequence.

---

## 9. Verification & Before vs. After Results (Experiment 4)

We executed the identical benchmark against the patched implementation:

| Concurrency (VUs) | Metric | Before (V1 Naive) | After (V2 Fixed) |
| :---: | :--- | :---: | :---: |
| **2** | Successful Orders (201)<br>Rejected Orders (400)<br>Final DB Stock<br>Oversold Quantity | 2<br>0<br>-1<br>+1 | **1**<br>**1**<br>**0**<br>**0** |
| **5** | Successful Orders (201)<br>Rejected Orders (400)<br>Final DB Stock<br>Oversold Quantity | 5<br>0<br>-4<br>+4 | **1**<br>**4**<br>**0**<br>**0** |
| **10** | Successful Orders (201)<br>Rejected Orders (400)<br>Final DB Stock<br>Oversold Quantity | 7<br>3<br>-6<br>+6 | **1**<br>**9**<br>**0**<br>**0** |
| **25** | Successful Orders (201)<br>Rejected Orders (400)<br>Final DB Stock<br>Oversold Quantity | 10<br>15<br>-9<br>+9 | **1**<br>**24**<br>**0**<br>**0** |
| **50** | Successful Orders (201)<br>Rejected Orders (400)<br>Final DB Stock<br>Oversold Quantity | 25<br>25<br>-24<br>+24 | **1**<br>**49**<br>**0**<br>**0** |
| **100** | Successful Orders (201)<br>Rejected Orders (400)<br>Final DB Stock<br>Oversold Quantity | 50<br>50<br>-49<br>+49 | **1**<br>**99**<br>**0**<br>**0** |

**Conclusion**: Under all concurrency tiers up to 100 simultaneous requests on a single available unit, **overselling was reduced to exactly 0, and final stock never fell below 0**.

---

## 10. Automated Regression Suite

We added 6 automated integration tests in [`tests/orders.concurrency.test.js`](file:///c:/ssss/projects/ShopScale/tests/orders.concurrency.test.js):
1. `stock = 1, concurrent purchase attempts`: Proves exactly 1 succeeds and 4 reject.
2. `stock = 2, concurrent purchase attempts`: Proves exactly 2 succeed and 4 reject.
3. `stock = 0, purchase attempt`: Rejects immediately without modifying database.
4. `insufficient stock for requested quantity`: Rejects request for 5 items when 3 are in stock.
5. `successful purchase decrements stock correctly`: Verifies standard single-user flow.
6. `failed purchase does not create invalid partial orders`: Verifies multi-item transaction rollback.

Total test suite status: **24/24 passing tests** (18 auth tests + 6 concurrency tests).

---

## 11. Lessons Learned

1. **Transactions alone do not prevent race conditions**: Wrapping code in `BEGIN ... COMMIT` does not protect against reading stale data before an update unless row-level locks or predicates are enforced.
2. **Push invariants to the database**: An application-level `if (stock < quantity)` is a fast-path optimization, but the database engine must enforce the constraint atomically via conditional `WHERE` clauses and `CHECK` constraints.
3. **Always sort locks**: Multi-resource operations must establish a deterministic global locking order to prevent deadlocks.
