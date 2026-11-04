import assert from "node:assert/strict";
import test from "node:test";
import { createFetchDataPlansHandler } from "./handler.ts";

function request(body, { method = "POST", authorization = "Bearer user-token" } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization) headers.set("Authorization", authorization);
  return new Request("https://example.test/fetchdataplans", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function createHarness({
  user = { id: "authenticated-user" },
  apiKey = "server-only-key",
  fetchProvider = async () => Response.json({ data: { data_plans: [] } }),
  createTimeoutSignal,
} = {}) {
  const calls = { auth: 0, provider: [] };
  const handler = createFetchDataPlansHandler({
    authenticatedUser: async () => {
      calls.auth += 1;
      return user;
    },
    apiKey,
    createTimeoutSignal,
    fetchProvider: async (url, options) => {
      calls.provider.push({ url: String(url), options });
      return fetchProvider(url, options);
    },
  });
  return { handler, calls };
}

test("requires a verified authenticated user before provider access", async () => {
  const { handler, calls } = createHarness({ user: null });
  const response = await handler(request({ service_id: "1" }));

  assert.equal(response.status, 401);
  assert.equal(calls.provider.length, 0);
});

test("authentication errors fail closed", async () => {
  const handler = createFetchDataPlansHandler({
    authenticatedUser: async () => {
      throw new Error("private auth detail");
    },
    apiKey: "server-only-key",
    fetchProvider: async () => {
      throw new Error("provider must not be called");
    },
  });
  const response = await handler(request({ service_id: "1" }));

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Unable to authenticate this request.",
  });
});

test("validates method, content type, JSON, service ID, and configured key", async (t) => {
  const cases = [
    { req: request(null, { method: "GET" }), status: 405 },
    {
      req: new Request("https://example.test/fetchdataplans", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "service_id=1",
      }),
      status: 415,
    },
    {
      req: new Request("https://example.test/fetchdataplans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      status: 400,
    },
    { req: request({ service_id: "" }), status: 400 },
    { req: request({ service_id: "1".repeat(129) }), status: 400 },
    { req: request({ service_id: "1", user_id: "forged" }), status: 400 },
  ];

  for (const { req, status } of cases) {
    await t.test(`${req.method} expected ${status}`, async () => {
      const { handler, calls } = createHarness();
      const response = await handler(req);
      assert.equal(response.status, status);
      if (status !== 200) assert.equal(calls.provider.length, 0);
    });
  }

  const { handler, calls } = createHarness({ apiKey: "" });
  assert.equal((await handler(request({ service_id: "1" }))).status, 500);
  assert.equal(calls.provider.length, 0);
});

test("sends the source-observed catalog request and never exposes provider errors", async () => {
  const { handler, calls } = createHarness({
    fetchProvider: async (url, options) => {
      assert.equal(url, "https://api.vtugate.com/api/v1/fetchdataplans");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer server-only-key");
      assert.equal(options.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(options.body.get("service_id"), "network-1");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ data: { data_plans: [{ code: "PLAN-1" }] } });
    },
  });

  const response = await handler(request({ service_id: " network-1 " }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { data_plans: [{ code: "PLAN-1" }] },
  });
  assert.equal(calls.provider.length, 1);
});

test("upstream failures return generic errors without leaking response bodies", async (t) => {
  const cases = [
    {
      fetchProvider: async () => { throw new Error("network detail with secret"); },
      expectedStatus: 502,
    },
    {
      fetchProvider: async () => Response.json({ token: "provider-secret" }, { status: 401 }),
      expectedStatus: 502,
    },
    {
      fetchProvider: async () => new Response("not-json", { status: 200 }),
      expectedStatus: 502,
    },
  ];
  for (const entry of cases) {
    await t.test(`status ${entry.expectedStatus}`, async () => {
      const { handler } = createHarness(entry);
      const response = await handler(request({ service_id: "1" }));
      const body = await response.text();
      assert.equal(response.status, entry.expectedStatus);
      assert.equal(body.includes("secret"), false);
      assert.equal(body.includes("token"), false);
    });
  }
});

test("reports provider timeouts without exposing upstream details", async () => {
  const { handler } = createHarness({
    createTimeoutSignal: () => AbortSignal.abort(),
    fetchProvider: async (_url, options) => {
      assert.equal(options.signal.aborted, true);
      throw new Error("private provider timeout detail");
    },
  });
  const response = await handler(request({ service_id: "1" }));

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "VTUGate request timed out.",
  });

  const bodyTimeout = createFetchDataPlansHandler({
    authenticatedUser: async () => ({ id: "authenticated-user" }),
    apiKey: "server-only-key",
    createTimeoutSignal: () => AbortSignal.abort(),
    fetchProvider: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("private body timeout detail"); },
    }),
  });
  const bodyTimeoutResponse = await bodyTimeout(request({ service_id: "1" }));
  assert.equal(bodyTimeoutResponse.status, 504);
  assert.deepEqual(await bodyTimeoutResponse.json(), {
    error: "VTUGate request timed out.",
  });
});
