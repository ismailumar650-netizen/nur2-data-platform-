type AuthenticatedUser = {
  id: string;
};

type DatabaseError = {
  message?: string;
  code?: string;
};

type QueryResult<T> = {
  data: T | null;
  error: DatabaseError | null;
};

type SelectQuery = PromiseLike<QueryResult<unknown[]>> & {
  eq(column: string, value: unknown): SelectQuery;
  maybeSingle(): PromiseLike<QueryResult<{ user_id: string } | null>>;
  order(column: "created_at" | "id", options: { ascending: false }): SelectQuery;
  limit(count: number): SelectQuery;
  or(filters: string): SelectQuery;
};

type AdminClient = {
  from(table: string): {
    select(columns: string): SelectQuery;
  };
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<QueryResult<unknown>>;
};

type HandlerDependencies = {
  authenticatedUser: (request: Request) => Promise<AuthenticatedUser | null>;
  adminClient: () => AdminClient;
  jsonResponse: (body: unknown, status?: number) => Response;
  optionsResponse: () => Response;
  now?: () => number;
};

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const AGING_THRESHOLD_MS = 15 * 60 * 1000;
const PURCHASE_COLUMNS =
  "id, user_id, amount, phone_number, status, provider_work_state, provider_attempts, created_at, updated_at";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const PURCHASE_STATUSES = new Set([
  "pending",
  "successful",
  "failed",
  "unknown",
]);
const PROVIDER_WORK_STATES = new Set([
  "uncertain",
  "ready",
  "leased",
  "still_processing",
  "reconciliation_required",
  "confirmed_not_found",
  "complete",
]);
type Cursor = {
  created_at: string;
  id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string | null): Cursor | null | false {
  if (value === null) return null;
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    );
    if (
      !isRecord(decoded)
      || Object.keys(decoded).length !== 2
      || !validTimestamp(decoded.created_at)
      || typeof decoded.id !== "string"
      || !UUID_PATTERN.test(decoded.id)
    ) {
      return false;
    }

    return { created_at: decoded.created_at, id: decoded.id };
  } catch {
    return false;
  }
}

function parsePageSize(params: URLSearchParams): number | null {
  const values = params.getAll("limit");
  if (values.length === 0) return DEFAULT_PAGE_SIZE;
  if (values.length !== 1 || !/^[1-9]\d{0,2}$/.test(values[0])) return null;
  const limit = Number(values[0]);
  return limit <= MAX_PAGE_SIZE ? limit : null;
}

function validAmount(value: unknown): string | null {
  if (
    (typeof value !== "string" && typeof value !== "number")
    || (typeof value === "number" && !Number.isFinite(value))
  ) {
    return null;
  }
  const amount = String(value);
  return /^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount) ? amount : null;
}

function mapPurchase(value: unknown): Record<string, unknown> | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || typeof value.user_id !== "string"
    || !UUID_PATTERN.test(value.user_id)
    || typeof value.phone_number !== "string"
    || !PURCHASE_STATUSES.has(String(value.status))
    || !PROVIDER_WORK_STATES.has(String(value.provider_work_state))
    || !Number.isInteger(value.provider_attempts)
    || Number(value.provider_attempts) < 0
    || !validTimestamp(value.created_at)
    || !validTimestamp(value.updated_at)
  ) {
    return null;
  }

  const amount = validAmount(value.amount);
  if (!amount) return null;

  return {
    id: value.id,
    user_id: value.user_id,
    amount,
    phone_number: value.phone_number,
    status: value.status,
    provider_work_state: value.provider_work_state,
    provider_attempts: value.provider_attempts,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function parseSummary(
  value: unknown,
): {
  unresolved_purchase_count: number;
  customer_funds_awaiting_resolution: string;
  aging_purchase_ids: string[];
} | null {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    return null;
  }
  const summary = value[0];
  const count = typeof summary.unresolved_purchase_count === "number"
    ? summary.unresolved_purchase_count
    : typeof summary.unresolved_purchase_count === "string"
    && /^\d+$/.test(summary.unresolved_purchase_count)
    ? Number(summary.unresolved_purchase_count)
    : NaN;
  const funds = validAmount(summary.customer_funds_awaiting_resolution);
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || !funds
    || !Array.isArray(summary.aging_purchase_ids)
    || !summary.aging_purchase_ids.every(
      (id) => typeof id === "string" && UUID_PATTERN.test(id),
    )
  ) {
    return null;
  }

  return {
    unresolved_purchase_count: count,
    customer_funds_awaiting_resolution: funds,
    aging_purchase_ids: summary.aging_purchase_ids,
  };
}

