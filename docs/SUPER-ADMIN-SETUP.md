# NUR2 DATA Super Admin control plane (initial backend implementation)

## Security model
- The first Super Admin is selected only by the Edge Function secret `NUR2_SUPER_ADMIN_USER_ID`.
- The UUID is not embedded in browser code or committed as a secret.
- Every request also requires a valid Supabase Auth JWT. The function compares the authenticated user ID with the configured owner UUID before using the service-role client.
- Only the allowlisted owner can list admins, grant/revoke admin membership, and read the Super Admin audit log.
- Admin changes are recorded in `public.super_admin_audit` with actor and target UUIDs.
- The owner cannot be changed through ordinary admin grant/revoke actions.

## Required deployment steps
1. Apply the migration `20261106190000_super_admin_audit.sql` to the intended Supabase project.
2. Set the Edge Function secret `NUR2_SUPER_ADMIN_USER_ID` to the owner's Supabase Auth user UUID using Supabase Dashboard or `supabase secrets set`. Do not place the service-role key in frontend files or commit it.
3. Deploy the `super-admin-control` Edge Function.
4. Test using the owner account and a separate non-owner account. The non-owner must receive HTTP 403. Test grant, list, revoke, and audit log with a disposable test user before production use.

## Scope and limitations
This is the secure backend foundation for administrator membership and its audit trail. It does not yet implement user suspension, wallet/deposit/withdrawal controls, financial adjustments, emergency shutdown, or a Super Admin dashboard UI. Those high-impact controls must be designed with separate authorization, confirmation, idempotency, and audit protections. Existing data purchases and worker remain disabled until the verified VTUGate contract is implemented and tested end-to-end.
