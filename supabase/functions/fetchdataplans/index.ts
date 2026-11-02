const VTUGATE_API_URL = "https://api.vtugate.com/api/v1/fetchdataplans";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }

  const apiKey = Deno.env.get("VTUGATE_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "VTUGate integration is not configured." }, 500);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  if (typeof payload !== "object" || payload === null || !("service_id" in payload)) {
    return jsonResponse({ error: "A service_id is required." }, 400);
  }

  const serviceId = payload.service_id;
  const invalidServiceIdType =
    typeof serviceId !== "string" && typeof serviceId !== "number";
  const invalidNumericServiceId =
    typeof serviceId === "number" && !Number.isFinite(serviceId);
  if (
    invalidServiceIdType ||
    invalidNumericServiceId
  ) {
    return jsonResponse({ error: "service_id must be a non-empty string or number." }, 400);
  }

  const normalizedServiceId = String(serviceId).trim();
  if (!normalizedServiceId || normalizedServiceId.length > 128) {
    return jsonResponse({ error: "service_id must be between 1 and 128 characters." }, 400);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(VTUGATE_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ service_id: normalizedServiceId }),
    });
  } catch {
    return jsonResponse({ error: "Unable to reach VTUGate." }, 502);
  }

  let upstreamBody: unknown;
  try {
    upstreamBody = await upstreamResponse.json();
  } catch {
    return jsonResponse({ error: "VTUGate returned an invalid response." }, 502);
  }

  if (!upstreamResponse.ok) {
    return jsonResponse(
      { error: "VTUGate rejected the request.", details: upstreamBody },
      upstreamResponse.status,
    );
  }

  return jsonResponse(upstreamBody, upstreamResponse.status);
});
