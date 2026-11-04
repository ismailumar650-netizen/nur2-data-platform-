type AuthenticatedUser = {
  id: string;
};

type DatabaseError = {
  code?: string;
  message?: string;
};

type PurchaseRecord = {
  id: string;
  reference: string;
  amount: string | number;
  status: string;
};

type AdminClient = {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseError | null }>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): {
          maybeSingle(): PromiseLike<{
            data: PurchaseRecord | null;
            error: DatabaseError | null;
          }>;
        };
      };
    };
  };
};

type HandlerDependencies = {
  authenticatedUser: (request: Request) => Promise<AuthenticatedUser | null>;
  adminClient: () => AdminClient;
  fetchCatalog: (serviceId: string) => Promise<unknown>;
  purchaseIntakeEnabled: boolean;
  isJsonRequest: (request: Request) => boolean;
  jsonResponse: (body: unknown, status?: number) => Response;
  optionsResponse: () => Response;
  readJson: (request: Request) => Promise<Record<string, unknown> | null>;
};

const REQUIRED_FIELDS = new Set([
  "service_id",
  "plan_code",
  "phone_number",
  "idempotency_key",
]);
const DATABASE_AMOUNT_MAX_CENTS = 99_999_999_999_999n;

export function isPurchaseIntakeEnabled(value: string | undefined): boolean {
  return value === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(value: unknown): string | null {
  if (
    (typeof value !== "string" && typeof value !== "number")
    || (typeof value === "number" && !Number.isFinite(value))
  ) {
    return null;
  }

  const identifier = String(value).trim();
  return identifier.length > 0 && identifier.length <= 128 ? identifier : null;
}

function normalizePhoneNumber(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const digits = value.replace(/\D/g, "");
  const localNumber = digits.startsWith("234") ? `0${digits.slice(3)}` : digits;
  return /^0(?:70|80|81|90|91)\d{8}$/.test(localNumber)
    ? `+234${localNumber.slice(1)}`
    : null;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || value.trim() !== value
  ) {
    return null;
  }
  return value.trim() ? value : null;
}

function catalogPlans(response: unknown): unknown[] | null {
  if (!isRecord(response)) return null;
  const data = isRecord(response.data) ? response.data : null;
  const nestedData = data && isRecord(data.data) ? data.data : null;
  const plans = data?.data_plans ?? nestedData?.data_plans ?? response.data_plans;
  return Array.isArray(plans) ? plans : null;
}

function canonicalPrice(value: unknown): string | null {
  if (
    (typeof value !== "string" && typeof value !== "number")
    || (typeof value === "number" && !Number.isFinite(value))
  ) {
    return null;
  }

  const price = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(price);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  const totalCents = whole * 100n + cents;
  if (totalCents <= 0n || totalCents > DATABASE_AMOUNT_MAX_CENTS) return null;

  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

async function purchaseReference(userId: string, idempotencyKey: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([userId, idempotencyKey]));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validRequest(payload: Record<string, unknown>): boolean {
  const fields = Object.keys(payload);
  return fields.length === REQUIRED_FIELDS.size
    && fields.every((field) => REQUIRED_FIELDS.has(field));
}

function extractErrorResponse(
  error: DatabaseError,
  jsonResponse: HandlerDependencies["jsonResponse"],
): Response {
  if (
    error.message === "Idempotency key already used with different purchase details"
    || error.message === "Insufficient wallet balance"
    || error.message === "Wallet not found"
  ) {
    return jsonResponse({ error: error.message }, 409);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: "Purchase details are invalid." }, 400);
  }
  return jsonResponse({ error: "Unable to prepare this purchase." }, 500);
}

