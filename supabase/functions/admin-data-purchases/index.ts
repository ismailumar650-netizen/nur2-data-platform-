import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";
import { adminClient } from "../_shared/paystack.ts";
import { createAuthenticatedAdminUser } from "./auth.ts";
import { createAdminDataPurchasesHandler } from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function optionsResponse(): Response {
  return new Response(null, { headers: corsHeaders });
}

const authenticatedAdminUser = createAuthenticatedAdminUser(
  createClient,
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_ANON_KEY"),
);

Deno.serve(createAdminDataPurchasesHandler({
  authenticatedUser: authenticatedAdminUser,
  adminClient,
  jsonResponse,
  optionsResponse,
}));
