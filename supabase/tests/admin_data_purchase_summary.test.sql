begin;

create extension if not exists pgtap;

select plan(12);

create temporary table summary_test_context as
select gen_random_uuid() as user_id;

insert into auth.users (id, aud, role, email, encrypted_password)
select
  user_id,
  'authenticated',
  'authenticated',
  'admin-summary-' || user_id::text || '@example.invalid',
  ''
from summary_test_context;

update public.wallets
set balance = 1000
where user_id = (select user_id from summary_test_context);

create temporary table summary_test_purchases (
  kind text primary key,
  id uuid not null
);

insert into summary_test_purchases (kind, id)
values
  (
    'pending',
    public.create_data_purchase_and_debit_idempotent(
      (select user_id from summary_test_context),
      'summary-pending-key',
      'summary-pending-reference',
      'service',
      'pending-plan',
      'Pending plan',
      '+2348012345678',
      10
    )
  ),
  (
    'unknown',
    public.create_data_purchase_and_debit_idempotent(
      (select user_id from summary_test_context),
      'summary-unknown-key',
      'summary-unknown-reference',
      'service',
      'unknown-plan',
      'Unknown plan',
      '+2348012345678',
      20
    )
  ),
  (
    'failed-unrefunded',
    public.create_data_purchase_and_debit_idempotent(
      (select user_id from summary_test_context),
      'summary-failed-unrefunded-key',
      'summary-failed-unrefunded-reference',
      'service',
      'failed-unrefunded-plan',
      'Failed unrefunded plan',
      '+2348012345678',
      30
    )
  ),
  (
    'failed-pending-refund',
    public.create_data_purchase_and_debit_idempotent(
      (select user_id from summary_test_context),
      'summary-failed-pending-refund-key',
      'summary-failed-pending-refund-reference',
      'service',
      'failed-pending-refund-plan',
      'Failed pending refund plan',
      '+2348012345678',
      40
    )
  ),
  (
    'failed-refunded',
    public.create_data_purchase_and_debit_idempotent(
      (select user_id from summary_test_context),
      'summary-failed-refunded-key',
      'summary-failed-refunded-reference',
      'service',
      'failed-refunded-plan',
      'Failed refunded plan',
      '+2348012345678',
      50
    )
  ),
  (
    'successful',
    public.create_data_purchase_and_debit_idempotent(
      (select user_id from summary_test_context),
      'summary-successful-key',
      'summary-successful-reference',
      'service',
      'successful-plan',
      'Successful plan',
      '+2348012345678',
      60
    )
  );

update public.data_purchases as purchase
set
  status = case
    when test_purchase.kind in (
      'failed-unrefunded',
      'failed-pending-refund',
      'failed-refunded'
    ) then 'failed'
    when test_purchase.kind = 'unknown' then 'unknown'
    when test_purchase.kind = 'successful' then 'successful'
    else 'pending'
  end,
  provider_work_state = case
    when test_purchase.kind in (
      'failed-unrefunded',
      'failed-pending-refund',
      'failed-refunded',
      'successful'
    ) then 'complete'
    when test_purchase.kind = 'unknown' then 'reconciliation_required'
    else 'ready'
  end,
  created_at = case
    when test_purchase.kind = 'unknown' then clock_timestamp()
    else clock_timestamp() - interval '20 minutes'
  end
from summary_test_purchases as test_purchase
where purchase.id = test_purchase.id;

update public.wallet_transactions as debit
set payment_status = case
  when test_purchase.kind in (
    'failed-unrefunded',
    'failed-pending-refund',
    'failed-refunded'
  ) then 'failed'
  when test_purchase.kind = 'successful' then 'successful'
  else 'pending'
end
from summary_test_purchases as test_purchase
join public.data_purchases as purchase on purchase.id = test_purchase.id
where debit.id = purchase.wallet_transaction_id;

insert into public.wallet_transactions (
  wallet_id,
  user_id,
  transaction_type,
  amount,
  payment_status,
  refunds_purchase_transaction_id
)
select
  purchase.wallet_id,
  purchase.user_id,
  'refund',
  40,
  'pending',
  purchase.wallet_transaction_id
from public.data_purchases as purchase
where purchase.id = (
  select id from summary_test_purchases where kind = 'failed-pending-refund'
);

insert into public.wallet_transactions (
  wallet_id,
  user_id,
  transaction_type,
  amount,
  payment_status,
  refunds_purchase_transaction_id
)
select
  purchase.wallet_id,
  purchase.user_id,
  'refund',
  50,
  'successful',
  purchase.wallet_transaction_id
from public.data_purchases as purchase
where purchase.id = (
  select id from summary_test_purchases where kind = 'failed-refunded'
);

update public.wallets
set balance = balance + 50
where user_id = (select user_id from summary_test_context);

create temporary table summary_before as
select
  (select balance
   from public.wallets
   where user_id = (select user_id from summary_test_context)) as balance;

