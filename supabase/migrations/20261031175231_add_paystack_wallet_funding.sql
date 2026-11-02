alter table public.wallet_transactions
  add column payment_status text not null default 'successful',
  add column payment_provider text,
  add column payment_reference text;

alter table public.wallet_transactions
  add constraint wallet_transactions_payment_status_allowed
    check (payment_status in ('pending', 'successful', 'failed')),
  add constraint wallet_transactions_paystack_deposit_fields
    check (
      (payment_provider is null and payment_reference is null)
      or (
        payment_provider = 'paystack'
        and payment_reference is not null
        and transaction_type = 'deposit'
      )
    );

create unique index wallet_transactions_payment_reference_unique
  on public.wallet_transactions (payment_reference)
  where payment_reference is not null;

create or replace function public.credit_wallet_from_paystack(
  p_reference text,
  p_amount_kobo bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transaction public.wallet_transactions%rowtype;
begin
  if p_reference is null or p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Invalid Paystack credit parameters';
  end if;

  select *
  into v_transaction
  from public.wallet_transactions
  where payment_provider = 'paystack'
    and payment_reference = p_reference
  for update;

  if not found then
    raise exception 'Paystack payment reference not found';
  end if;

  if v_transaction.transaction_type <> 'deposit'
    or v_transaction.amount * 100 <> p_amount_kobo
  then
    raise exception 'Paystack payment does not match pending wallet transaction';
  end if;

  if v_transaction.payment_status = 'successful' then
    return 'already_credited';
  end if;

  if v_transaction.payment_status <> 'pending' then
    raise exception 'Paystack payment is not pending';
  end if;

  update public.wallets
  set balance = balance + v_transaction.amount
  where id = v_transaction.wallet_id
    and user_id = v_transaction.user_id;

  if not found then
    raise exception 'Wallet for Paystack payment not found';
  end if;

  update public.wallet_transactions
  set payment_status = 'successful'
  where id = v_transaction.id;

  return 'credited';
end;
$$;

revoke all on function public.credit_wallet_from_paystack(text, bigint)
  from public, anon, authenticated;
grant execute on function public.credit_wallet_from_paystack(text, bigint)
  to service_role;
