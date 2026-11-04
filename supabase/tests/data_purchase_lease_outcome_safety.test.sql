begin;

create extension if not exists pgtap;

select plan(17);

create temporary table lease_outcome_test_context as
select gen_random_uuid() as user_id;

insert into auth.users (id, aud, role, email, encrypted_password)
select
  user_id,
  'authenticated',
  'authenticated',
  'lease-outcome-' || user_id::text || '@example.invalid',
  ''
from lease_outcome_test_context;

update public.wallets
set balance = 100
where user_id = (select user_id from lease_outcome_test_context);

create temporary table valid_outcome_cases as
select
  row_number() over ()::integer as case_id,
  cases.lease_action,
  cases.initial_status,
  cases.outcome,
  public.create_data_purchase_and_debit_idempotent(
    (select user_id from lease_outcome_test_context),
    'lease-outcome-key-' || cases.lease_action || '-' || cases.initial_status || '-' || cases.outcome,
    'lease-outcome-reference-' || cases.lease_action || '-' || cases.initial_status || '-' || cases.outcome,
    'service',
    'plan-' || cases.lease_action || '-' || cases.initial_status || '-' || cases.outcome,
    'Lease outcome test plan',
    '+2348012345678',
    1
  ) as purchase_id
from (
  select 'submission'::text as lease_action, 'pending'::text as initial_status, outcome
  from unnest(array['successful', 'failed', 'still_processing', 'unknown']) as outcome
  union all
  select 'reconciliation', 'pending', outcome
  from unnest(array['successful', 'failed', 'still_processing', 'unknown']) as outcome
  union all
  select 'reconciliation', 'unknown', outcome
  from unnest(array['successful', 'failed', 'still_processing', 'unknown']) as outcome
) as cases;

update public.data_purchases as purchase
set status = test_case.initial_status,
    provider_work_state = 'leased',
    provider_lease_token = gen_random_uuid(),
    provider_lease_expires_at = clock_timestamp() + interval '60 seconds',
    provider_lease_action = test_case.lease_action
from valid_outcome_cases as test_case
where purchase.id = test_case.purchase_id;

create temporary table valid_outcome_leases as
select
  test_case.case_id,
  test_case.lease_action,
  test_case.initial_status,
  test_case.outcome,
  purchase.id as purchase_id,
  purchase.provider_lease_token as lease_token
from valid_outcome_cases as test_case
join public.data_purchases as purchase
  on purchase.id = test_case.purchase_id;

select lives_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L)',
    purchase_id,
    lease_token,
    outcome
  ),
  format(
    'accepts %s outcome under %s lease starting %s',
    outcome,
    lease_action,
    initial_status
  )
)
from valid_outcome_leases
order by case_id;

create temporary table rejected_outcome_cases as
select
  row_number() over ()::integer as case_id,
  cases.lease_action,
  cases.initial_status,
  public.create_data_purchase_and_debit_idempotent(
    (select user_id from lease_outcome_test_context),
    'lease-outcome-reject-key-' || cases.lease_action || '-' || cases.initial_status,
    'lease-outcome-reject-reference-' || cases.lease_action || '-' || cases.initial_status,
    'service',
    'plan-reject-' || cases.lease_action || '-' || cases.initial_status,
    'Lease outcome rejection test plan',
    '+2348012345678',
    1
  ) as purchase_id
from (
  values
    ('submission'::text, 'unknown'::text),
    ('reconciliation', 'successful'),
    ('reconciliation', 'failed')
) as cases(lease_action, initial_status);

update public.data_purchases as purchase
set status = test_case.initial_status,
    provider_work_state = 'leased',
    provider_lease_token = gen_random_uuid(),
    provider_lease_expires_at = clock_timestamp() + interval '60 seconds',
    provider_lease_action = test_case.lease_action
from rejected_outcome_cases as test_case
where purchase.id = test_case.purchase_id;

create temporary table rejected_outcome_leases as
select
  test_case.case_id,
  test_case.lease_action,
  test_case.initial_status,
  purchase.id as purchase_id,
  purchase.provider_lease_token as lease_token
from rejected_outcome_cases as test_case
join public.data_purchases as purchase
  on purchase.id = test_case.purchase_id;

select throws_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L)',
    purchase_id,
    lease_token,
    'successful'
  ),
  'P0001',
  'Purchase status is invalid for provider lease action',
  format(
    'rejects %s purchase status under %s lease',
    initial_status,
    lease_action
  )
)
from rejected_outcome_leases
order by case_id;

select ok(
  not exists (
    select 1
    from rejected_outcome_leases as lease
    join public.data_purchases as purchase
      on purchase.id = lease.purchase_id
    where purchase.status <> lease.initial_status
      or purchase.provider_work_state <> 'leased'
      or purchase.provider_lease_token is distinct from lease.lease_token
  ),
  'rejected transitions preserve purchase state and the active lease'
);

select ok(
  not exists (
    select 1
    from rejected_outcome_leases as lease
    join public.data_purchases as purchase
      on purchase.id = lease.purchase_id
    join public.wallet_transactions as transaction
      on transaction.id = purchase.wallet_transaction_id
    where transaction.payment_status <> 'pending'
  ),
  'rejected transitions leave wallet debit status unchanged'
);

select * from finish();

rollback;
