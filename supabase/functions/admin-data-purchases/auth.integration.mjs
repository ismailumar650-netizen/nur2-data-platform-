import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createAuthenticatedAdminUser } from "./auth.ts";
import { createAdminDataPurchasesHandler } from "./handler.ts";

const adminId = "9acbe47b-5317-4780-b713-6deea53ba572";
const customerId = "d82fce56-7cd1-4de6-8f66-63c805ec15ec";
const purchaseId = "6a8ea429-5ad0-46c7-bdc4-e671bb52a68c";

function createIntegrationHarness({ authReply, membership }) {
  const authRequests = [];
  const databaseCalls = [];
  const purchase = {
    id: purchaseId,
    user_id: customerId,
    amount: "20.00",
    phone_number: "+2348012345678",
    status: "pending",
    provider_work_state: "ready",
    provider_attempts: 0,
    created_at: "2026-11-03T13:00:00.123456Z",
    updated_at: "2026-11-03T13:01:00.123456Z",
  };

  const authFetch = async (input, init = {}) => {
    authRequests.push({
      url: String(input),
      authorization: new Headers(init.headers).get("Authorization"),
    });
    return new Response(JSON.stringify(authReply.body), {
      status: authReply.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  const authenticate = createAuthenticatedAdminUser(
    (url, key, options) => createClient(url, key, {
      ...options,
      global: { fetch: authFetch },
    }),
    "https://supabase.example.test",
    "test-anon-key",
  );

  const databaseClient = {
    from(table) {
      databaseCalls.push({ type: "from", table });
      const state = { table, selected: null, filters: [] };
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
          databaseCalls.push({ type: "membership", ...state });
          return { data: membership, error: null };
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        then(resolve, reject) {
          databaseCalls.push({ type: "purchase-query", ...state });
          return Promise.resolve({ data: [purchase], error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return query;
    },
    rpc(name) {
      databaseCalls.push({ type: "rpc", name });
      return Promise.resolve({
        data: [{
          unresolved_purchase_count: 1,
          customer_funds_awaiting_resolution: "20.00",
          aging_purchase_ids: [purchaseId],
        }],
        error: null,
      });
    },
  };

  const handler = createAdminDataPurchasesHandler({
    authenticatedUser: authenticate,
    adminClient: () => databaseClient,
    jsonResponse: (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    optionsResponse: () => new Response(null),
  });

  return { handler, authRequests, databaseCalls };
}

function request(authorization) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return new Request("https://edge.example.test/admin-data-purchases", {
    method: "GET",
    headers,
  });
}

test("admin Edge Function rejects missing Authorization without Auth or database calls", async () => {
  const harness = createIntegrationHarness({
    authReply: { status: 200, body: { id: adminId } },
    membership: { user_id: adminId },
  });

  const response = await harness.handler(request());

  assert.equal(response.status, 401);
  assert.deepEqual(harness.authRequests, []);
  assert.deepEqual(harness.databaseCalls, []);
});

test("admin Edge Function rejects a malformed Bearer header before Auth", async () => {
  const harness = createIntegrationHarness({
    authReply: { status: 200, body: { id: adminId } },
    membership: { user_id: adminId },
  });

  const response = await harness.handler(request("Bearer token with spaces"));

  assert.equal(response.status, 401);
  assert.deepEqual(harness.authRequests, []);
  assert.deepEqual(harness.databaseCalls, []);
});

test("Supabase Auth client rejects an invalid or expired token response", async () => {
  const harness = createIntegrationHarness({
    authReply: {
      status: 401,
      body: { code: "bad_jwt", message: "Invalid or expired token" },
    },
    membership: { user_id: adminId },
  });

  const response = await harness.handler(request("Bearer invalid.expired.token"));

  assert.equal(response.status, 401);
  assert.equal(harness.authRequests.length, 1);
  assert.match(harness.authRequests[0].url, /\/auth\/v1\/user$/);
  assert.equal(
    harness.authRequests[0].authorization,
    "Bearer invalid.expired.token",
  );
  assert.deepEqual(harness.databaseCalls, []);
});

test("a valid non-admin Auth user receives 403 without purchase data", async () => {
  const harness = createIntegrationHarness({
    authReply: {
      status: 200,
      body: { id: customerId, aud: "authenticated", role: "authenticated" },
    },
    membership: null,
  });

  const response = await harness.handler(request("Bearer valid-customer-token"));
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: "Admin access required." });
  assert.equal(harness.authRequests.length, 1);
  assert.deepEqual(
    harness.databaseCalls.map((call) => `${call.type}:${call.table}`),
    ["from:admin_members", "membership:admin_members"],
  );
  assert.equal(
    harness.databaseCalls.some(
      (call) => call.table === "data_purchases" || call.type === "rpc",
    ),
    false,
  );
});

test("a valid admin Auth user proceeds through membership and handler flow", async () => {
  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    const harness = createIntegrationHarness({
      authReply: {
        status: 200,
        body: { id: adminId, aud: "authenticated", role: "authenticated" },
      },
      membership: { user_id: adminId },
    });

    const token = "valid-admin-token";
    const response = await harness.handler(request(`${scheme} ${token}`));
    const body = await response.json();

    assert.equal(response.status, 200, `${scheme} should authenticate`);
    assert.equal(harness.authRequests.length, 1);
    assert.equal(
      harness.authRequests[0].authorization,
      `Bearer ${token}`,
    );
    assert.deepEqual(
      harness.databaseCalls.map((call) =>
        call.type === "rpc" ? "rpc" : `${call.type}:${call.table}`
      ),
      [
        "from:admin_members",
        "membership:admin_members",
        "from:data_purchases",
        "purchase-query:data_purchases",
        "rpc",
      ],
    );
    assert.deepEqual(body.purchases.map((row) => row.id), [purchaseId]);
  }
});