create temporary table summary_purchase_rows_before as
select to_jsonb(purchase) as row_data
from public.data_purchases as purchase
where purchase.user_id = (select user_id from summary_test_context);

create temporary table summary_transaction_rows_before as
select to_jsonb(transaction) as row_data
from public.wallet_transactions as transaction
where transaction.user_id = (select user_id from summary_test_context);

select is(
  (
    select unresolved_purchase_count
    from public.admin_data_purchase_summary(
      (select array_agg(id) from summary_test_purchases),
      clock_timestamp() - interval '15 minutes'
    )
  ),
  4::bigint,
  'counts pending and unknown purchases plus failed purchases without a successful customer refund'
);

select is(
  (
    select customer_funds_awaiting_resolution
    from public.admin_data_purchase_summary(
      (select array_agg(id) from summary_test_purchases),
      clock_timestamp() - interval '15 minutes'
    )
  ),
  100::numeric,
  'sums only outstanding customer purchase debits and subtracts successful linked refunds'
);

select is(
  (
    select cardinality(aging_purchase_ids)
    from public.admin_data_purchase_summary(
      (select array_agg(id) from summary_test_purchases),
      clock_timestamp() - interval '15 minutes'
    )
  ),
  3,
  'returns only aged unresolved purchase IDs from the bounded page ID input'
);

select ok(
  (
    select (
      select aging_purchase_ids
      from public.admin_data_purchase_summary(
        (select array_agg(id) from summary_test_purchases),
        clock_timestamp() - interval '15 minutes'
      )
    ) @> array[
      (select id from summary_test_purchases where kind = 'pending'),
      (select id from summary_test_purchases where kind = 'failed-unrefunded'),
      (select id from summary_test_purchases where kind = 'failed-pending-refund')
    ]::uuid[]
  ),
  'aging IDs include old pending and failed purchases without a successful refund'
);

select ok(
  not (
    select (
      select aging_purchase_ids
      from public.admin_data_purchase_summary(
        (select array_agg(id) from summary_test_purchases),
        clock_timestamp() - interval '15 minutes'
      )
    ) @> array[
      (select id from summary_test_purchases where kind = 'unknown'),
      (select id from summary_test_purchases where kind = 'failed-refunded'),
      (select id from summary_test_purchases where kind = 'successful')
    ]::uuid[]
  ),
  'aging IDs exclude recent, refunded, and successfully settled purchases'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.admin_data_purchase_summary(uuid[],timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.admin_data_purchase_summary(uuid[],timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_data_purchase_summary(uuid[],timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'public',
    'public.admin_data_purchase_summary(uuid[],timestamptz)',
    'execute'
  ),
  'only service_role can execute the summary function'
);

set local role service_role;

select is(
  (
    select customer_funds_awaiting_resolution
    from public.admin_data_purchase_summary(
      array[]::uuid[],
      clock_timestamp() - interval '15 minutes'
    )
  ),
  100::numeric,
  'service_role can execute the read-only summary'
);

reset role;

set local role authenticated;

select throws_ok(
  $$ select * from public.admin_data_purchase_summary(array[]::uuid[], now()) $$,
  '42501',
  'permission denied for function admin_data_purchase_summary',
  'authenticated users cannot call the summary function'
);

reset role;

set local role anon;

select throws_ok(
  $$ select * from public.admin_data_purchase_summary(array[]::uuid[], now()) $$,
  '42501',
  'permission denied for function admin_data_purchase_summary',
  'anon users cannot call the summary function'
);

reset role;

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_id from summary_test_context)
  ),
  (select balance from summary_before),
  'summary query does not modify the customer wallet balance'
);

select is(
  (
    select count(*)::integer
    from (
      (
        select to_jsonb(purchase) as row_data
        from public.data_purchases as purchase
        where purchase.user_id = (select user_id from summary_test_context)
        except
        select row_data from summary_purchase_rows_before
      )
      union all
      (
        select row_data from summary_purchase_rows_before
        except
        select to_jsonb(purchase)
        from public.data_purchases as purchase
        where purchase.user_id = (select user_id from summary_test_context)
      )
    ) as changed_rows
  ),
  0,
  'summary query leaves all purchase records unchanged'
);

select is(
  (
    select count(*)::integer
    from (
      (
        select to_jsonb(transaction) as row_data
        from public.wallet_transactions as transaction
        where transaction.user_id = (select user_id from summary_test_context)
        except
        select row_data from summary_transaction_rows_before
      )
      union all
      (
        select row_data from summary_transaction_rows_before
        except
        select to_jsonb(transaction)
        from public.wallet_transactions as transaction
        where transaction.user_id = (select user_id from summary_test_context)
      )
    ) as changed_rows
  ),
  0,
  'summary query leaves all debit and refund transaction records unchanged'
);

select * from finish();

rollback;
