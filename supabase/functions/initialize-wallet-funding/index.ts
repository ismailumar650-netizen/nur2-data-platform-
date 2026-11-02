import {
  adminClient,
  authenticatedUser,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  paystackTestKey,
  readJson,
} from "../_shared/paystack.ts";

const MIN_AMOUNT_KOBO = 10_000;
const MAX_AMOUNT_KOBO = 10_000_000;

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse();
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
  if (!isJsonRequest(request)) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }

  try {
    const user = await authenticatedUser(request);
    if (!user) return jsonResponse({ error: "Authentication required." }, 401);
    if (!user.email) return jsonResponse({ error: "An account email is required to fund a wallet." }, 400);

    const payload = await readJson(request);
    const amountKobo = amountToKobo(payload?.amount);
    if (amountKobo === null) {
      return jsonResponse({ error: "Enter an amount between ₦100 and ₦100,000 with up to 2 decimal places." }, 400);
    }

    const secretKey = paystackTestKey();
    const callbackUrl = Deno.env.get("PAYSTACK_CALLBACK_URL");
    if (!callbackUrl) return jsonResponse({ error: "Wallet funding is not configured." }, 500);
    let callback: URL;
    try {
      callback = new URL(callbackUrl);
      if (callback.protocol !== "https:") throw new Error("Invalid callback protocol.");
    } catch {
      return jsonResponse({ error: "Wallet funding is not configured." }, 500);
    }

    const client = adminClient();
    const { data: wallet, error: walletError } = await client
      .from("wallets")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (walletError || !wallet) {
      return jsonResponse({ error: "Unable to find a wallet for this account." }, 409);
    }

    const reference = `NUR2-${crypto.randomUUID()}`;
    let providerResponse: Response;
    try {
      providerResponse = await fetch("https://api.paystack.co/transaction/initialize", {
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
      });
    } catch {
      return jsonResponse({ error: "Unable to reach Paystack. Please try again." }, 502);
    }

    let providerBody: unknown;
    try {
      providerBody = await providerResponse.json();
    } catch {
      return jsonResponse({ error: "Paystack returned an invalid response." }, 502);
    }

    if (
      !providerResponse.ok
      || typeof providerBody !== "object"
      || providerBody === null
      || !("status" in providerBody)
      || providerBody.status !== true
      || !("data" in providerBody)
      || typeof providerBody.data !== "object"
      || providerBody.data === null
      || !("reference" in providerBody.data)
      || providerBody.data.reference !== reference
      || !("authorization_url" in providerBody.data)
      || typeof providerBody.data.authorization_url !== "string"
    ) {
      return jsonResponse({ error: "Paystack could not initialize this payment." }, 502);
    }

    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(providerBody.data.authorization_url);
    } catch {
      return jsonResponse({ error: "Paystack returned an invalid checkout URL." }, 502);
    }
    if (
      authorizationUrl.protocol !== "https:"
      || authorizationUrl.hostname !== "checkout.paystack.com"
    ) {
      return jsonResponse({ error: "Paystack returned an invalid checkout URL." }, 502);
    }

    const { error: insertError } = await client.from("wallet_transactions").insert({
      wallet_id: wallet.id,
      user_id: user.id,
      transaction_type: "deposit",
      amount: amountKobo / 100,
      payment_status: "pending",
      payment_provider: "paystack",
      payment_reference: reference,
    });
    if (insertError) {
      return jsonResponse({ error: "Unable to create a pending wallet payment." }, 500);
    }

    return jsonResponse({
      authorization_url: authorizationUrl.toString(),
      reference,
    });
  } catch {
    return jsonResponse({ error: "Unable to initialize wallet funding." }, 500);
  }
});
