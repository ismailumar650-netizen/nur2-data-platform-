begin;

create extension if not exists pgtap;

select plan(44);

create temporary table settlement_test_context as
select gen_random_uuid() as user_id;

insert into auth.users (id, aud, role, email, encrypted_password)
select
  user_id,
  'authenticated',
  'authenticated',
  'settlement-' || user_id::text || '@example.invalid',
  ''
from settlement_test_context;

update public.wallets
set balance = 100
where user_id = (select user_id from settlement_test_context);

create temporary table processing_purchase as
select public.create_data_purchase_and_debit_idempotent(
  (select user_id from settlement_test_context),
  'processing-key',
  'processing-reference',
  'service',
  'plan-processing',
  'Processing plan',
  '+2348012345678',
  10
) as id;

create temporary table processing_submission as
select * from public.claim_next_data_purchase(60);

select lives_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L)',
    (select id from processing_submission),
    (select provider_lease_token from processing_submission),
    'still_processing'
  ),
  'records a still-processing provider result'
);

select is(
  (select provider_work_state
   from public.data_purchases
   where id = (select id from processing_purchase)),
  'still_processing',
  'still-processing purchases have a distinct work state'
);

select is(
  (select status
   from public.data_purchases
   where id = (select id from processing_purchase)),
  'pending',
  'still-processing purchases remain pending for the customer'
);

select is(
  (select count(*)::integer from public.claim_next_data_purchase(60)),
  0,
  'still-processing purchases cannot be claimed for submission'
);

create temporary table processing_reconciliation as
select * from public.claim_next_data_purchase_reconciliation(60);

select is(
  (select count(*)::integer from processing_reconciliation),
  1,
  'still-processing purchases can be claimed for reconciliation'
);

select is(
  (select provider_lease_action from processing_reconciliation),
  'reconciliation',
  'still-processing gets a reconciliation lease, not a submission lease'
);

select is(
  (select client_reference from processing_reconciliation),
  (select client_reference
   from public.data_purchases
   where id = (select id from processing_purchase)),
  'processing reconciliation retains the original client reference'
);

select is(
  (select reference from processing_reconciliation),
  (select reference
   from public.data_purchases
   where id = (select id from processing_purchase)),
  'processing reconciliation retains the original NUR2 reference'
);

create temporary table not_found_purchase as
select public.create_data_purchase_and_debit_idempotent(
  (select user_id from settlement_test_context),
  'not-found-key',
  'not-found-reference',
  'service',
  'plan-not-found',
  'Not-found plan',
  '+2348012345678',
  10
) as id;

create temporary table not_found_submission as
select * from public.claim_next_data_purchase(60);

select is(
  (select id from not_found_submission),
  (select id from not_found_purchase),
  'a separate ready purchase remains eligible for submission'
);

update public.data_purchases
set provider_lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from not_found_purchase);

select is(
  (select count(*)::integer from public.claim_next_data_purchase(60)),
  0,
  'an expired submission lease is not retried before reconciliation'
);

select is(
  (select provider_work_state from public.data_purchases
   where id = (select id from not_found_purchase)),
  'reconciliation_required',
  'an expired submission moves to reconciliation'
);

create temporary table not_found_reconciliation as
select * from public.claim_next_data_purchase_reconciliation(60);

select is(
  (select count(*)::integer from not_found_reconciliation),
  1,
  'the expired purchase is claimed for reconciliation'
);

create temporary table not_found_hardening_snapshot as
select
  purchase.id,
  purchase.status,
  purchase.reference,
  purchase.client_reference,
  purchase.amount,
  purchase.provider_work_state,
  purchase.provider_lease_action,
  purchase.provider_lease_token,
  purchase.provider_lease_expires_at,
  transaction.id as debit_id,
  transaction.payment_status as debit_status,
  transaction.amount as debit_amount,
  transaction.transaction_type as debit_type,
  transaction.wallet_id as debit_wallet_id,
  transaction.user_id as debit_user_id,
  transaction.refunds_purchase_transaction_id as debit_refund_source,
  wallet.balance,
  (
    select count(*)::integer
    from public.wallet_transactions as refund
    where refund.refunds_purchase_transaction_id = transaction.id
  ) as refund_count
from public.data_purchases as purchase
join public.wallet_transactions as transaction
  on transaction.id = purchase.wallet_transaction_id
join public.wallets as wallet
  on wallet.id = purchase.wallet_id
where purchase.id = (select id from not_found_reconciliation);

select ok(
  not has_function_privilege(
    'service_role',
    'public.confirm_data_purchase_not_found(uuid,uuid)',
    'EXECUTE'
  ),
  'service_role cannot execute unverified not-found confirmation'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.confirm_data_purchase_not_found(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.confirm_data_purchase_not_found(uuid,uuid)',
    'EXECUTE'
  )
  and not exists (
    select 1
    from pg_proc as procedure
    cross join lateral aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) as privilege
    where procedure.oid =
      'public.confirm_data_purchase_not_found(uuid,uuid)'::regprocedure
      and privilege.grantee = '0'::oid
      and privilege.privilege_type = 'EXECUTE'
  ),
  'anon, authenticated, and PUBLIC cannot execute unverified not-found confirmation'
);

