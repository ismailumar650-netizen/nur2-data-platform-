import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchTransactionHistory,
  mergeTransactionHistory,
} from "./transactions.js";

test("merges wallet and purchase history without duplicating purchase debits", () => {
  const transactions = mergeTransactionHistory(
    [
      {
        id: "debit-1",
        transaction_type: "purchase",
        amount: "12.00",
        created_at: "2026-11-03T10:00:00.000Z",
        payment_status: "pending",
      },
      {
        id: "deposit-1",
        transaction_type: "deposit",
        amount: "50.00",
        created_at: "2026-11-03T09:00:00.000Z",
        payment_status: "successful",
      },
    ],
    [
      {
        id: "purchase-1",
        wallet_transaction_id: "debit-1",
        reference: "ref-1",
        amount: "12.00",
        created_at: "2026-11-03T10:00:00.000Z",
        status: "pending",
        plan_name: "Plan 1",
      },
    ],
    10,
  );

  assert.deepEqual(transactions.map((transaction) => transaction.id), [
    "purchase-purchase-1",
    "wallet-deposit-1",
  ]);
  assert.equal(transactions[0].description, "Plan 1");
});

test("orders equal timestamps deterministically and returns one lookahead row", () => {
  const transactions = mergeTransactionHistory(
    [
      {
        id: "00000000-0000-4000-8000-000000000002",
        transaction_type: "deposit",
        amount: "1.00",
        created_at: "2026-11-03T10:00:00.000Z",
        payment_status: "successful",
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        transaction_type: "deposit",
        amount: "1.00",
        created_at: "2026-11-03T10:00:00.000Z",
        payment_status: "successful",
      },
    ],
    [],
    1,
  );

  assert.deepEqual(
    transactions.map((transaction) => transaction.sourceId),
    [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ],
  );
});

test("rejects malformed result collections and invalid limits", () => {
  assert.throws(() => mergeTransactionHistory(null, []), TypeError);
  assert.throws(() => mergeTransactionHistory([], [], 0), RangeError);
});

test("fetches each history page for the authenticated user with a bounded cursor", async () => {
  const queries = [];
  const responses = {
    wallet_transactions: {
      data: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          transaction_type: "deposit",
          amount: "3.00",
          created_at: "2026-11-03T10:00:00.000Z",
          payment_status: "successful",
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          transaction_type: "deposit",
          amount: "2.00",
          created_at: "2026-11-03T09:00:00.000Z",
          payment_status: "successful",
        },
      ],
      error: null,
    },
    data_purchases: { data: [], error: null },
  };
  const client = {
    from(table) {
      const query = {
        table,
        filters: [],
        orders: [],
        eq(column, value) {
          this.filters.push(["eq", column, value]);
          return this;
        },
        neq(column, value) {
          this.filters.push(["neq", column, value]);
          return this;
        },
        order(column, options) {
          this.orders.push([column, options]);
          return this;
        },
        limit(count) {
          this.pageSize = count;
          return this;
        },
        or(filters) {
          this.cursorFilter = filters;
          return this;
        },
        then(resolve, reject) {
          return Promise.resolve(responses[table]).then(resolve, reject);
        },
      };
      queries.push(query);
      return {
        select() {
          return query;
        },
      };
    },
  };
  const cursor = {
    created_at: "2026-11-03T10:00:00.000Z",
    id: "00000000-0000-4000-8000-000000000004",
  };

  const page = await fetchTransactionHistory(
    client,
    "00000000-0000-4000-8000-000000000001",
    { cursor, limit: 1 },
  );

  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.filters, [
      ["eq", "user_id", "00000000-0000-4000-8000-000000000001"],
      ...(query.table === "wallet_transactions"
        ? [["neq", "transaction_type", "purchase"]]
        : []),
    ]);
    assert.equal(query.pageSize, 2);
    assert.equal(
      query.cursorFilter,
      "created_at.lt.2026-11-03T10:00:00.000Z,and(created_at.eq.2026-11-03T10:00:00.000Z,id.lt.00000000-0000-4000-8000-000000000004)",
    );
    assert.deepEqual(query.orders, [
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  }
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor.id, "00000000-0000-4000-8000-000000000003");
});

test("rejects malformed pagination values before querying", async () => {
  const client = { from() { throw new Error("Should not query"); } };
  const userId = "00000000-0000-4000-8000-000000000001";

  await assert.rejects(
    fetchTransactionHistory(client, userId, {
      cursor: {
        created_at: "2026-11-03T10:00:00.000Z),user_id.eq.anything",
        id: "00000000-0000-4000-8000-000000000002",
      },
    }),
    TypeError,
  );
  await assert.rejects(
    fetchTransactionHistory(client, userId, { limit: 101 }),
    RangeError,
  );
});
