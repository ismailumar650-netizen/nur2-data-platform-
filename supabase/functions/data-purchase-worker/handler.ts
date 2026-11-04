import { bearerToken } from "../_shared/auth.ts";

type WorkerAction = "submission" | "reconciliation";

type LeasedPurchase = {
  id: string;
  status: string;
  provider_work_state: string;
  provider_lease_action: WorkerAction;
  provider_lease_token: string;
  provider_lease_expires_at: string;
};

type RpcError = {
  message?: string;
};

type WorkerClient = {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

type WorkerDependencies = {
  authorizeWorker: (request: Request) => boolean;
  adminClient: () => WorkerClient;
  workerEnabled: boolean;
};

const LEASE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerAction(value: unknown): value is WorkerAction {
  return value === "submission" || value === "reconciliation";
}

function isLeasedPurchase(value: unknown, action: WorkerAction): value is LeasedPurchase {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string"
    || !LEASE_TOKEN_PATTERN.test(String(value.provider_lease_token))
    || value.provider_work_state !== "leased"
    || value.provider_lease_action !== action
    || typeof value.provider_lease_expires_at !== "string"
  ) {
    return false;
  }

  const expiresAt = Date.parse(value.provider_lease_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  if (action === "submission") return value.status === "pending";
  return value.status === "pending" || value.status === "unknown";
}

function claimResult(data: unknown): { kind: "empty" } | { kind: "purchase"; purchase: unknown } | null {
  if (!Array.isArray(data)) return null;
  if (data.length === 0) return { kind: "empty" };
  if (data.length !== 1) return null;
  return { kind: "purchase", purchase: data[0] };
}

export function isServiceRoleRequest(request: Request, serviceRoleKey: string): boolean {
  if (!serviceRoleKey) return false;
  const supplied = bearerToken(request);
  if (!supplied) return false;
  if (supplied.length !== serviceRoleKey.length) return false;

  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ serviceRoleKey.charCodeAt(index);
  }
  return difference === 0;
}

export async function disabledProviderAdapter(
  _purchase: LeasedPurchase,
  _action: WorkerAction,
): Promise<{ outcome: "unknown" }> {
  return { outcome: "unknown" };
}

export function createDataPurchaseWorker(dependencies: WorkerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return response({ error: "Method not allowed." }, 405);
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return response({ error: "Content-Type must be application/json." }, 415);
    }

    try {
      if (!dependencies.authorizeWorker(request)) {
        return response({ error: "Worker authentication required." }, 401);
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return response({ error: "Request body must be valid JSON." }, 400);
      }
      if (
        !isRecord(payload)
        || Object.keys(payload).length !== 1
        || !isWorkerAction(payload.action)
      ) {
        return response(
          { error: "Specify exactly one action: submission or reconciliation." },
          400,
        );
      }

      const action = payload.action;
      if (!dependencies.workerEnabled) {
        return response({
          processed: false,
          action,
          reason: "provider_adapter_disabled",
        });
      }

      const claimRpc = action === "submission"
        ? "claim_next_data_purchase"
        : "claim_next_data_purchase_reconciliation";
      const client = dependencies.adminClient();
      const { data, error: claimError } = await client.rpc(claimRpc, {
        p_lease_seconds: 60,
      });
      if (claimError) {
        return response({ error: "Unable to claim provider work." }, 502);
      }

      const claimed = claimResult(data);
      if (!claimed) {
        return response({ error: "Provider claim returned an invalid result." }, 502);
      }
      if (claimed.kind === "empty") {
        return response({ processed: false, action }, 200);
      }
      if (!isLeasedPurchase(claimed.purchase, action)) {
        return response({ error: "Provider lease is invalid or expired." }, 409);
      }

      const adapterResult = await disabledProviderAdapter(claimed.purchase, action);
      const { error: transitionError } = await client.rpc(
        "transition_data_purchase_outcome",
        {
          p_purchase_id: claimed.purchase.id,
          p_lease_token: claimed.purchase.provider_lease_token,
          p_outcome: adapterResult.outcome,
          p_provider_transaction_id: null,
          p_provider_external_reference: null,
        },
      );
      if (transitionError) {
        return response(
          { error: "Unable to record the provider outcome; the lease will expire safely." },
          502,
        );
      }

      return response({ processed: true, action, outcome: "unknown" }, 202);
    } catch {
      return response(
        { error: "Worker failed; any uncompleted lease will expire safely." },
        500,
      );
    }
  };
}
