begin;

create extension if not exists pgtap;

select plan(26);

insert into auth.users (id, aud, role, email, encrypted_password)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'admin-members-user@example.invalid',
    ''
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'admin-members-target@example.invalid',
    ''
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'admin-members-delete@example.invalid',
    ''
  );

select set_config(
  'request.jwt.claim.sub',
  '99999999-9999-4999-8999-999999999999',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

set local role service_role;

insert into public.admin_members (user_id)
values ('22222222-2222-4222-8222-222222222222');

reset role;

select ok(
  not has_table_privilege(
    'authenticated',
    'public.admin_members',
    'select, insert, update, delete'
  )
  and not has_table_privilege(
    'authenticated',
    'public.admin_members_audit',
    'select, insert, update, delete'
  ),
  'authenticated has no privileges on membership or audit tables'
);

select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.admin_members'::regclass
  )
  and (
    select relrowsecurity
    from pg_class
    where oid = 'public.admin_members_audit'::regclass
  ),
  'RLS is enabled on both admin tables'
);

set local role authenticated;

select throws_ok(
  $$ insert into public.admin_members (user_id)
     values ('11111111-1111-4111-8111-111111111111') $$,
  '42501',
  'permission denied for table admin_members',
  'an authenticated user cannot grant themselves admin membership'
);

select throws_ok(
  $$ delete from public.admin_members
     where user_id = '22222222-2222-4222-8222-222222222222' $$,
  '42501',
  'permission denied for table admin_members',
  'an authenticated user cannot revoke admin membership'
);

select throws_ok(
  $$ select user_id from public.admin_members
     where user_id = '22222222-2222-4222-8222-222222222222' $$,
  '42501',
  'permission denied for table admin_members',
  'an authenticated user cannot read admin membership'
);

select throws_ok(
  $$ insert into public.admin_members_audit (target_user_id, action)
     values ('11111111-1111-4111-8111-111111111111', 'grant') $$,
  '42501',
  'permission denied for table admin_members_audit',
  'an authenticated user cannot insert audit records'
);

select throws_ok(
  $$ update public.admin_members_audit
     set action = 'revoke' $$,
  '42501',
  'permission denied for table admin_members_audit',
  'an authenticated user cannot update audit records'
);

select throws_ok(
  $$ delete from public.admin_members_audit $$,
  '42501',
  'permission denied for table admin_members_audit',
  'an authenticated user cannot delete audit records'
);

select throws_ok(
  $$ select public.audit_admin_membership_change() $$,
  '42501',
  'permission denied for function audit_admin_membership_change',
  'an authenticated user cannot directly execute the membership trigger function'
);

reset role;

set local role anon;

select throws_ok(
  $$ select user_id from public.admin_members $$,
  '42501',
  'permission denied for table admin_members',
  'anon cannot read admin membership'
);

select throws_ok(
  $$ insert into public.admin_members (user_id)
     values ('11111111-1111-4111-8111-111111111111') $$,
  '42501',
  'permission denied for table admin_members',
  'anon cannot modify admin membership'
);

select throws_ok(
  $$ select target_user_id from public.admin_members_audit $$,
  '42501',
  'permission denied for table admin_members_audit',
  'anon cannot read admin membership audit records'
);

select throws_ok(
  $$ insert into public.admin_members_audit (target_user_id, action)
     values ('11111111-1111-4111-8111-111111111111', 'grant') $$,
  '42501',
  'permission denied for table admin_members_audit',
  'anon cannot modify admin membership audit records'
);

select throws_ok(
  $$ select public.audit_admin_membership_change() $$,
  '42501',
  'permission denied for function audit_admin_membership_change',
  'anon cannot directly execute the membership trigger function'
);

reset role;

set local role service_role;

select is(
  (
    select count(*)::integer
    from public.admin_members
    where user_id = '22222222-2222-4222-8222-222222222222'
  ),
  1,
  'service_role can read admin membership'
);

delete from public.admin_members
where user_id = '22222222-2222-4222-8222-222222222222';

select is(
  (
    select count(*)::integer
    from public.admin_members
    where user_id = '22222222-2222-4222-8222-222222222222'
  ),
  0,
  'service_role can revoke admin membership'
);

insert into public.admin_members (user_id)
values ('33333333-3333-4333-8333-333333333333');

select throws_ok(
  $$ insert into public.admin_members_audit (target_user_id, action)
     values ('11111111-1111-4111-8111-111111111111', 'grant') $$,
  '42501',
  'permission denied for table admin_members_audit',
  'service_role cannot write audit records outside the membership trigger'
);

select throws_ok(
  $$ update public.admin_members_audit
     set action = 'revoke' $$,
  '42501',
  'permission denied for table admin_members_audit',
  'service_role cannot update audit records'
);

select throws_ok(
  $$ delete from public.admin_members_audit $$,
  '42501',
  'permission denied for table admin_members_audit',
  'service_role cannot delete audit records'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.admin_members_audit
    where target_user_id = '22222222-2222-4222-8222-222222222222'
      and action in ('grant', 'revoke')
      and created_at is not null
  ),
  2,
  'grant and revoke operations create timestamped audit records'
);

select is(
  (
    select actor_identifier
    from public.admin_members_audit
    where target_user_id = '22222222-2222-4222-8222-222222222222'
      and action = 'grant'
  ),
  null,
  'service_role grant records do not trust a supplied administrator claim'
);

select is(
  (
    select actor_identifier
    from public.admin_members_audit
    where target_user_id = '22222222-2222-4222-8222-222222222222'
      and action = 'revoke'
  ),
  null,
  'service_role revoke records do not trust a supplied administrator claim'
);

reset role;

delete from auth.users
where id = '33333333-3333-4333-8333-333333333333';

select is(
  (
    select count(*)::integer
    from public.admin_members
    where user_id = '33333333-3333-4333-8333-333333333333'
  ),
  0,
  'deleting an auth user cascades to admin membership'
);

select is(
  (
    select count(*)::integer
    from public.admin_members_audit
    where target_user_id = '33333333-3333-4333-8333-333333333333'
      and action = 'grant'
  ),
  1,
  'the audit record is retained after its target auth user is deleted'
);

select is(
  (
    select count(*)::integer
    from public.admin_members_audit
    where target_user_id = '33333333-3333-4333-8333-333333333333'
      and action = 'revoke'
      and actor_identifier is null
  ),
  1,
  'auth-user cascade creates exactly one surviving revoke audit event'
);

select is(
  (
    select count(*)::integer
    from public.admin_members_audit
    where target_user_id = '22222222-2222-4222-8222-222222222222'
      and action = 'grant'
  ),
  1,
  'service_role can grant admin membership'
);

select * from finish();

rollback;
