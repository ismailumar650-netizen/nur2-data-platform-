import assert from "node:assert/strict";
import test from "node:test";
import { createInitializeWalletFundingHandler } from "./handler.ts";

const userId = "9acbe47b-5317-4780-b713-6deea53ba572";
const reference = "NUR2-00000000-0000-4000-8000-000000000001";

function request(body, { method = "POST", contentType = "application/json" } = {}) {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);
  return new Request("https://edge.example.test/initialize-wallet-funding", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function createHarness({
  user = { id: userId, email: "customer@example.invalid" },
  wallet = { id: "wallet-id" },
  walletError = null,
  insertError = null,
  apiKey = "sk_test_server-only",
  callbackUrl = "https://app.example.test/wallet",
  fetchProvider = async () => Response.json({
    status: true,
    data: {
      reference,
      authorization_url: "https://checkout.paystack.com/session",
    },
  }),
  createTimeoutSignal,
} = {}) {
  const calls = [];
  const handler = createInitializeWalletFundingHandler({
    authenticatedUser: async () => user,
    adminClient: () => ({
      from(table) {
        return {
          select() {
            const query = {
              eq(column, value) {
                calls.push(["filter", table, column, value]);
                return query;
              },
              maybeSingle: async () => {
                calls.push(["wallet-read", table]);
                return { data: wallet, error: walletError };
              },
            };
            return query;
          },
          insert(values) {
            calls.push(["insert", table, values]);
            return Promise.resolve({ data: null, error: insertError });
          },
        };
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
    paystackTestKey: () => apiKey,
    callbackUrl,
    createReference: () => reference,
    createTimeoutSignal,
    fetchProvider: async (url, options) => {
      calls.push(["provider", String(url), options]);
      return fetchProvider(url, options);
    },
  });
  return { handler, calls };
}

test("validates method, content type, authentication, and bounded amounts", async () => {
  const getHarness = createHarness();
  assert.equal((await getHarness.handler(request(null, { method: "GET" }))).status, 405);

  const contentTypeHarness = createHarness();
  assert.equal(
    (await contentTypeHarness.handler(
      request({ amount: "100" }, { contentType: "text/plain" }),
    )).status,
    415,
  );

  const unauthenticated = createHarness({ user: null });
  assert.equal((await unauthenticated.handler(request({ amount: "100" }))).status, 401);
  assert.equal(unauthenticated.calls.some(([kind]) => kind === "provider"), false);

  for (const amount of ["99.99", "100000.01", "100.001", "1e3", 100]) {
    const invalid = createHarness();
    assert.equal(
      (await invalid.handler(request({ amount }))).status,
      400,
      `amount ${String(amount)} must be rejected`,
    );
    assert.equal(invalid.calls.some(([kind]) => kind === "provider"), false);
  }

  const malformedJson = createHarness();
  const invalidBody = new Request(
    "https://edge.example.test/initialize-wallet-funding",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    },
  );
  assert.equal((await malformedJson.handler(invalidBody)).status, 400);
});

test("creates a pending intent before initializing the exact test payment", async () => {
  const harness = createHarness({
    fetchProvider: async (url, options) => {
      assert.equal(url, "https://api.paystack.co/transaction/initialize");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer sk_test_server-only");
      assert.deepEqual(JSON.parse(options.body), {
        email: "customer@example.invalid",
        amount: 12550,
        currency: "NGN",
        reference,
        callback_url: "https://app.example.test/wallet",
      });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        status: true,
        data: {
          reference,
          authorization_url: "https://checkout.paystack.com/session",
        },
      });
    },
  });

  const response = await harness.handler(request({ amount: "125.50" }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    authorization_url: "https://checkout.paystack.com/session",
    reference,
  });
  const insertIndex = harness.calls.findIndex(([kind]) => kind === "insert");
  const providerIndex = harness.calls.findIndex(([kind]) => kind === "provider");
  assert.ok(insertIndex >= 0 && providerIndex > insertIndex);
  assert.deepEqual(harness.calls[insertIndex][2], {
    wallet_id: "wallet-id",
    user_id: userId,
    transaction_type: "deposit",
    amount: 125.5,
    payment_status: "pending",
    payment_provider: "paystack",
    payment_reference: reference,
  });
});

test("retains a recoverable pending reference after timeout without leaking errors", async () => {
  const harness = createHarness({
    createTimeoutSignal: () => AbortSignal.abort(),
    fetchProvider: async () => {
      throw new Error("provider secret detail");
    },
  });

  const response = await harness.handler(request({ amount: "100" }));
  const body = await response.json();
  assert.equal(response.status, 504);
  assert.equal(body.reference, reference);
  assert.equal(body.status, "pending");
  assert.equal(JSON.stringify(body).includes("secret detail"), false);
});

test("rejects unavailable wallets and untrusted checkout destinations", async () => {
  const noWallet = createHarness({ wallet: null });
  assert.equal((await noWallet.handler(request({ amount: "100" }))).status, 409);
  assert.equal(noWallet.calls.some(([kind]) => kind === "provider"), false);

  const invalidCheckout = createHarness({
    fetchProvider: async () => Response.json({
      status: true,
      data: {
        reference,
        authorization_url: "https://attacker.example.test/pay",
      },
    }),
  });
  const response = await invalidCheckout.handler(request({ amount: "100" }));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.status, "pending");
  assert.equal(body.reference, reference);

  const insertFailure = createHarness({ insertError: { message: "private db error" } });
  assert.equal(
    (await insertFailure.handler(request({ amount: "100" }))).status,
    500,
  );
  assert.equal(insertFailure.calls.some(([kind]) => kind === "provider"), false);
});
