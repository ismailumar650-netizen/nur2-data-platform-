import {
  adminClient,
  authenticatedUser,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  paystackTestKey,
  readJson,
} from "../_shared/paystack.ts";
import { createInitializeWalletFundingHandler } from "./handler.ts";

Deno.serve(createInitializeWalletFundingHandler({
  authenticatedUser,
  adminClient,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  readJson,
  paystackTestKey,
  callbackUrl: Deno.env.get("PAYSTACK_CALLBACK_URL"),
}));
