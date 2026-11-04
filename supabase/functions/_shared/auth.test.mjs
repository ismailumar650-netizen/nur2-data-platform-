import assert from "node:assert/strict";
import test from "node:test";
import { bearerToken } from "./auth.ts";

test("parses Bearer schemes without regard to case", () => {
  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    const request = new Request("https://example.test", {
      headers: { Authorization: `${scheme} opaque-token` },
    });
    assert.equal(bearerToken(request), "opaque-token");
  }
});

test("rejects missing, malformed, or multi-value authorization headers", () => {
  for (const authorization of [undefined, "Basic token", "Bearer", "Bearer a b"]) {
    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);
    assert.equal(
      bearerToken(new Request("https://example.test", { headers })),
      null,
    );
  }
});
