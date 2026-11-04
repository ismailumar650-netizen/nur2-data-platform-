import { authenticatedUser } from "../_shared/paystack.ts";
import { createFetchDataPlansHandler } from "./handler.ts";

Deno.serve(createFetchDataPlansHandler({
  authenticatedUser,
  apiKey: Deno.env.get("VTUGATE_API_KEY"),
}));
