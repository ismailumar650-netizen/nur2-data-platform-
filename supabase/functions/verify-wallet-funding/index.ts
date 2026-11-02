import {
  adminClient,
  authenticatedUser,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  paystackTestKey,
  readJson,
  validReference,
} from "../_shared/paystack.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse();
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
  if (!isJsonRequest(request)) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }

  try {
    const user = await authenticatedUser(request);
    if (!user) return jsonResponse({ error: "Authentication required." }, 401);

    const payload = await readJson(request);
    if (!validReference(payload?.reference)) {
      return jsonResponse({ error: "A valid payment reference is required." }, 400);
    }

    const client = adminClient();
    const { data: transaction, error: transactionError } = await client
      .from("wallet_transactions")
      .select("id, user_id, amount, payment_status, payment_provider, payment_reference")
      .eq("user_id", user.id)
      .eq("payment_provider", "paystack")
      .eq("payment_reference", payload.reference)
      .maybeSingle();
    if (transactionError || !transaction) {
      return jsonResponse({ error: "Wallet payment was not found for this account." }, 404);
    }

    if (transaction.payment_status === "successful") {
      return jsonResponse({ status: "successful", credited: false });
    }
    if (transaction.payment_status !== "pending") {
      return jsonResponse({ status: transaction.payment_status, credited: false });
    }

    const secretKey = paystackTestKey();
    let providerResponse: Response;
    try {
      providerResponse = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(payload.reference)}`,
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            Accept: "application/json",
          },
        },
      );
    } catch {
      return jsonResponse({ error: "Unable to reach Paystack to verify this payment." }, 502);
    }

    let providerBody: unknown;
    try {
      providerBody = await providerResponse.json();
    } catch {
      return jsonResponse({ error: "Paystack returned an invalid verification response." }, 502);
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
    ) {
      return jsonResponse({ error: "Paystack could not verify this payment." }, 502);
    }

    const payment = providerBody.data;
    if (
      !("reference" in payment)
      || payment.reference !== payload.reference
      || !("status" in payment)
      || typeof payment.status !== "string"
    ) {
      return jsonResponse({ error: "Paystack returned mismatched payment details." }, 502);
    }

    if (payment.status !== "success") {
      if (payment.status === "failed") {
        const { error: updateError } = await client
          .from("wallet_transactions")
          .update({ payment_status: "failed" })
          .eq("id", transaction.id)
          .eq("payment_status", "pending");
        if (updateError) {
          return jsonResponse({ error: "Unable to update the wallet payment status." }, 500);
        }
        return jsonResponse({ status: "failed", credited: false });
      }
      return jsonResponse({ status: "pending", credited: false });
    }

    if (
      !("amount" in payment)
      || typeof payment.amount !== "number"
      || !Number.isSafeInteger(payment.amount)
      || !("currency" in payment)
      || payment.currency !== "NGN"
      || Math.round(Number(transaction.amount) * 100) !== payment.amount
    ) {
      return jsonResponse({ error: "Verified payment amount or currency does not match." }, 409);
    }

    const { data: creditResult, error: creditError } = await client.rpc(
      "credit_wallet_from_paystack",
      {
        p_reference: payload.reference,
        p_amount_kobo: payment.amount,
      },
    );
    if (creditError || !["credited", "already_credited"].includes(creditResult)) {
      return jsonResponse({ error: "Unable to credit the verified wallet payment." }, 500);
    }

    return jsonResponse({
      status: "successful",
      credited: creditResult === "credited",
    });
  } catch {
    return jsonResponse({ error: "Unable to verify wallet funding." }, 500);
  }
});
