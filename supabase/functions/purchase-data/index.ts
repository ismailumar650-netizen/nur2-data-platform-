import {
  adminClient,
  authenticatedUser,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  readJson,
} from "../_shared/paystack.ts";
import {
  createPurchaseDataHandler,
} from "./handler.ts";

const VTUGATE_FETCH_DATA_PLANS_URL =
  "https://api.vtugate.com/api/v1/fetchdataplans";

async function fetchCatalog(serviceId: string): Promise<unknown> {
  const apiKey = Deno.env.get("VTUGATE_API_KEY");
  if (!apiKey) throw new Error("Data-plan catalog is not configured.");

  const signal = AbortSignal.timeout(10_000);
  const response = await fetch(VTUGATE_FETCH_DATA_PLANS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ service_id: serviceId }),
    signal,
  });
  if (!response.ok) throw new Error("Data-plan catalog request failed.");
  return await response.json();
}

Deno.serve(createPurchaseDataHandler({
  authenticatedUser,
  adminClient,
  fetchCatalog,
  purchaseIntakeEnabled: false,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  readJson,
}));
