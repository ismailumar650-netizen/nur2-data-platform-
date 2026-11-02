begin;

create extension if not exists pgtap;

select plan(46);

create temporary table migration_test_context as
select
  gen_random_uuid() as user_one,
  gen_random_uuid() as user_two,
  gen_random_uuid() as missing_wallet_user;

insert into auth.users (id, aud, role, email, encrypted_password)
select
  user_one,
  'authenticated',
  'authenticated',
  'migration-' || user_one::text || '@example.invalid',
  ''
from migration_test_context
union all
select
  user_two,
  'authenticated',
  'authenticated',
  'migration-' || user_two::text || '@example.invalid',
  ''
from migration_test_context;

update public.wallets
set balance = 100
where user_id in (
  select user_one from migration_test_context
  union all
  select user_two from migration_test_context
);

select throws_ok(
  $$ select public.create_data_purchase_and_debit_idempotent(
       null::uuid, 'bad-key', 'bad-ref', 'svc', 'plan', 'Plan',
       '08000000000', 10
     ) $$,
  '22023',
  'Invalid data purchase details',
  'rejects invalid purchase arguments with the exact SQLSTATE and message'
);

select throws_ok(
  format(
    'select public.create_data_purchase_and_debit_idempotent(%L::uuid, %L, %L, %L, %L, %L, %L, %L)',
    (select missing_wallet_user from migration_test_context),
    'missing-wallet-key', 'missing-wallet-ref',
    'svc', 'plan', 'Plan', '08000000000', 10
  ),
  'P0001',
  'Wallet not found',
  'rejects a purchase without a wallet'
);

select throws_ok(
  format(
    'select public.create_data_purchase_and_debit_idempotent(%L::uuid, %L, %L, %L, %L, %L, %L, %L)',
    (select user_two from migration_test_context),
    'insufficient-key', 'insufficient-ref',
    'svc', 'plan', 'Plan', '08000000000', 101
  ),
  'P0001',
  'Insufficient wallet balance',
  'rejects an unaffordable purchase'
);

select throws_ok(
  $$ select * from public.claim_next_data_purchase(0) $$,
  '22023',
  'Invalid provider lease duration',
  'rejects an invalid submission lease duration'
);

create temporary table purchase_a as
select public.create_data_purchase_and_debit_idempotent(
  (select user_one from migration_test_context),
  'purchase-key-a',
  'purchase-ref-a',
  'svc',
  'plan-a',
  'Plan A',
  '08000000001',
  10
) as id;

create temporary table purchase_a_retry as
select public.create_data_purchase_and_debit_idempotent(
  (select user_one from migration_test_context),
  'purchase-key-a',
  'purchase-ref-a',
  'svc',
  'plan-a',
  'Plan A',
  '08000000001',
  10
) as id;

select is(
  (select id from purchase_a_retry),
  (select id from purchase_a),
  'an identical idempotent retry returns the original purchase'
);

select is(
  (
    select provider_work_state
    from public.data_purchases
    where id = (select id from purchase_a)
  ),
  'ready',
  'the idempotent purchase function explicitly sets ready'
);

select ok(
  (
    select client_reference is not null and length(client_reference) > 0
    from public.data_purchases
    where id = (select id from purchase_a)
  ),
  'a purchase persists its client reference before provider submission'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_one from migration_test_context)
  ),
  90::numeric,
  'an idempotent retry debits the wallet only once'
);

select throws_ok(
  format(
    'select public.create_data_purchase_and_debit_idempotent(%L::uuid, %L, %L, %L, %L, %L, %L, %L)',
    (select user_one from migration_test_context),
    'purchase-key-a',
    'purchase-ref-a',
    'svc',
    'different-plan',
    'Different Plan',
    '08000000001',
    10
  ),
  'P0001',
  'Idempotency key already used with different purchase details',
  'rejects an idempotency key reused with different purchase details'
);

-- Simulate a legacy insert that omits both new columns.
insert into public.data_purchases (
  user_id,
  wallet_id,
  reference,
  service_id,
  plan_code,
  plan_name,
  phone_number,
  amount,
  status
)
select
  wallet.user_id,
  wallet.id,
  'legacy-reference',
  'svc',
  'legacy-plan',
  'Legacy Plan',
  '08000000002',
  5,
  'pending'
from public.wallets as wallet
where wallet.user_id = (select user_one from migration_test_context);

select ok(
  (
    select provider_work_state = 'uncertain'
      and client_reference is null
    from public.data_purchases
    where reference = 'legacy-reference'
  ),
  'legacy purchases remain uncertain and receive no invented client reference'
);

create temporary table claim_a as
select * from public.claim_next_data_purchase(60);

select is(
  (select count(*)::integer from claim_a),
  1,
  'only the ready purchase is claimed for submission'
);

