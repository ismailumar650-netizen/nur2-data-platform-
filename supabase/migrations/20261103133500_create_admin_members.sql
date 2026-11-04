create table public.admin_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_members enable row level security;

revoke all on table public.admin_members
  from public, anon, authenticated, service_role;
grant select, insert, delete on table public.admin_members to service_role;

create table public.admin_members_audit (
  id bigint generated always as identity primary key,
  target_user_id uuid not null,
  action text not null check (action in ('grant', 'revoke')),
  actor_identifier text,
  created_at timestamptz not null default now()
);

alter table public.admin_members_audit enable row level security;

revoke all on table public.admin_members_audit
  from public, anon, authenticated, service_role;

create function public.audit_admin_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text;
begin
  actor_id := case
    when auth.role() = 'authenticated' then auth.uid()::text
    else null
  end;

  if tg_op = 'INSERT' then
    insert into public.admin_members_audit (
      target_user_id,
      action,
      actor_identifier
    )
    values (
      new.user_id,
      'grant',
      actor_id
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.admin_members_audit (
      target_user_id,
      action,
      actor_identifier
    )
    values (
      old.user_id,
      'revoke',
      actor_id
    );
    return old;
  end if;

  raise exception 'Unsupported admin membership operation';
end;
$$;

revoke all on function public.audit_admin_membership_change()
  from public, anon, authenticated, service_role;

create trigger admin_members_audit_insert
  after insert on public.admin_members
  for each row
  execute function public.audit_admin_membership_change();

create trigger admin_members_audit_delete
  after delete on public.admin_members
  for each row
  execute function public.audit_admin_membership_change();
