type AuthenticatedUser = {
  id: string;
  email?: string;
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
  insert(values: Record<string, unknown>): Query;
};

type WalletClient = {
  from(table: string): TableQuery;
};

type HandlerDependencies = {
  authenticatedUser: (request: Request) => Promise<AuthenticatedUser | null>;
  adminClient: () => WalletClient;
  isJsonRequest: (request: Request) => boolean;
  jsonResponse: (body: unknown, status?: number) => Response;
  optionsResponse: () => Response;
  readJson: (request: Request) => Promise<Record<string, unknown> | null>;
  paystackTestKey: () => string;
  callbackUrl: string | undefined;
  fetchProvider?: typeof fetch;
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
  createReference?: () => string;
};

const MIN_AMOUNT_KOBO = 10_000;
const MAX_AMOUNT_KOBO = 10_000_000;
const PAYSTACK_INITIALIZE_URL =
  "https://api.paystack.co/transaction/initialize";

function amountToKobo(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  const amountKobo = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (
    !Number.isSafeInteger(amountKobo)
    || amountKobo < MIN_AMOUNT_KOBO
    || amountKobo > MAX_AMOUNT_KOBO
  ) {
    return null;
  }
  return amountKobo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pendingFailure(
  dependencies: HandlerDependencies,
  reference: string,
  message: string,
  status = 502,
): Response {
  return dependencies.jsonResponse({
    error: message,
    reference,
    status: "pending",
  }, status);
}

export function createInitializeWalletFundingHandler(
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
      if (!user.email) {
        return dependencies.jsonResponse(
          { error: "An account email is required to fund a wallet." },
          400,
        );
      }

      const payload = await dependencies.readJson(request);
      const amountKobo = amountToKobo(payload?.amount);
      if (amountKobo === null) {
        return dependencies.jsonResponse(
          {
            error: "Enter an amount between ₦100 and ₦100,000 with up to 2 decimal places.",
          },
          400,
        );
      }

      const secretKey = dependencies.paystackTestKey();
      let callback: URL;
      try {
        callback = new URL(dependencies.callbackUrl ?? "");
        if (callback.protocol !== "https:") {
          throw new Error("Invalid callback protocol.");
        }
      } catch {
        return dependencies.jsonResponse(
          { error: "Wallet funding is not configured." },
          500,
        );
      }

      const client = dependencies.adminClient();
      const { data: wallet, error: walletError } = await client
        .from("wallets")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!isRecord(wallet) || typeof wallet.id !== "string" || walletError) {
        return dependencies.jsonResponse(
          { error: "Unable to find a wallet for this account." },
          409,
        );
      }

      const reference = dependencies.createReference
        ? dependencies.createReference()
        : `NUR2-${crypto.randomUUID()}`;
      const { error: insertError } = await client
        .from("wallet_transactions")
        .insert({
          wallet_id: wallet.id,
          user_id: user.id,
          transaction_type: "deposit",
          amount: amountKobo / 100,
          payment_status: "pending",
          payment_provider: "paystack",
          payment_reference: reference,
        });
      if (insertError) {
        return dependencies.jsonResponse(
          { error: "Unable to create a pending wallet payment." },
          500,
        );
      }

      const requestSignal =
        (dependencies.createTimeoutSignal ?? AbortSignal.timeout)(10_000);
      let providerResponse: Response;
      try {
        providerResponse = await (dependencies.fetchProvider ?? fetch)(
          PAYSTACK_INITIALIZE_URL,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secretKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              email: user.email,
              amount: amountKobo,
              currency: "NGN",
              reference,
              callback_url: callback.toString(),
            }),
            signal: requestSignal,
          },
        );
      } catch {
        return pendingFailure(
          dependencies,
          reference,
          requestSignal.aborted
            ? "Paystack initialization timed out. The payment remains pending and can be verified from wallet activity."
            : "Unable to reach Paystack. The payment remains pending and can be verified from wallet activity.",
          requestSignal.aborted ? 504 : 502,
        );
      }

      let providerBody: unknown;
      try {
        providerBody = await providerResponse.json();
      } catch {
        return pendingFailure(
          dependencies,
          reference,
          requestSignal.aborted
            ? "Paystack initialization timed out. The payment remains pending and can be verified from wallet activity."
            : "Paystack returned an invalid response. The payment remains pending and can be verified from wallet activity.",
          requestSignal.aborted ? 504 : 502,
        );
      }

      if (
        !providerResponse.ok
        || !isRecord(providerBody)
        || providerBody.status !== true
        || !isRecord(providerBody.data)
        || providerBody.data.reference !== reference
        || typeof providerBody.data.authorization_url !== "string"
      ) {
        return pendingFailure(
          dependencies,
          reference,
          "Paystack could not confirm checkout initialization. The payment remains pending and can be verified from wallet activity.",
        );
      }

      let authorizationUrl: URL;
      try {
        authorizationUrl = new URL(providerBody.data.authorization_url);
      } catch {
        return pendingFailure(
          dependencies,
          reference,
          "Paystack returned an invalid checkout URL. The payment remains pending and can be verified from wallet activity.",
        );
      }
      if (
        authorizationUrl.protocol !== "https:"
        || authorizationUrl.hostname !== "checkout.paystack.com"
      ) {
        return pendingFailure(
          dependencies,
          reference,
          "Paystack returned an invalid checkout URL. The payment remains pending and can be verified from wallet activity.",
        );
      }

      return dependencies.jsonResponse({
        authorization_url: authorizationUrl.toString(),
        reference,
      });
    } catch {
      return dependencies.jsonResponse(
        { error: "Unable to initialize wallet funding." },
        500,
      );
    }
  };
}
