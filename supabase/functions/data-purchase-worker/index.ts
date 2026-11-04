import { adminClient } from "../_shared/paystack.ts";
import {
  createDataPurchaseWorker,
  isServiceRoleRequest,
} from "./handler.ts";

Deno.serve(createDataPurchaseWorker({
  workerEnabled: false,
  authorizeWorker: (request) => {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) throw new Error("Worker authorization is not configured.");
    return isServiceRoleRequest(request, serviceRoleKey);
  },
  adminClient,
}));