function badRequest(
  dependencies: HandlerDependencies,
  message: string,
): Response {
  return dependencies.jsonResponse({ error: message }, 400);
}

export function createAdminDataPurchasesHandler(
  dependencies: HandlerDependencies,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return dependencies.optionsResponse();
    if (request.method !== "GET") {
      return dependencies.jsonResponse(
        { error: "Method not allowed." },
        405,
      );
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      return dependencies.jsonResponse(
        { error: "Authentication required." },
        401,
      );
    }

    let user: AuthenticatedUser | null;
    try {
      user = await dependencies.authenticatedUser(request);
    } catch {
      return dependencies.jsonResponse(
        { error: "Unable to authenticate this request." },
        500,
      );
    }
    if (!user || !UUID_PATTERN.test(user.id)) {
      return dependencies.jsonResponse(
        { error: "Authentication required." },
        401,
      );
    }

    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some(
        (key) => key !== "limit" && key !== "cursor",
      )
      || url.searchParams.getAll("cursor").length > 1
    ) {
      return badRequest(dependencies, "Only limit and cursor are supported.");
    }

    const pageSize = parsePageSize(url.searchParams);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    if (pageSize === null || cursor === false) {
      return badRequest(dependencies, "Pagination parameters are invalid.");
    }

    try {
      const client = dependencies.adminClient();
      const membershipResult = await client
        .from("admin_members")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (membershipResult.error) {
        return dependencies.jsonResponse(
          { error: "Unable to authorize this request." },
          500,
        );
      }
      if (membershipResult.data?.user_id !== user.id) {
        return dependencies.jsonResponse({ error: "Admin access required." }, 403);
      }

      let purchaseQuery = client
        .from("data_purchases")
        .select(PURCHASE_COLUMNS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(pageSize);
      if (cursor) {
        purchaseQuery = purchaseQuery.or(
          `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
        );
      }
      const purchaseResult = await purchaseQuery;
      if (
        purchaseResult.error
        || !Array.isArray(purchaseResult.data)
        || purchaseResult.data.length > pageSize
      ) {
        return dependencies.jsonResponse(
          { error: "Unable to load purchase records." },
          500,
        );
      }

      const parsedPurchases = purchaseResult.data.map(mapPurchase);
      if (parsedPurchases.some((purchase) => purchase === null)) {
        return dependencies.jsonResponse(
          { error: "Purchase data is unavailable." },
          500,
        );
      }
      const purchases = parsedPurchases.filter(
        (purchase): purchase is Record<string, unknown> => purchase !== null,
      );

      const agingBefore = new Date(
        (dependencies.now ?? Date.now)() - AGING_THRESHOLD_MS,
      ).toISOString();
      const summaryResult = await client.rpc("admin_data_purchase_summary", {
        p_page_purchase_ids: purchases.map((purchase) => purchase.id),
        p_aging_before: agingBefore,
      });
      if (summaryResult.error) {
        return dependencies.jsonResponse(
          { error: "Unable to calculate purchase totals." },
          500,
        );
      }

      const summary = parseSummary(summaryResult.data);
      if (!summary) {
        return dependencies.jsonResponse(
          { error: "Purchase totals are unavailable." },
          500,
        );
      }

      const agingIds = new Set(summary.aging_purchase_ids);
      const responsePurchases = purchases.map((purchase) => ({
        ...purchase,
        is_aging: agingIds.has(String(purchase.id)),
      }));
      const lastPurchase = purchases.at(-1);
      const nextCursor = purchases.length === pageSize && lastPurchase
        ? encodeCursor({
          created_at: String(lastPurchase.created_at),
          id: String(lastPurchase.id),
        })
        : null;

      return dependencies.jsonResponse({
        purchases: responsePurchases,
        summary: {
          unresolved_purchase_count: summary.unresolved_purchase_count,
          customer_funds_awaiting_resolution:
            summary.customer_funds_awaiting_resolution,
        },
        next_cursor: nextCursor,
      });
    } catch {
      return dependencies.jsonResponse(
        { error: "Unable to load purchase monitoring data." },
        500,
      );
    }
  };
}

export const adminDataPurchasePageSize = MAX_PAGE_SIZE;
