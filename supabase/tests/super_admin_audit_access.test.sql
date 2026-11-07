begin;

create extension if not exists pgtap;

select plan(13);

select ok(
  not has_table_privilege('anon', 'public.super_admin_audit', 'SELECT'),
  'anon cannot read super admin audit'
);
select ok(
  not has_table_privilege('anon', 'public.super_admin_audit', 'INSERT'),
  'anon cannot insert super admin audit'
);
select ok(
  not has_table_privilege('anon', 'public.super_admin_audit', 'UPDATE'),
  'anon cannot update super admin audit'
);
select ok(
  not has_table_privilege('anon', 'public.super_admin_audit', 'DELETE'),
  'anon cannot delete super admin audit'
);

select ok(
  not has_table_privilege('authenticated', 'public.super_admin_audit', 'SELECT'),
  'authenticated cannot read super admin audit directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.super_admin_audit', 'INSERT'),
  'authenticated cannot insert super admin audit directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.super_admin_audit', 'UPDATE'),
  'authenticated cannot update super admin audit'
);
select ok(
  not has_table_privilege('authenticated', 'public.super_admin_audit', 'DELETE'),
  'authenticated cannot delete super admin audit'
);

select ok(
  has_table_privilege('service_role', 'public.super_admin_audit', 'SELECT'),
  'service_role can read audit through trusted backend'
);
select ok(
  has_table_privilege('service_role', 'public.super_admin_audit', 'INSERT'),
  'service_role can insert audit through trusted backend'
);
select ok(
  not has_table_privilege('service_role', 'public.super_admin_audit', 'UPDATE'),
  'service_role cannot update existing audit records'
);
select ok(
  not has_table_privilege('service_role', 'public.super_admin_audit', 'DELETE'),
  'service_role cannot delete audit records'
);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'public.super_admin_audit'::regclass),
  'RLS is enabled on super admin audit'
);

select * from finish();
rollback;