select ok(
  position(
    'provider_lease_action is distinct from ''reconciliation'''
    in lower(pg_get_functiondef(
      'public.confirm_data_purchase_not_found(uuid,uuid)'::regprocedure
    ))
  ) > 0,
  'not-found confirmation explicitly rejects NULL and unexpected lease actions'
);

select throws_ok(
  format(
    'update public.data_purchases set provider_lease_action = null where id = %L::uuid',
    (select id from not_found_reconciliation)
  ),
  '23514',
  null,
  'rejects a NULL action on a leased purchase'
);

select throws_ok(
  format(
    'update public.data_purchases set provider_lease_action = %L where id = %L::uuid',
    'unexpected',
    (select id from not_found_reconciliation)
  ),
  '23514',
  null,
  'rejects an unexpected action on a leased purchase'
);

select ok(
  exists (
    select 1
    from not_found_hardening_snapshot as before
    join public.data_purchases as purchase on purchase.id = before.id
    join public.wallet_transactions as transaction on transaction.id = before.debit_id
    join public.wallets as wallet on wallet.id = purchase.wallet_id
    where purchase.status is not distinct from before.status
      and purchase.reference is not distinct from before.reference
      and purchase.client_reference is not distinct from before.client_reference
      and purchase.amount is not distinct from before.amount
      and purchase.provider_work_state is not distinct from before.provider_work_state
      and purchase.provider_lease_action is not distinct from before.provider_lease_action
      and purchase.provider_lease_token is not distinct from before.provider_lease_token
      and purchase.provider_lease_expires_at is not distinct from before.provider_lease_expires_at
      and transaction.payment_status is not distinct from before.debit_status
      and transaction.amount is not distinct from before.debit_amount
      and transaction.transaction_type is not distinct from before.debit_type
      and transaction.wallet_id is not distinct from before.debit_wallet_id
      and transaction.user_id is not distinct from before.debit_user_id
      and transaction.refunds_purchase_transaction_id is not distinct from before.debit_refund_source
      and wallet.balance is not distinct from before.balance
      and (
        select count(*)::integer
        from public.wallet_transactions as refund
        where refund.refunds_purchase_transaction_id = transaction.id
      ) = before.refund_count
  ),
  'privilege checks and rejected invalid actions preserve lease, purchase, debit, wallet, and refund records'
);

update public.data_purchases
set status = 'pending',
    provider_work_state = 'confirmed_not_found',
    provider_lease_token = null,
    provider_lease_expires_at = null,
    provider_lease_action = null
where id = (select id from not_found_reconciliation);

select is(
  (select count(*)::integer from public.claim_next_data_purchase(60)),
  0,
  'a legacy confirmed-not-found purchase cannot be submitted again'
);

create temporary table wallet_balance_before_unknown as
select balance
from public.wallets
where user_id = (select user_id from settlement_test_context);

create temporary table unknown_purchase as
select public.create_data_purchase_and_debit_idempotent(
  (select user_id from settlement_test_context),
  'unknown-key',
  'unknown-reference',
  'service',
  'plan-unknown',
  'Unknown plan',
  '+2348012345678',
  10
) as id;

create temporary table unknown_submission as
select * from public.claim_next_data_purchase(60);

select is(
  (select id from unknown_submission),
  (select id from unknown_purchase),
  'ambiguous-outcome test purchase receives one submission lease'
);

select lives_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L)',
    (select id from unknown_submission),
    (select provider_lease_token from unknown_submission),
    'unknown'
  ),
  'an ambiguous unknown outcome is recorded without provider response assumptions'
);

select ok(
  (
    select purchase.status = 'unknown'
      and purchase.provider_work_state = 'reconciliation_required'
    from public.data_purchases as purchase
    where purchase.id = (select id from unknown_purchase)
  ),
  'an ambiguous result remains unresolved for reconciliation'
);

select ok(
  (
    select transaction.payment_status = 'pending'
    from public.data_purchases as purchase
    join public.wallet_transactions as transaction
      on transaction.id = purchase.wallet_transaction_id
    where purchase.id = (select id from unknown_purchase)
  )
  and not exists (
    select 1
    from public.wallet_transactions as refund
    join public.data_purchases as purchase
      on purchase.wallet_transaction_id = refund.refunds_purchase_transaction_id
    where purchase.id = (select id from unknown_purchase)
      and refund.transaction_type = 'refund'
  ),
  'an unknown outcome leaves the debit pending and issues no refund'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_id from settlement_test_context)
  ),
  (
    select balance_before.balance - purchase.amount
    from wallet_balance_before_unknown as balance_before
    cross join public.data_purchases as purchase
    where purchase.id = (select id from unknown_purchase)
  ),
  'an unknown outcome leaves the wallet at its post-debit balance'
);

