-- Super Admin actions are audited separately from the existing admin membership trigger.
-- The allowlisted Super Admin identity is configured only as an Edge Function secret.
create table if not exists public.super_admin_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('grant_admin', 'revoke_admin')),
  created_at timestamptz not null default now()
);

alter table public.super_admin_audit enable row level security;
revoke all on table public.super_admin_audit from public, anon, authenticated, service_role;
-- Access is intentionally restricted to the service-role Edge Function.
grant select, insert on table public.super_admin_audit to service_role;
