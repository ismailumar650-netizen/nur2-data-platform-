begin;

create extension if not exists pgtap;

select plan(10);

create temporary table wallet_recovery_test_context as
select gen_random_uuid() as user_one, gen_random_uuid() as user_two;

insert into auth.users (id, aud, role, email, encrypted_password)
select
  user_one,
  'authenticated',
  'authenticated',
  'wallet-recovery-' || user_one::text || '@example.invalid',
  ''
from wallet_recovery_test_context
union all
select
  user_two,
  'authenticated',
  'authenticated',
  'wallet-recovery-' || user_two::text || '@example.invalid',
  ''
from wallet_recovery_test_context;

insert into public.wallet_transactions (
  wallet_id,
  user_id,
  transaction_type,
  amount,
  payment_status,
  payment_provider,
  payment_reference
)
select
  wallet.id,
  wallet.user_id,
  'deposit',
  125.50,
  'pending',
  'paystack',
  case
    when wallet.user_id = context.user_one then 'NUR2-00000000-0000-4000-8000-000000000001'
    else 'NUR2-00000000-0000-4000-8000-000000000002'
  end
from public.wallets as wallet
cross join wallet_recovery_test_context as context
where wallet.user_id in (context.user_one, context.user_two);

insert into public.wallet_transactions (
  wallet_id,
  user_id,
  transaction_type,
  amount,
  payment_status,
  payment_provider,
  payment_reference
)
select
  wallet.id,
  wallet.user_id,
  'deposit',
  70,
  'failed',
  'paystack',
  'NUR2-00000000-0000-4000-8000-000000000003'
from public.wallets as wallet
where wallet.user_id = (select user_one from wallet_recovery_test_context);

select is(
  (
    select payment_status
    from public.wallet_transactions
    where payment_reference = 'NUR2-00000000-0000-4000-8000-000000000001'
  ),
  'pending',
  'an abandoned or not-yet-settled deposit remains pending until verified'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_one from wallet_recovery_test_context)
  ),
  0::numeric,
  'a pending verification does not credit the wallet'
);

select is(
  public.credit_wallet_from_paystack(
    'NUR2-00000000-0000-4000-8000-000000000001',
    12550
  ),
  'credited',
  'a verified successful payment credits the wallet'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_one from wallet_recovery_test_context)
  ),
  125.50::numeric,
  'the successful verification credits the exact amount once'
);

select is(
  (
    select payment_status
    from public.wallet_transactions
    where payment_reference = 'NUR2-00000000-0000-4000-8000-000000000001'
  ),
  'successful',
  'a credited deposit is recorded as successful'
);

select is(
  public.credit_wallet_from_paystack(
    'NUR2-00000000-0000-4000-8000-000000000001',
    12550
  ),
  'already_credited',
  'repeated verification is idempotent'
);

select is(
  (
    select balance
    from public.wallets
    where user_id = (select user_one from wallet_recovery_test_context)
  ),
  125.50::numeric,
  'repeated verification cannot create a duplicate wallet credit'
);

select throws_ok(
  $$ select public.credit_wallet_from_paystack(
       'NUR2-00000000-0000-4000-8000-000000000003',
       7000
     ) $$,
  'P0001',
  'Paystack payment is not pending',
  'a failed payment cannot be credited'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.credit_wallet_from_paystack(text,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.credit_wallet_from_paystack(text,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.credit_wallet_from_paystack(text,bigint)',
    'EXECUTE'
  ),
  'only service_role can execute the wallet credit RPC'
);

select set_config(
  'request.jwt.claim.sub',
  (select user_one::text from wallet_recovery_test_context),
  true
);
set local role authenticated;

select is(
  (
    select count(*)::integer
    from public.wallet_transactions
    where payment_reference in (
      'NUR2-00000000-0000-4000-8000-000000000001',
      'NUR2-00000000-0000-4000-8000-000000000002'
    )
  ),
  1,
  'RLS exposes only the signed-in user own wallet payment reference'
);

reset role;

select * from finish();
rollback;