select is(
  (select count(*)::integer from public.claim_next_data_purchase(60)),
  0,
  'an unknown outcome cannot be automatically resubmitted'
);

create temporary table unknown_reconciliation as
select * from public.claim_next_data_purchase_reconciliation(60);

select is(
  (select id from unknown_reconciliation),
  (select id from unknown_purchase),
  'an unknown outcome is routed to reconciliation'
);

select is(
  (select client_reference from unknown_reconciliation),
  (select client_reference from unknown_submission),
  'unknown-outcome reconciliation preserves the original client_reference'
);

select is(
  (select reference from unknown_reconciliation),
  (select reference from unknown_submission),
  'unknown-outcome reconciliation preserves the original NUR2 reference'
);

create temporary table failed_purchase as
select public.create_data_purchase_and_debit_idempotent(
  (select user_id from settlement_test_context),
  'failed-key',
  'failed-reference',
  'service',
  'plan-failed',
  'Failed plan',
  '+2348012345678',
  10
) as id;

create temporary table failed_submission as
select * from public.claim_next_data_purchase(60);

select is(
  (select id from failed_submission),
  (select id from failed_purchase),
  'failed-outcome test purchase receives a submission lease'
);

create function public.test_reject_data_purchase_refund_credit()
returns trigger
language plpgsql
as $$
begin
  if new.balance > old.balance then
    raise exception using
      errcode = 'P0001',
      message = 'Simulated refund credit failure';
  end if;
  return new;
end;
$$;

create trigger test_reject_data_purchase_refund_credit
before update on public.wallets
for each row
execute function public.test_reject_data_purchase_refund_credit();

select throws_ok(
  format(
    'select public.transition_data_purchase_outcome(%L::uuid, %L::uuid, %L)',
    (select id from failed_submission),
    (select provider_lease_token from failed_submission),
    'failed'
  ),
  'P0001',
  'Simulated refund credit failure',
  'a refund-credit failure aborts the entire failed settlement'
);

select is(
  (select status from public.data_purchases
   where id = (select id from failed_purchase)),
  'pending',
  'rollback preserves the pending purchase status'
);

select is(
  (select payment_status from public.wallet_transactions
   where id = (select wallet_transaction_id from public.data_purchases
               where id = (select id from failed_purchase))),
  'pending',
  'rollback preserves the pending purchase debit status'
);

select is(
  (select balance from public.wallets
   where user_id = (select user_id from settlement_test_context)),
  60::numeric,
  'rollback leaves all three original purchase debits and no refund credit'
);

select is(
  (select count(*)::integer from public.wallet_transactions
   where refunds_purchase_transaction_id =
     (select wallet_transaction_id from public.data_purchases
      where id = (select id from failed_purchase))),
  0,
  'rollback leaves no partial refund transaction'
);

select is(
  (select provider_work_state from public.data_purchases
   where id = (select id from failed_purchase)),
  (select provider_work_state from failed_submission),
  'rollback preserves the original submission lease state'
);

select is(
  (select provider_lease_token from public.data_purchases
   where id = (select id from failed_purchase)),
  (select provider_lease_token from failed_submission),
  'rollback preserves the original submission lease token'
);

drop trigger test_reject_data_purchase_refund_credit on public.wallets;
drop function public.test_reject_data_purchase_refund_credit();

create temporary table failed_settlement as
select public.transition_data_purchase_outcome(
  (select id from failed_submission),
  (select provider_lease_token from failed_submission),
  'failed'
) as outcome;

select is(
  (select status from public.data_purchases
   where id = (select id from failed_purchase)),
  'failed',
  'atomic settlement records the final failed status'
);

select is(
  (select provider_work_state from public.data_purchases
   where id = (select id from failed_purchase)),
  'complete',
  'atomic settlement completes provider work'
);

select is(
  (select payment_status from public.wallet_transactions
   where id = (select wallet_transaction_id from public.data_purchases
               where id = (select id from failed_purchase))),
  'failed',
  'atomic settlement marks the original debit failed'
);

select is(
  (select balance from public.wallets
   where user_id = (select user_id from settlement_test_context)),
  70::numeric,
  'atomic settlement restores the failed purchase amount once'
);

select is(
  (select count(*)::integer from public.wallet_transactions
   where refunds_purchase_transaction_id =
     (select wallet_transaction_id from public.data_purchases
      where id = (select id from failed_purchase))),
  1,
  'atomic settlement creates one linked refund'
);

select is(
  (select outcome from failed_settlement),
  'failed',
  'the failed outcome is returned after its refund commits'
);

select is(
  public.refund_failed_data_purchase((select id from failed_purchase)),
  (select id from public.wallet_transactions
   where refunds_purchase_transaction_id =
     (select wallet_transaction_id from public.data_purchases
      where id = (select id from failed_purchase))),
  'repeated refund returns the existing linked refund'
);

select is(
  (select balance from public.wallets
   where user_id = (select user_id from settlement_test_context)),
  70::numeric,
  'repeated refund does not credit the wallet again'
);

select * from finish();
rollback;