select is(
  (select provider_lease_action from claim_a),
  'submission',
  'the submission claim has the submission lease action'
);

select throws_ok(
  format(
    'select public.confirm_data_purchase_not_found(%L::uuid, %L::uuid)',
    (select id from claim_a),
    (select provider_lease_token from claim_a)
  ),
  'P0001',
  'Invalid or expired provider lease',
  'a submission lease cannot authorize a not-found confirmation'
);

select throws_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L, %L, %L)',
    (select id from claim_a),
    '00000000-0000-4000-8000-000000000999',
    'successful',
    null,
    null
  ),
  'P0001',
  'Invalid or expired provider lease',
  'rejects an outcome with the wrong lease token'
);

select lives_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L, %L, %L)',
    (select id from claim_a),
    (select provider_lease_token from claim_a),
    'successful',
    'vtug-transaction-a',
    'vtug-external-a'
  ),
  'accepts a successful outcome for the current lease'
);

select is(
  (
    select status
    from public.data_purchases
    where id = (select id from claim_a)
  ),
  'successful',
  'the successful outcome updates purchase status'
);

select is(
  (
    select provider_transaction_id
    from public.data_purchases
    where id = (select id from claim_a)
  ),
  'vtug-transaction-a',
  'the provider transaction ID is stored separately'
);

select is(
  (
    select provider_external_reference
    from public.data_purchases
    where id = (select id from claim_a)
  ),
  'vtug-external-a',
  'the provider external reference is stored separately'
);

select public.create_data_purchase_and_debit_idempotent(
  (select user_two from migration_test_context),
  'purchase-key-a',
  'purchase-ref-user-two',
  'svc',
  'plan-user-two',
  'User Two Plan',
  '08000000003',
  1
);

select is(
  (
    select count(*)::integer
    from public.data_purchases
    where idempotency_key = 'purchase-key-a'
  ),
  2,
  'the same idempotency key is independently allowed for another user'
);

update public.data_purchases
set provider_work_state = 'uncertain',
    client_reference = null
where reference = 'purchase-ref-user-two';

select ok(
  (
    select count(*) = 0
    from public.claim_next_data_purchase(60)
  )
  and (
    select provider_work_state = 'uncertain'
      and client_reference is null
    from public.data_purchases
    where reference = 'legacy-reference'
  ),
  'legacy purchases with no client reference cannot be submitted automatically'
);

select public.create_data_purchase_and_debit_idempotent(
  (select user_one from migration_test_context),
  'purchase-key-b',
  'purchase-ref-b',
  'svc',
  'plan-b',
  'Plan B',
  '08000000004',
  20
);

create temporary table claim_b as
select * from public.claim_next_data_purchase(60);

select is(
  (select count(*)::integer from claim_b),
  1,
  'a second ready purchase can be claimed'
);

select is(
  (select provider_lease_action from claim_b),
  'submission',
  'the second purchase is leased for submission'
);

select ok(
  (
    select client_reference is not null
    from claim_b
  ),
  'the claimed purchase carries its persisted client reference'
);

update public.data_purchases
set provider_lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from claim_b);

select is(
  (select count(*)::integer from public.claim_next_data_purchase(60)),
  0,
  'an expired submission lease is not automatically resubmitted'
);

select is(
  (
    select provider_work_state
    from public.data_purchases
    where id = (select id from claim_b)
  ),
  'reconciliation_required',
  'an expired lease moves to reconciliation_required'
);

create temporary table reconciliation_b as
select * from public.claim_next_data_purchase_reconciliation(60);

select is(
  (select count(*)::integer from reconciliation_b),
  1,
  'an expired submission can be claimed for status reconciliation'
);

select is(
  (select provider_lease_action from reconciliation_b),
  'reconciliation',
  'the reconciliation claim is distinct from a submission claim'
);

select is(
  (select client_reference from reconciliation_b),
  (select client_reference from claim_b),
  'reconciliation returns the same client reference for provider lookup'
);

select throws_ok(
  format(
    'select public.confirm_data_purchase_not_found(%L::uuid, %L::uuid)',
    (select id from reconciliation_b),
    '00000000-0000-4000-8000-000000000999'
  ),
  'P0001',
  'Invalid or expired provider lease',
  'rejects not-found confirmation with an invalid reconciliation token'
);

select lives_ok(
  format(
    'select public.confirm_data_purchase_not_found(%L::uuid, %L::uuid)',
    (select id from reconciliation_b),
    (select provider_lease_token from reconciliation_b)
  ),
  'accepts a not-found result under the active reconciliation lease'
);

select is(
  (
    select provider_work_state
    from public.data_purchases
    where id = (select id from reconciliation_b)
  ),
  'confirmed_not_found',
  'a confirmed not-found result enables a safe retry'
);

create temporary table retry_b as
select * from public.claim_next_data_purchase(60);

