const WALLET_COLUMNS =
  "id, transaction_type, amount, created_at, payment_status, payment_reference";
const PURCHASE_COLUMNS =
  "id, wallet_transaction_id, reference, amount, created_at, status, plan_name, service_id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareRecent(left, right) {
  const dateDifference =
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  if (dateDifference) return dateDifference;
  if (right.sourceId === left.sourceId) return 0;
  return right.sourceId > left.sourceId ? 1 : -1;
}

export function mergeTransactionHistory(walletTransactions, purchases, limit = 50) {
  if (!Array.isArray(walletTransactions) || !Array.isArray(purchases)) {
    throw new TypeError("Transaction history responses must be arrays.");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Transaction history limit must be a positive integer.");
  }

  const purchaseTransactionIds = new Set(
    purchases
      .filter(isRecord)
      .map((purchase) => purchase.wallet_transaction_id)
      .filter((id) => typeof id === "string"),
  );
  const purchaseRows = purchases
    .filter(isRecord)
    .map((purchase) => ({
      id: `purchase-${purchase.id}`,
      sourceId: purchase.id,
      type: "Data purchase",
      description: purchase.plan_name || purchase.service_id || "",
      reference: purchase.reference || "",
      amount: purchase.amount,
      createdAt: purchase.created_at,
      status: purchase.status,
    }));
  const walletRows = walletTransactions
    .filter((transaction) =>
      isRecord(transaction)
      && !purchaseTransactionIds.has(transaction.id),
    )
    .map((transaction) => ({
      id: `wallet-${transaction.id}`,
      sourceId: transaction.id,
      type: transaction.transaction_type,
      description: "",
      reference: transaction.payment_reference || "",
      amount: transaction.amount,
      createdAt: transaction.created_at,
      status: transaction.payment_status,
    }));

  return [...purchaseRows, ...walletRows]
    .filter((row) =>
      typeof row.sourceId === "string"
      && typeof row.createdAt === "string"
      && Number.isFinite(new Date(row.createdAt).getTime()),
    )
    .sort(compareRecent)
    .slice(0, limit + 1);
}

export async function fetchTransactionHistory(
  client,
  userId,
  { cursor = null, limit = 50 } = {},
) {
  if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
    throw new TypeError("A signed-in user ID is required.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Transaction history limit must be between 1 and 100.");
  }
  if (
    cursor
    && (
      typeof cursor.created_at !== "string"
      || !TIMESTAMP_PATTERN.test(cursor.created_at)
      || typeof cursor.id !== "string"
      || !UUID_PATTERN.test(cursor.id)
      || !Number.isFinite(Date.parse(cursor.created_at))
    )
  ) {
    throw new TypeError("Transaction history cursor is invalid.");
  }

  const applyCursor = (query) => cursor
    ? query.or(
      `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
    )
    : query;
  const walletQuery = applyCursor(
    client
      .from("wallet_transactions")
      .select(WALLET_COLUMNS)
      .eq("user_id", userId)
      .neq("transaction_type", "purchase")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1),
  );
  const purchaseQuery = applyCursor(
    client
      .from("data_purchases")
      .select(PURCHASE_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1),
  );
  const [walletResponse, purchaseResponse] = await Promise.all([
    walletQuery,
    purchaseQuery,
  ]);
  if (walletResponse.error || purchaseResponse.error) {
    throw new Error("Unable to load transaction history.");
  }

  const rows = mergeTransactionHistory(
    walletResponse.data,
    purchaseResponse.data,
    limit,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const lastItem = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && lastItem
      ? { created_at: lastItem.createdAt, id: lastItem.sourceId }
      : null,
  };
}
