type AuthenticatedUser = {
  id: string;
};

type HandlerDependencies = {
  authenticatedUser: (request: Request) => Promise<AuthenticatedUser | null>;
  apiKey: string | undefined;
  fetchProvider?: typeof fetch;
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createFetchDataPlansHandler(dependencies: HandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }

    if (!request.headers.get("content-type")?.includes("application/json")) {
      return jsonResponse({ error: "Content-Type must be application/json." }, 415);
    }

    let user: AuthenticatedUser | null;
    try {
      user = await dependencies.authenticatedUser(request);
    } catch {
      return jsonResponse({ error: "Unable to authenticate this request." }, 500);
    }
    if (!user) {
      return jsonResponse({ error: "Authentication required." }, 401);
    }

    if (!dependencies.apiKey) {
      return jsonResponse({ error: "VTUGate integration is not configured." }, 500);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    if (
      !isRecord(payload)
      || Object.keys(payload).length !== 1
      || !Object.hasOwn(payload, "service_id")
    ) {
      return jsonResponse(
        { error: "The request body must contain only service_id." },
        400,
      );
    }

    const serviceId = payload.service_id;
    if (
      (typeof serviceId !== "string" && typeof serviceId !== "number")
      || (typeof serviceId === "number" && !Number.isFinite(serviceId))
    ) {
      return jsonResponse(
        { error: "service_id must be a non-empty string or number." },
        400,
      );
    }

    const normalizedServiceId = String(serviceId).trim();
    if (!normalizedServiceId || normalizedServiceId.length > 128) {
      return jsonResponse(
        { error: "service_id must be between 1 and 128 characters." },
        400,
      );
    }

    const signal = (dependencies.createTimeoutSignal ?? AbortSignal.timeout)(10_000);
    let providerResponse: Response;
    try {
      providerResponse = await (dependencies.fetchProvider ?? fetch)(VTUGATE_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${dependencies.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ service_id: normalizedServiceId }),
        signal,
      });
    } catch {
      return jsonResponse(
        { error: signal.aborted ? "VTUGate request timed out." : "Unable to reach VTUGate." },
        signal.aborted ? 504 : 502,
      );
    }

    let providerBody: unknown;
    try {
      providerBody = await providerResponse.json();
    } catch {
      return jsonResponse(
        {
          error: signal.aborted
            ? "VTUGate request timed out."
            : "VTUGate returned an invalid response.",
        },
        signal.aborted ? 504 : 502,
      );
    }

    if (!providerResponse.ok) {
      return jsonResponse({ error: "VTUGate rejected the request." }, 502);
    }

    return jsonResponse(providerBody, providerResponse.status);
  };
}
