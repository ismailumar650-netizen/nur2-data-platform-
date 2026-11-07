export type VTUGateResult =
  | {
      outcome: "successful";
      transactionId: string | null;
      externalReference: string | null;
    }
  | {
      outcome: "failed" | "unknown";
      transactionId: string | null;
      externalReference: string | null;
    };

export type VTUGatePurchase = {
  service_id: string;
  plan_code: string;
  phone_number: string;
  amount: string | number;
  client_reference: string;
};

export async function submitVTUGatePurchase(
  purchase: VTUGatePurchase,
): Promise<VTUGateResult> {
  const apiKey = Deno.env.get("VTUGATE_API_KEY");

  if (!apiKey) {
    return {
      outcome: "unknown",
      transactionId: null,
      externalReference: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(
      "https://api.vtugate.com/api/v1/buydata",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          service_id: purchase.service_id,
          plan_code: purchase.plan_code,
          phone_number: purchase.phone_number,
          amount: String(purchase.amount),
          client_reference: purchase.client_reference,
        }),
        signal: controller.signal,
      },
    );

    const body: unknown = await response.json();

    if (
      typeof body !== "object" ||
      body === null ||
      !("status" in body) ||
      typeof body.status !== "boolean"
    ) {
      return {
        outcome: "unknown",
        transactionId: null,
        externalReference: null,
      };
    }

    const data =
      "data" in body &&
      typeof body.data === "object" &&
      body.data !== null
        ? body.data
        : null;

    const transactionId =
      data && "transaction_id" in data &&
      (typeof data.transaction_id === "string" ||
        typeof data.transaction_id === "number")
        ? String(data.transaction_id)
        : null;

    const externalReference =
      data && "external_reference" in data &&
      typeof data.external_reference === "string"
        ? data.external_reference
        : null;

    if (body.status === true && data && "provider_status" in data) {
      if (data.provider_status === true) {
        return {
          outcome: "successful",
          transactionId,
          externalReference,
        };
      }

      if (data.provider_status === false) {
        return {
          outcome: "failed",
          transactionId,
          externalReference,
        };
      }
    }

    return {
      outcome: "unknown",
      transactionId,
      externalReference,
    };
  } catch {
    return {
      outcome: "unknown",
      transactionId: null,
      externalReference: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
