import assert from "node:assert/strict";
import test from "node:test";
import {
  createPurchaseDataHandler,
  isPurchaseIntakeEnabled,
} from "./handler.ts";

const userId = "9acbe47b-5317-4780-b713-6deea53ba572";
const purchaseId = "d82fce56-7cd1-4de6-8f66-63c805ec15ec";
const requestBody = {
  service_id: "1",
  plan_code: "DATA-1",
  phone_number: "08012345678",
  idempotency_key: "client-retry-key-1",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness({
  purchaseIntakeEnabled = true,
  user = { id: userId },
  catalog = { data: { data_plans: [{ code: "DATA-1", service_id: "1", name: "Plan 1", price: "12.34" }] } },
  databaseStatus = "pending",
  rpcError = null,
} = {}) {
  const calls = {
    auth: 0,
    catalog: [],
    rpc: [],
    reads: [],
    requestReads: 0,
  };
  const handler = createPurchaseDataHandler({
    authenticatedUser: async () => {
      calls.auth += 1;
      return user;
    },
    adminClient: () => ({
      rpc: async (name, args) => {
        calls.rpc.push({ name, args });
        return { data: purchaseId, error: rpcError };
      },
      from: (table) => ({
        select: (columns) => ({
          eq: (idColumn, idValue) => ({
            eq: (userColumn, userValue) => ({
              maybeSingle: async () => {
                calls.reads.push({ table, columns, idColumn, idValue, userColumn, userValue });
                return {
                  data: {
                    id: purchaseId,
                    reference: calls.rpc[0].args.p_reference,
                    amount: "12.34",
                    status: databaseStatus,
                  },
                  error: null,
                };
              },
            }),
          }),
        }),
      }),
    }),
    purchaseIntakeEnabled,
    fetchCatalog: async (serviceId) => {
      calls.catalog.push(serviceId);
      return catalog;
    },
    isJsonRequest: (request) =>
      request.headers.get("content-type")?.includes("application/json") ?? false,
    jsonResponse,
    optionsResponse: () => new Response(null),
    readJson: async (request) => {
      calls.requestReads += 1;
      try {
        const body = await request.json();
        return body && typeof body === "object" && !Array.isArray(body) ? body : null;
      } catch {
        return null;
      }
    },
  });

  return { handler, calls };
}

function request(body = requestBody) {
  return new Request("https://example.test/purchase-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("requires an authenticated user before catalog or database access", async () => {
  const { handler, calls } = createHarness({ user: null });
  const response = await handler(request());

  assert.equal(response.status, 401);
  assert.equal(calls.catalog.length, 0);
  assert.equal(calls.rpc.length, 0);
});

test("purchase intake flag enables only the exact server value true", () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true "]) {
    assert.equal(isPurchaseIntakeEnabled(value), false);
  }
  assert.equal(isPurchaseIntakeEnabled("true"), true);
});

test("disabled intake rejects before catalog lookup or any purchase RPC", async () => {
  const { handler, calls } = createHarness({ purchaseIntakeEnabled: false });
  const response = await handler(request({
    ...requestBody,
    purchase_intake_enabled: true,
  }));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: "Data purchases are temporarily unavailable." });
  assert.equal(calls.auth, 1);
  assert.equal(calls.requestReads, 0);
  assert.equal(calls.catalog.length, 0);
  assert.equal(calls.rpc.length, 0);
});

test("rejects malformed or browser-controlled purchase fields", async (t) => {
  const invalidBodies = [
    { ...requestBody, amount: "0.01" },
    { ...requestBody, user_id: userId },
    { ...requestBody, client_reference: "untrusted-reference" },
    { ...requestBody, idempotency_key: " " },
    { ...requestBody, phone_number: "not-a-phone" },
    { service_id: "1", plan_code: "DATA-1", phone_number: "08012345678" },
  ];

  for (const body of invalidBodies) {
    await t.test(JSON.stringify(body), async () => {
      const { handler, calls } = createHarness();
      const response = await handler(request(body));
      assert.equal(response.status, 400);
      assert.equal(calls.catalog.length, 0);
      assert.equal(calls.rpc.length, 0);
    });
  }
});

test("matches both service_id and code and uses only the catalog price", async () => {
  const { handler, calls } = createHarness({
    purchaseIntakeEnabled: true,
    catalog: {
      data: {
        data_plans: [
          { code: "DATA-1", service_id: "2", name: "Other service", price: "99.99" },
          { code: "DATA-2", service_id: "1", name: "Other plan", price: "88.88" },
          { code: "DATA-1", service_id: "1", name: "Selected plan", price: "12.34" },
        ],
      },
    },
  });

  const response = await handler(request());
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.status, "pending");
  assert.equal(body.amount, "12.34");
  assert.equal(calls.rpc[0].name, "create_data_purchase_and_debit_idempotent");
  assert.deepEqual(calls.rpc[0].args, {
    p_user_id: userId,
    p_idempotency_key: requestBody.idempotency_key,
    p_reference: calls.rpc[0].args.p_reference,
    p_service_id: "1",
    p_plan_code: "DATA-1",
    p_plan_name: "Selected plan",
    p_phone_number: "+2348012345678",
    p_amount: "12.34",
  });
  assert.match(calls.rpc[0].args.p_reference, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.reads[0], {
    table: "data_purchases",
    columns: "id, reference, amount, status",
    idColumn: "id",
    idValue: purchaseId,
    userColumn: "user_id",
    userValue: userId,
  });
});

test("rejects a catalog match that is ambiguous", async () => {
  const plan = { code: "DATA-1", service_id: "1", name: "Plan 1", price: "12.34" };
  const { handler, calls } = createHarness({
    catalog: { data_plans: [plan, plan] },
  });

  const response = await handler(request());
  assert.equal(response.status, 409);
  assert.equal(calls.rpc.length, 0);
});

test("rejects a plan unless both service_id and code match", async () => {
  const { handler, calls } = createHarness({
    catalog: {
      data_plans: [
        { code: "DATA-1", service_id: "2", name: "Other service", price: "12.34" },
        { code: "DATA-2", service_id: "1", name: "Other plan", price: "12.34" },
      ],
    },
  });

  const response = await handler(request());
  assert.equal(response.status, 404);
  assert.equal(calls.rpc.length, 0);
});

test("rejects non-positive, malformed, and over-precision catalog prices", async (t) => {
  for (const price of [0, -1, "0.00", "NaN", "1.234", "1e2", "1000000000000.00"]) {
    await t.test(String(price), async () => {
      const { handler, calls } = createHarness({
        catalog: {
          data_plans: [
            { code: "DATA-1", service_id: "1", name: "Plan 1", price },
          ],
        },
      });
      const response = await handler(request());
      assert.equal(response.status, 502);
      assert.equal(calls.rpc.length, 0);
    });
  }
});

test("retries with the same idempotency key reuse the same server reference", async () => {
  const { handler, calls } = createHarness({ purchaseIntakeEnabled: true });

  const firstResponse = await handler(request());
  const secondResponse = await handler(request());
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assert.equal(firstResponse.status, 202);
  assert.equal(secondResponse.status, 202);
  assert.equal(firstBody.purchase_id, secondBody.purchase_id);
  assert.equal(calls.rpc.length, 2);
  assert.equal(calls.rpc[0].args.p_reference, calls.rpc[1].args.p_reference);
  assert.equal(calls.rpc[0].args.p_idempotency_key, calls.rpc[1].args.p_idempotency_key);
});

test("returns the persisted purchase status rather than inventing pending on retries", async () => {
  const { handler } = createHarness({ databaseStatus: "successful" });
  const response = await handler(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "successful");
});