select is(
  (select count(*)::integer from retry_b),
  1,
  'a confirmed-not-found purchase can be submitted again'
);

select is(
  (select client_reference from retry_b),
  (select client_reference from claim_b),
  'submission retry reuses the original client reference'
);

select lives_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L, null, null)',
    (select id from retry_b),
    (select provider_lease_token from retry_b),
    'unknown'
  ),
  'accepts an unknown provider outcome'
);

select is(
  (
    select provider_work_state
    from public.data_purchases
    where id = (select id from retry_b)
  ),
  'reconciliation_required',
  'an unknown outcome requires reconciliation before another submission'
);

select is(
  (select count(*)::integer from public.claim_next_data_purchase(60)),
  0,
  'an unknown outcome is not automatically resubmitted'
);

create temporary table final_reconciliation_b as
select * from public.claim_next_data_purchase_reconciliation(60);

select is(
  (select count(*)::integer from final_reconciliation_b),
  1,
  'an unknown outcome can be claimed for reconciliation'
);

select is(
  (select provider_lease_action from final_reconciliation_b),
  'reconciliation',
  'the unknown outcome receives a reconciliation lease'
);

select lives_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L, %L, %L)',
    (select id from final_reconciliation_b),
    (select provider_lease_token from final_reconciliation_b),
    'failed',
    'vtug-transaction-b',
    'vtug-external-b'
  ),
  'accepts a conclusive failed result from reconciliation'
);

select is(
  (
    select status
    from public.data_purchases
    where id = (select id from final_reconciliation_b)
  ),
  'failed',
  'reconciliation records the failed purchase outcome'
);

create temporary table refund_results (id uuid);

insert into refund_results
select public.refund_failed_data_purchase((select id from final_reconciliation_b));

insert into refund_results
select public.refund_failed_data_purchase((select id from final_reconciliation_b));

select is(
  (select count(distinct id)::integer from refund_results),
  1,
  'repeated refunds return the same refund transaction'
);

select is(
  (
    select refunds_purchase_transaction_id
    from public.wallet_transactions
    where id = (select id from refund_results limit 1)
  ),
  (
    select wallet_transaction_id
    from public.data_purchases
    where id = (select id from final_reconciliation_b)
  ),
  'the refund transaction references the exact original purchase debit'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_one from migration_test_context)
  ),
  90::numeric,
  'the atomic refund credits the purchase amount exactly once'
);

select is(
  (
    select payment_status
    from public.wallet_transactions
    where id = (select id from refund_results limit 1)
  ),
  'successful',
  'the refund transaction is recorded as successful'
);

select throws_ok(
  format(
    'select public.refund_failed_data_purchase(%L::uuid)',
    (select id from claim_a)
  ),
  'P0001',
  'Purchase is not failed',
  'rejects a refund for a successful purchase'
);

select ok(
  (
    with signatures(signature) as (
      values
        ('public.create_data_purchase_and_debit(uuid,text,text,text,text,text,numeric)'),
        ('public.create_data_purchase_and_debit_idempotent(uuid,text,text,text,text,text,text,numeric)'),
        ('public.claim_next_data_purchase(integer)'),
        ('public.claim_next_data_purchase_reconciliation(integer)'),
        ('public.transition_data_purchase_outcome(uuid,uuid,text,text,text)'),
        ('public.confirm_data_purchase_not_found(uuid,uuid)'),
        ('public.refund_failed_data_purchase(uuid)')
    ),
    resolved as (
      select signature, to_regprocedure(signature) as function_oid
      from signatures
    )
    select count(*) = 7
      and bool_and(
        has_function_privilege('service_role', function_oid, 'EXECUTE')
        and not has_function_privilege('anon', function_oid, 'EXECUTE')
        and not has_function_privilege('authenticated', function_oid, 'EXECUTE')
      )
    from resolved
    where function_oid is not null
  )
  and not exists (
    select 1
    from (
      values
        ('public.create_data_purchase_and_debit(uuid,text,text,text,text,text,numeric)'),
        ('public.create_data_purchase_and_debit_idempotent(uuid,text,text,text,text,text,text,numeric)'),
        ('public.claim_next_data_purchase(integer)'),
        ('public.claim_next_data_purchase_reconciliation(integer)'),
        ('public.transition_data_purchase_outcome(uuid,uuid,text,text,text)'),
        ('public.confirm_data_purchase_not_found(uuid,uuid)'),
        ('public.refund_failed_data_purchase(uuid)')
    ) as signatures(signature)
    join pg_proc as procedure
      on procedure.oid = to_regprocedure(signatures.signature)
    cross join lateral aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) as privilege
    where privilege.grantee = '0'::oid
      and privilege.privilege_type = 'EXECUTE'
  ),
  'all privileged functions exist, are executable by service_role, and have no PUBLIC, anon, or authenticated execute grant'
);

select * from finish();
rollback;
