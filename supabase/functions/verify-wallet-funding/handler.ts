type AuthenticatedUser = {
  id: string;
};

type QueryResult = {
  data: unknown;
  error: unknown;
};

type Query = PromiseLike<QueryResult> & {
  eq(column: string, value: unknown): Query;
  maybeSingle(): PromiseLike<QueryResult>;
};

type TableQuery = {
  select(columns: string): Query;
  update(values: Record<string, unknown>): Query;
};

type WalletClient = {
  from(table: string): TableQuery;
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<QueryResult>;
};

type HandlerDependencies = {
  authenticatedUser: (request: Request) => Promise<AuthenticatedUser | null>;
  adminClient: () => WalletClient;
  isJsonRequest: (request: Request) => boolean;
  jsonResponse: (body: unknown, status?: number) => Response;
  optionsResponse: () => Response;
  readJson: (request: Request) => Promise<Record<string, unknown> | null>;
  paystackTestKey: () => string;
  validReference: (reference: unknown) => reference is string;
  fetchProvider?: typeof fetch;
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
};

const PAYSTACK_VERIFY_URL =
  "https://api.paystack.co/transaction/verify/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createVerifyWalletFundingHandler(
  dependencies: HandlerDependencies,
) {
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
        return dependencies.jsonResponse(
          { error: "Authentication required." },
          401,
        );
      }

      const payload = await dependencies.readJson(request);
      const reference = payload?.reference;
      if (!dependencies.validReference(reference)) {
        return dependencies.jsonResponse(
          { error: "A valid payment reference is required." },
          400,
        );
      }

      const client = dependencies.adminClient();
      const { data: transaction, error: transactionError } = await client
        .from("wallet_transactions")
        .select(
          "id, user_id, amount, payment_status, payment_provider, payment_reference",
        )
        .eq("user_id", user.id)
        .eq("payment_provider", "paystack")
        .eq("payment_reference", reference)
        .maybeSingle();
      if (transactionError || !isRecord(transaction)) {
        return dependencies.jsonResponse(
          { error: "Wallet payment was not found for this account." },
          404,
        );
      }

      if (transaction.payment_status === "successful") {
        return dependencies.jsonResponse({ status: "successful", credited: false });
      }
      if (transaction.payment_status !== "pending") {
        return dependencies.jsonResponse({
          status: transaction.payment_status,
          credited: false,
        });
      }

      const secretKey = dependencies.paystackTestKey();
      const requestSignal =
        (dependencies.createTimeoutSignal ?? AbortSignal.timeout)(10_000);
      let providerResponse: Response;
      try {
        providerResponse = await (dependencies.fetchProvider ?? fetch)(
          `${PAYSTACK_VERIFY_URL}${encodeURIComponent(reference)}`,
          {
            headers: {
              Authorization: `Bearer ${secretKey}`,
              Accept: "application/json",
            },
            signal: requestSignal,
          },
        );
      } catch {
        return dependencies.jsonResponse({
          error: requestSignal.aborted
            ? "Paystack verification timed out. No wallet change was made; retry verification later."
            : "Unable to reach Paystack to verify this payment. No wallet change was made.",
          status: "pending",
          credited: false,
        }, requestSignal.aborted ? 504 : 502);
      }

      let providerBody: unknown;
      try {
        providerBody = await providerResponse.json();
      } catch {
        return dependencies.jsonResponse({
          error: requestSignal.aborted
            ? "Paystack verification timed out. No wallet change was made; retry verification later."
            : "Paystack returned an invalid verification response. No wallet change was made.",
          status: "pending",
          credited: false,
        }, requestSignal.aborted ? 504 : 502);
      }
      if (
        !providerResponse.ok
        || !isRecord(providerBody)
        || providerBody.status !== true
        || !isRecord(providerBody.data)
      ) {
        return dependencies.jsonResponse(
          { error: "Paystack could not verify this payment." },
          502,
        );
      }

      const payment = providerBody.data;
      if (
        payment.reference !== reference
        || typeof payment.status !== "string"
      ) {
        return dependencies.jsonResponse(
          { error: "Paystack returned mismatched payment details." },
          502,
        );
      }

      if (payment.status !== "success") {
        if (payment.status === "failed") {
          const { error: updateError } = await client
            .from("wallet_transactions")
            .update({ payment_status: "failed" })
            .eq("id", transaction.id)
            .eq("payment_status", "pending");
          if (updateError) {
            return dependencies.jsonResponse(
              { error: "Unable to update the wallet payment status." },
              500,
            );
          }
          return dependencies.jsonResponse({ status: "failed", credited: false });
        }
        return dependencies.jsonResponse({ status: "pending", credited: false });
      }

      if (
        typeof payment.amount !== "number"
        || !Number.isSafeInteger(payment.amount)
        || payment.currency !== "NGN"
        || Math.round(Number(transaction.amount) * 100) !== payment.amount
      ) {
        return dependencies.jsonResponse(
          { error: "Verified payment amount or currency does not match." },
          409,
        );
      }

      const { data: creditResult, error: creditError } = await client.rpc(
        "credit_wallet_from_paystack",
        {
          p_reference: reference,
          p_amount_kobo: payment.amount,
        },
      );
      if (
        creditError
        || (creditResult !== "credited" && creditResult !== "already_credited")
      ) {
        return dependencies.jsonResponse(
          { error: "Unable to credit the verified wallet payment." },
          500,
        );
      }

      return dependencies.jsonResponse({
        status: "successful",
        credited: creditResult === "credited",
      });
    } catch {
      return dependencies.jsonResponse(
        { error: "Unable to verify wallet funding." },
        500,
      );
    }
  };
}
