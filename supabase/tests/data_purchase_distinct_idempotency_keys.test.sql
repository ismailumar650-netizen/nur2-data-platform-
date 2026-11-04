begin;

create extension if not exists pgtap;

select plan(5);

create temporary table distinct_key_test_context as
select gen_random_uuid() as user_id;

insert into auth.users (id, aud, role, email, encrypted_password)
select
  user_id,
  'authenticated',
  'authenticated',
  'distinct-key-' || user_id::text || '@example.invalid',
  ''
from distinct_key_test_context;

update public.wallets
set balance = 100
where user_id = (select user_id from distinct_key_test_context);

create temporary table purchase_key_a as
select public.create_data_purchase_and_debit_idempotent(
  (select user_id from distinct_key_test_context),
  'distinct-purchase-key-a',
  'distinct-purchase-reference-a',
  'service',
  'plan',
  'Plan',
  '+2348012345678',
  10
) as id;

create temporary table purchase_key_b as
select public.create_data_purchase_and_debit_idempotent(
  (select user_id from distinct_key_test_context),
  'distinct-purchase-key-b',
  'distinct-purchase-reference-b',
  'service',
  'plan',
  'Plan',
  '+2348012345678',
  10
) as id;

select isnt(
  (select id from purchase_key_a),
  (select id from purchase_key_b),
  'different idempotency keys create different purchase IDs for the same user'
);

select is(
  (
    select count(*)::integer
    from public.data_purchases
    where id in (
      (select id from purchase_key_a),
      (select id from purchase_key_b)
    )
  ),
  2,
  'both distinct purchases are persisted'
);

select is(
  (
    select count(*)::integer
    from public.data_purchases as purchase
    join public.wallet_transactions as transaction
      on transaction.id = purchase.wallet_transaction_id
    where purchase.id in (
        (select id from purchase_key_a),
        (select id from purchase_key_b)
      )
      and transaction.transaction_type = 'purchase'
      and transaction.payment_status = 'pending'
      and transaction.amount = 10
  ),
  2,
  'each purchase has its own pending debit transaction'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_id from distinct_key_test_context)
  ),
  80::numeric,
  'wallet balance reflects exactly two debits'
);

select is(
  (
    select count(*)::integer
    from public.data_purchases
    where id in (
      (select id from purchase_key_a),
      (select id from purchase_key_b)
    )
      and status = 'pending'
      and provider_work_state = 'ready'
  ),
  2,
  'both purchases have the expected pending and ready initial state'
);

select * from finish();

rollback;