export function createPurchaseDataHandler(dependencies: HandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return dependencies.optionsResponse();
    if (request.method !== "POST") {
      return dependencies.jsonResponse({ error: "Method not allowed." }, 405);
    }
    if (!dependencies.isJsonRequest(request)) {
      return dependencies.jsonResponse(
        { error: "Content-Type must be application/json." },
        415,
      );
    }

    try {
      const user = await dependencies.authenticatedUser(request);
      if (!user) {
        return dependencies.jsonResponse({ error: "Authentication required." }, 401);
      }

      if (!dependencies.purchaseIntakeEnabled) {
        return dependencies.jsonResponse(
          { error: "Data purchases are temporarily unavailable." },
          503,
        );
      }

      const payload = await dependencies.readJson(request);
      if (!payload || !validRequest(payload)) {
        return dependencies.jsonResponse(
          {
            error:
              "Provide only service_id, plan_code, phone_number, and idempotency_key.",
          },
          400,
        );
      }

      const serviceId = normalizeIdentifier(payload.service_id);
      const planCode = normalizeIdentifier(payload.plan_code);
      const phoneNumber = normalizePhoneNumber(payload.phone_number);
      const idempotencyKey = normalizeIdempotencyKey(payload.idempotency_key);
      if (!serviceId || !planCode || !phoneNumber || !idempotencyKey) {
        return dependencies.jsonResponse({ error: "Purchase details are invalid." }, 400);
      }

      let plans: unknown[] | null;
      try {
        plans = catalogPlans(await dependencies.fetchCatalog(serviceId));
      } catch {
        return dependencies.jsonResponse(
          { error: "The data-plan catalog is temporarily unavailable." },
          502,
        );
      }
      if (!plans) {
        return dependencies.jsonResponse(
          { error: "The data-plan catalog returned an invalid response." },
          502,
        );
      }

      const matchingPlans = plans.filter((plan) =>
        isRecord(plan)
        && normalizeIdentifier(plan.service_id) === serviceId
        && normalizeIdentifier(plan.code) === planCode
      );
      if (matchingPlans.length === 0) {
        return dependencies.jsonResponse(
          { error: "The selected data plan is no longer available." },
          404,
        );
      }
      if (matchingPlans.length !== 1) {
        return dependencies.jsonResponse(
          { error: "The selected data plan is ambiguous in the catalog." },
          409,
        );
      }

      const selectedPlan = matchingPlans[0];
      if (!isRecord(selectedPlan)) {
        return dependencies.jsonResponse(
          { error: "The selected data plan has invalid catalog details." },
          502,
        );
      }
      const amount = canonicalPrice(selectedPlan.price);
      const planName = typeof selectedPlan.name === "string"
        ? selectedPlan.name.trim()
        : "";
      if (!amount || !planName || planName.length > 200) {
        return dependencies.jsonResponse(
          { error: "The selected data plan has invalid catalog details." },
          502,
        );
      }

      const reference = await purchaseReference(user.id, idempotencyKey);
      const client = dependencies.adminClient();
      const { data: purchaseId, error: purchaseError } = await client.rpc(
        "create_data_purchase_and_debit_idempotent",
        {
          p_user_id: user.id,
          p_idempotency_key: idempotencyKey,
          p_reference: reference,
          p_service_id: serviceId,
          p_plan_code: planCode,
          p_plan_name: planName,
          p_phone_number: phoneNumber,
          p_amount: amount,
        },
      );
      if (purchaseError) return extractErrorResponse(purchaseError, dependencies.jsonResponse);
      if (typeof purchaseId !== "string") {
        return dependencies.jsonResponse({ error: "Unable to prepare this purchase." }, 500);
      }

      const { data: purchase, error: readError } = await client
        .from("data_purchases")
        .select("id, reference, amount, status")
        .eq("id", purchaseId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (
        readError
        || !purchase
        || purchase.id !== purchaseId
        || purchase.reference !== reference
        || canonicalPrice(purchase.amount) !== amount
        || !["pending", "successful", "failed", "unknown"].includes(purchase.status)
      ) {
        return dependencies.jsonResponse(
          { error: "Unable to retrieve the prepared purchase." },
          500,
        );
      }

      return dependencies.jsonResponse({
        purchase_id: purchase.id,
        reference: purchase.reference,
        amount: purchase.amount,
        status: purchase.status,
      }, purchase.status === "pending" ? 202 : 200);
    } catch {
      return dependencies.jsonResponse({ error: "Unable to prepare this purchase." }, 500);
    }
  };
}
