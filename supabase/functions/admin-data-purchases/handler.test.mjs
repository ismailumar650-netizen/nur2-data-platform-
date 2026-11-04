import assert from "node:assert/strict";
import test from "node:test";
import { createAdminDataPurchasesHandler } from "./handler.ts";

const adminId = "9acbe47b-5317-4780-b713-6deea53ba572";
const customerId = "d82fce56-7cd1-4de6-8f66-63c805ec15ec";
const purchaseId = "6a8ea429-5ad0-46c7-bdc4-e671bb52a68c";
const createdAt = "2026-11-03T13:00:00.123456Z";
const updatedAt = "2026-11-03T13:01:00.123456Z";
const expectedColumns =
  "id, user_id, amount, phone_number, status, provider_work_state, provider_attempts, created_at, updated_at";

const purchase = {
  id: purchaseId,
  user_id: customerId,
  amount: "20.00",
  phone_number: "+2348012345678",
  status: "pending",
  provider_work_state: "ready",
  provider_attempts: 0,
  created_at: createdAt,
  updated_at: updatedAt,
  reference: "must-not-be-returned",
  provider_transaction_id: "must-not-be-returned",
};

function createHarness({
  user = { id: adminId },
  membership = { user_id: adminId },
  membershipError = null,
  purchaseRows = [purchase],
  purchaseError = null,
  summary = [{
    unresolved_purchase_count: 1,
    customer_funds_awaiting_resolution: "20.00",
    aging_purchase_ids: [purchaseId],
  }],
  summaryError = null,
  now = Date.parse("2026-11-03T13:30:00.000Z"),
} = {}) {
  const calls = {
    auth: 0,
    authorization: [],
    tables: [],
    rpc: [],
    queries: [],
  };

  const client = {
    from(table) {
      calls.tables.push(table);
      const state = { table, selected: null, filters: [], orders: [], limit: null };
      const query = {
        select(columns) {
          state.selected = columns;
          return query;
        },
        eq(column, value) {
          state.filters.push({ column, value });
          return query;
        },
        maybeSingle: async () => {
          calls.queries.push({ ...state });
          return { data: membership, error: membershipError };
        },
        order(column, options) {
          state.orders.push({ column, options });
          return query;
        },
        limit(value) {
          state.limit = value;
          return query;
        },
        or(value) {
          state.or = value;
          return query;
        },
        then(resolve, reject) {
          calls.queries.push({ ...state });
          return Promise.resolve({
            data: purchaseRows,
            error: purchaseError,
          }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve({ data: summary, error: summaryError });
    },
  };

  const handler = createAdminDataPurchasesHandler({
    authenticatedUser: async (request) => {
      calls.auth += 1;
      calls.authorization.push(request.headers.get("Authorization"));
      return user;
    },
    adminClient: () => client,
    jsonResponse: (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    optionsResponse: () => new Response(null),
    now: () => now,
  });

  return { handler, calls };
}

function request(path = "/admin-data-purchases") {
  return new Request(`https://example.test${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer user-token" },
  });
}

test("admin gets only approved fields plus a display-only aging flag", async () => {
  const { handler, calls } = createHarness();
  const response = await handler(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body.purchases[0]), [
    "id",
    "user_id",
    "amount",
    "phone_number",
    "status",
    "provider_work_state",
    "provider_attempts",
    "created_at",
    "updated_at",
    "is_aging",
  ]);
  assert.equal(body.purchases[0].is_aging, true);
  assert.equal(body.purchases[0].reference, undefined);
  assert.equal(body.purchases[0].provider_transaction_id, undefined);
  assert.deepEqual(body.summary, {
    unresolved_purchase_count: 1,
    customer_funds_awaiting_resolution: "20.00",
  });
  assert.equal(calls.tables[0], "admin_members");
  assert.equal(calls.tables[1], "data_purchases");
  assert.equal(calls.authorization.length, 1);
  assert.ok(calls.authorization[0]?.startsWith("Bearer "));
  assert.deepEqual(calls.queries[0].filters, [
    { column: "user_id", value: adminId },
  ]);
  assert.equal(calls.rpc[0].name, "admin_data_purchase_summary");
  assert.deepEqual(calls.rpc[0].args, {
    p_page_purchase_ids: [purchaseId],
    p_aging_before: "2026-11-03T13:15:00.000Z",
  });
});

test("authenticated non-admin is denied before any purchase query", async () => {
  const { handler, calls } = createHarness({ membership: null });
  const response = await handler(request());

  assert.equal(response.status, 403);
  assert.deepEqual(calls.tables, ["admin_members"]);
  assert.equal(calls.rpc.length, 0);
});

test("missing bearer token is denied before authentication or database access", async () => {
  const { handler, calls } = createHarness({ user: null });
  const response = await handler(new Request(
    "https://example.test/admin-data-purchases",
    { method: "GET" },
  ));

  assert.equal(response.status, 401);
  assert.equal(calls.auth, 0);
  assert.equal(calls.tables.length, 0);
});

test("invalid bearer token is denied before database access", async () => {
  const { handler, calls } = createHarness({ user: null });
  const response = await handler(request());

  assert.equal(response.status, 401);
  assert.equal(calls.auth, 1);
  assert.equal(calls.tables.length, 0);
});

test("forged browser role and user metadata do not authorize a non-admin", async () => {
  const forgedUser = {
    id: adminId,
    app_metadata: { role: "admin" },
    user_metadata: { role: "admin", is_admin: true },
    role: "admin",
  };
  const { handler, calls } = createHarness({
    user: forgedUser,
    membership: null,
  });
  const response = await handler(request());

  assert.equal(response.status, 403);
  assert.deepEqual(calls.tables, ["admin_members"]);
});

test("membership query errors fail closed before purchase access", async () => {
  const { handler, calls } = createHarness({
    membership: null,
    membershipError: { message: "database error" },
  });
  const response = await handler(request());

  assert.equal(response.status, 500);
  assert.deepEqual(calls.tables, ["admin_members"]);
  assert.equal(calls.rpc.length, 0);
});

test("purchase query errors fail closed without summary", async () => {
  const { handler, calls } = createHarness({
    purchaseError: { message: "database error" },
  });
  const response = await handler(request());

  assert.equal(response.status, 500);
  assert.deepEqual(calls.tables, ["admin_members", "data_purchases"]);
  assert.equal(calls.rpc.length, 0);
});

test("summary errors fail closed without returning purchase rows", async () => {
  const { handler } = createHarness({
    summaryError: { message: "database error" },
  });
  const response = await handler(request());

  assert.equal(response.status, 500);
  assert.equal((await response.json()).purchases, undefined);
});

test("uses fixed projection, stable ordering, and default page limit 100", async () => {
  const { handler, calls } = createHarness();
  const response = await handler(request());
  await response.json();
  const query = calls.queries.find((entry) => entry.table === "data_purchases");

  assert.equal(query.selected, expectedColumns);
  assert.deepEqual(query.orders, [
    { column: "created_at", options: { ascending: false } },
    { column: "id", options: { ascending: false } },
  ]);
  assert.equal(query.limit, 100);
});

test("applies bounded page size and a validated keyset cursor", async () => {
  const first = createHarness();
  const firstResponse = await first.handler(request(
    "/admin-data-purchases?limit=1",
  ));
  const firstBody = await firstResponse.json();
  assert.ok(firstBody.next_cursor);

  const second = createHarness();
  const cursorPath = `/admin-data-purchases?limit=1&cursor=${
    encodeURIComponent(firstBody.next_cursor)
  }`;
  const secondResponse = await second.handler(request(cursorPath));
  assert.equal(secondResponse.status, 200);
  const query = second.calls.queries.find((entry) => entry.table === "data_purchases");
  assert.equal(query.limit, 1);
  assert.match(query.or, /created_at\.lt\./);
  assert.match(query.or, new RegExp(purchaseId));
});

test("rejects oversized pages and arbitrary query filters", async () => {
  const oversized = createHarness();
  assert.equal(
    (await oversized.handler(request("/admin-data-purchases?limit=101"))).status,
    400,
  );
  const arbitrary = createHarness();
  assert.equal(
    (await arbitrary.handler(request("/admin-data-purchases?role=admin"))).status,
    400,
  );
  assert.equal(oversized.calls.tables.length, 0);
  assert.equal(arbitrary.calls.tables.length, 0);
});

test("unsupported methods are rejected without authentication or database access", async () => {
  const { handler, calls } = createHarness();
  const response = await handler(new Request(
    "https://example.test/admin-data-purchases",
    { method: "POST" },
  ));

  assert.equal(response.status, 405);
  assert.equal(calls.auth, 0);
  assert.equal(calls.tables.length, 0);
});

test("the endpoint uses only read tables and the summary RPC", async () => {
  const { handler, calls } = createHarness();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(calls.tables, ["admin_members", "data_purchases"]);
  assert.deepEqual(calls.rpc.map((call) => call.name), [
    "admin_data_purchase_summary",
  ]);
});
