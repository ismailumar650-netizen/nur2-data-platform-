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
import { createVerifyWalletFundingHandler } from "./handler.ts";

Deno.serve(createVerifyWalletFundingHandler({
  authenticatedUser,
  adminClient,
  isJsonRequest,
  jsonResponse,
  optionsResponse,
  readJson,
  paystackTestKey,
  validReference,
}));
