import { authenticatedUser, adminClient, jsonResponse, optionsResponse, readJson } from "../_shared/paystack.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cors = (response: Response) => {
  response.headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return response;
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return cors(optionsResponse());
  if (request.method !== "POST") return cors(jsonResponse({ error: "Method not allowed." }, 405));

  try {
    const user = await authenticatedUser(request);
    if (!user) return cors(jsonResponse({ error: "Authentication required." }, 401));
    const ownerId = Deno.env.get("NUR2_SUPER_ADMIN_USER_ID");
    if (!ownerId || !UUID.test(ownerId)) return cors(jsonResponse({ error: "Super Admin is not configured." }, 503));
    if (user.id !== ownerId) return cors(jsonResponse({ error: "Super Admin access required." }, 403));

    const body = await readJson(request);
    if (!body || typeof body.action !== "string") return cors(jsonResponse({ error: "Invalid request." }, 400));
    const client = adminClient();

    if (body.action === "list_admins") {
      const { data, error } = await client.from("admin_members").select("user_id, created_at").order("created_at", { ascending: true });
      if (error) return cors(jsonResponse({ error: "Unable to list administrators." }, 500));
      return cors(jsonResponse({ admins: data ?? [] }));
    }

    if ((body.action === "grant_admin" || body.action === "revoke_admin") && typeof body.target_user_id === "string" && UUID.test(body.target_user_id)) {
      const target = body.target_user_id;
      if (target === ownerId) return cors(jsonResponse({ error: "The Super Admin cannot be changed through admin membership actions." }, 400));
      const { data: targetUser, error: userError } = await client.auth.admin.getUserById(target);
      if (userError || !targetUser.user) return cors(jsonResponse({ error: "Target user was not found." }, 404));

      if (body.action === "grant_admin") {
        const { error } = await client.from("admin_members").upsert({ user_id: target }, { onConflict: "user_id", ignoreDuplicates: true });
        if (error) return cors(jsonResponse({ error: "Unable to grant admin access." }, 500));
      } else {
        const { error } = await client.from("admin_members").delete().eq("user_id", target);
        if (error) return cors(jsonResponse({ error: "Unable to revoke admin access." }, 500));
      }

      const { error: auditError } = await client.from("super_admin_audit").insert({
        actor_user_id: user.id,
        target_user_id: target,
        action: body.action,
      });
      if (auditError) return cors(jsonResponse({ error: "Membership changed, but audit recording failed. Review audit immediately." }, 500));
      return cors(jsonResponse({ success: true, action: body.action, target_user_id: target }));
    }

    if (body.action === "audit_log") {
      const { data, error } = await client.from("super_admin_audit").select("id, actor_user_id, target_user_id, action, created_at").order("created_at", { ascending: false }).limit(100);
      if (error) return cors(jsonResponse({ error: "Unable to load audit log." }, 500));
      return cors(jsonResponse({ audit: data ?? [] }));
    }
    return cors(jsonResponse({ error: "Unsupported action or invalid target user ID." }, 400));
  } catch {
    return cors(jsonResponse({ error: "Super Admin service is temporarily unavailable." }, 500));
  }
});
