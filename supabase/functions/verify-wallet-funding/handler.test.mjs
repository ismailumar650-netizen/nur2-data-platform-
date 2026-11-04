import assert from "node:assert/strict";
import test from "node:test";
import { createVerifyWalletFundingHandler } from "./handler.ts";

const userId = "9acbe47b-5317-4780-b713-6deea53ba572";
const reference = "NUR2-00000000-0000-4000-8000-000000000001";

function request(body, { method = "POST", contentType = "application/json" } = {}) {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);
  return new Request("https://edge.example.test/verify-wallet-funding", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function createHarness({
  user = { id: userId },
  transaction = {
    id: "transaction-id",
    user_id: userId,
    amount: "100.00",
    payment_status: "pending",
    payment_provider: "paystack",
    payment_reference: reference,
  },
  transactionError = null,
  providerBody = {
    status: true,
    data: {
      reference,
      status: "success",
      amount: 10000,
      currency: "NGN",
    },
  },
  providerResponse = (body) => Response.json(body),
  fetchProvider = async () => providerResponse(providerBody),
  createTimeoutSignal,
  creditResult = "credited",
  creditError = null,
  updateError = null,
} = {}) {
  const calls = [];
  const handler = createVerifyWalletFundingHandler({
    authenticatedUser: async () => user,
    adminClient: () => ({
      from(table) {
        const query = {
          filters: [],
          eq(column, value) {
            this.filters.push([column, value]);
            return query;
          },
          maybeSingle: async () => {
            calls.push(["read", table, [...query.filters]]);
            return { data: transaction, error: transactionError };
          },
          then(resolve, reject) {
            calls.push(["update", table, [...query.filters]]);
            return Promise.resolve({ data: null, error: updateError }).then(
              resolve,
              reject,
            );
          },
        };
        return {
          select() {
            return query;
          },
          update(values) {
            calls.push(["update-values", table, values]);
            return query;
          },
        };
      },
      rpc(name, args) {
        calls.push(["rpc", name, args]);
        return Promise.resolve({ data: creditResult, error: creditError });
      },
    }),
    isJsonRequest: (incoming) =>
      incoming.headers.get("content-type")?.includes("application/json") ?? false,
    jsonResponse: (body, status = 200) =>
      Response.json(body, { status }),
    optionsResponse: () => new Response(null),
    readJson: async (incoming) => {
      try {
        const body = await incoming.json();
        return body && typeof body === "object" && !Array.isArray(body)
          ? body
          : null;
      } catch {
        return null;
      }
    },
    paystackTestKey: () => "sk_test_server-only",
    validReference: (value) =>
      typeof value === "string" && /^NUR2-[0-9a-f-]{36}$/i.test(value),
    createTimeoutSignal,
    fetchProvider: async (url, options) => {
      calls.push(["provider", String(url), options]);
      return fetchProvider(url, options);
    },
  });
  return { handler, calls };
}

test("requires valid request, authentication, and a payment owned by the user", async () => {
  const methodHarness = createHarness();
  assert.equal((await methodHarness.handler(request(null, { method: "GET" }))).status, 405);

  const unauthenticated = createHarness({ user: null });
  assert.equal(
    (await unauthenticated.handler(request({ reference }))).status,
    401,
  );
  assert.equal(unauthenticated.calls.length, 0);

  const invalidReference = createHarness();
  assert.equal(
    (await invalidReference.handler(request({ reference: "client-value" }))).status,
    400,
  );
  assert.equal(invalidReference.calls.length, 0);

  const malformedJson = createHarness();
  const invalidBody = new Request(
    "https://edge.example.test/verify-wallet-funding",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    },
  );
  assert.equal((await malformedJson.handler(invalidBody)).status, 400);
  assert.equal(malformedJson.calls.length, 0);

  const notOwned = createHarness({ transaction: null });
  assert.equal((await notOwned.handler(request({ reference }))).status, 404);
  assert.deepEqual(notOwned.calls[0][2], [
    ["user_id", userId],
    ["payment_provider", "paystack"],
    ["payment_reference", reference],
  ]);
  assert.equal(notOwned.calls.some(([kind]) => kind === "provider"), false);
});

test("credits only provider-verified matching NGN payments through the idempotent RPC", async () => {
  const harness = createHarness({
    fetchProvider: async (url, options) => {
      assert.equal(
        url,
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      );
      assert.equal(options.headers.Authorization, "Bearer sk_test_server-only");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        status: true,
        data: {
          reference,
          status: "success",
          amount: 10000,
          currency: "NGN",
        },
      });
    },
  });

  const response = await harness.handler(request({ reference }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "successful",
    credited: true,
  });
  assert.deepEqual(
    harness.calls.find(([kind]) => kind === "rpc"),
    [
      "rpc",
      "credit_wallet_from_paystack",
      { p_reference: reference, p_amount_kobo: 10000 },
    ],
  );

  const alreadyCredited = createHarness({ creditResult: "already_credited" });
  assert.deepEqual(
    await (await alreadyCredited.handler(request({ reference }))).json(),
    { status: "successful", credited: false },
  );
});

test("does not credit mismatched, pending, or already-successful payments", async () => {
  const mismatch = createHarness({
    providerBody: {
      status: true,
      data: { reference, status: "success", amount: 10001, currency: "NGN" },
    },
  });
  assert.equal((await mismatch.handler(request({ reference }))).status, 409);
  assert.equal(mismatch.calls.some(([kind]) => kind === "rpc"), false);

  const pending = createHarness({
    providerBody: { status: true, data: { reference, status: "pending" } },
  });
  assert.deepEqual(
    await (await pending.handler(request({ reference }))).json(),
    { status: "pending", credited: false },
  );
  assert.equal(pending.calls.some(([kind]) => kind === "rpc"), false);

  const successful = createHarness({
    transaction: { payment_status: "successful" },
  });
  assert.deepEqual(
    await (await successful.handler(request({ reference }))).json(),
    { status: "successful", credited: false },
  );
  assert.equal(successful.calls.some(([kind]) => kind === "provider"), false);
});

test("records provider-declared failures without credit and keeps timeouts pending", async () => {
  const failed = createHarness({
    providerBody: {
      status: true,
      data: { reference, status: "failed" },
    },
  });
  assert.deepEqual(
    await (await failed.handler(request({ reference }))).json(),
    { status: "failed", credited: false },
  );
  assert.ok(failed.calls.some(([kind]) => kind === "update-values"));
  assert.equal(failed.calls.some(([kind]) => kind === "rpc"), false);

  const timeout = createHarness({
    createTimeoutSignal: () => AbortSignal.abort(),
    fetchProvider: async () => {
      throw new Error("provider secret detail");
    },
  });
  const response = await timeout.handler(request({ reference }));
  const body = await response.json();
  assert.equal(response.status, 504);
  assert.equal(body.status, "pending");
  assert.equal(body.credited, false);
  assert.equal(JSON.stringify(body).includes("secret detail"), false);
  assert.equal(timeout.calls.some(([kind]) => kind === "rpc"), false);
});
