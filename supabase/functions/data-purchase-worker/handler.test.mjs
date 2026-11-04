import assert from "node:assert/strict";
import test from "node:test";
import {
  createDataPurchaseWorker,
  disabledProviderAdapter,
  isServiceRoleRequest,
} from "./handler.ts";

const serviceRoleToken = "server-only-worker-token";
const purchaseId = "d82fce56-7cd1-4de6-8f66-63c805ec15ec";
const leaseToken = "eb97e8ea-2a7f-4eb6-b082-990f61172809";

function request(body, token = serviceRoleToken) {
  return new Request("https://example.test/data-purchase-worker", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function createHarness({
  workerEnabled = true,
  action = "submission",
  status = "pending",
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
  claimError = null,
  transitionError = null,
} = {}) {
  const calls = [];
  const handler = createDataPurchaseWorker({
    workerEnabled,
    authorizeWorker: (incomingRequest) =>
      isServiceRoleRequest(incomingRequest, serviceRoleToken),
    adminClient: () => ({
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "transition_data_purchase_outcome") {
          return { data: null, error: transitionError };
        }
        return {
          data: [{
            id: purchaseId,
            status,
            provider_work_state: "leased",
            provider_lease_action: action,
            provider_lease_token: leaseToken,
            provider_lease_expires_at: expiresAt,
          }],
          error: claimError,
        };
      },
    }),
  });
  return { handler, calls };
}

test("service-role bearer token is required", async () => {
  const { handler, calls } = createHarness();
  const response = await handler(request({ action: "submission" }, "user-jwt"));

  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
  assert.equal(isServiceRoleRequest(request({ action: "submission" }), ""), false);
});

test("submission claim records only unknown and never calls a provider", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Network requests must remain disabled.");
  };
  try {
    const { handler, calls } = createHarness({ action: "submission" });
    const response = await handler(request({ action: "submission" }));
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.deepEqual(body, { processed: true, action: "submission", outcome: "unknown" });
    assert.equal(calls[0].name, "claim_next_data_purchase");
    assert.deepEqual(calls[1], {
      name: "transition_data_purchase_outcome",
      args: {
        p_purchase_id: purchaseId,
        p_lease_token: leaseToken,
        p_outcome: "unknown",
        p_provider_transaction_id: null,
        p_provider_external_reference: null,
      },
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconciliation claim records only unknown and never calls a provider", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Network requests must remain disabled.");
  };
  try {
    const { handler, calls } = createHarness({
      action: "reconciliation",
      status: "unknown",
    });
    const response = await handler(request({ action: "reconciliation" }));
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.deepEqual(body, {
      processed: true,
      action: "reconciliation",
      outcome: "unknown",
    });
    assert.equal(calls[0].name, "claim_next_data_purchase_reconciliation");
    assert.equal(calls[1].args.p_outcome, "unknown");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disabled provider adapter always returns unknown", async () => {
  assert.deepEqual(
    await disabledProviderAdapter({ id: purchaseId }, "submission"),
    { outcome: "unknown" },
  );
  assert.deepEqual(
    await disabledProviderAdapter({ id: purchaseId }, "reconciliation"),
    { outcome: "unknown" },
  );
});

test("disabled submission worker does not claim or transition a purchase", async () => {
  const { handler, calls } = createHarness({ workerEnabled: false });
  const response = await handler(request({ action: "submission" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    processed: false,
    action: "submission",
    reason: "provider_adapter_disabled",
  });
  assert.equal(calls.length, 0);
});

test("disabled reconciliation worker does not claim or transition a purchase", async () => {
  const { handler, calls } = createHarness({ workerEnabled: false });
  const response = await handler(request({ action: "reconciliation" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    processed: false,
    action: "reconciliation",
    reason: "provider_adapter_disabled",
  });
  assert.equal(calls.length, 0);
});

test("rejects malformed, mismatched, or expired claimed leases without settlement", async (t) => {
  const cases = [
    { action: "submission", status: "unknown" },
    { action: "reconciliation", status: "successful" },
    { action: "submission", expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ];

  for (const options of cases) {
    await t.test(JSON.stringify(options), async () => {
      const { handler, calls } = createHarness(options);
      const response = await handler(request({ action: options.action }));
      assert.equal(response.status, 409);
      assert.equal(calls.length, 1);
    });
  }
});

test("invalid worker input and unauthorized calls cannot claim work", async () => {
  const { handler, calls } = createHarness();
  const unauthorized = await handler(request({ action: "submission" }, "invalid"));
  const invalidAction = await handler(request({ action: "buydata" }));
  const extraField = await handler(request({ action: "submission", amount: 10 }));

  assert.equal(unauthorized.status, 401);
  assert.equal(invalidAction.status, 400);
  assert.equal(extraField.status, 400);
  assert.equal(calls.length, 0);
});

test("a failed outcome RPC returns a generic error and leaves lease recovery to expiry", async () => {
  const { handler, calls } = createHarness({
    transitionError: { message: "private database detail" },
  });
  const response = await handler(request({ action: "submission" }));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.p_outcome, "unknown");
  assert.equal(JSON.stringify(body).includes("private database detail"), false);
});
