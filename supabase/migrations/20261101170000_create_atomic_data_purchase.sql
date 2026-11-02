create or replace function public.create_data_purchase_and_debit(
  p_user_id uuid,
  p_reference text,
  p_service_id text,
  p_plan_code text,
  p_plan_name text,
  p_phone_number text,
  p_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet public.wallets%rowtype;
  v_existing public.data_purchases%rowtype;
  v_transaction_id uuid;
  v_purchase_id uuid;
begin
  if p_user_id is null
    or p_reference is null
    or length(trim(p_reference)) = 0
    or length(p_reference) > 64
    or p_service_id is null
    or p_plan_code is null
    or p_plan_name is null
    or p_phone_number is null
    or p_amount is null
    or p_amount <= 0
    or p_amount <> round(p_amount, 2)
  then
    raise exception 'Invalid data purchase details';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_reference, 0));

  select *
  into v_existing
  from public.data_purchases
  where reference = p_reference
  for update;

  if found then
    if v_existing.user_id is distinct from p_user_id
      or v_existing.service_id is distinct from p_service_id
      or v_existing.plan_code is distinct from p_plan_code
      or v_existing.plan_name is distinct from p_plan_name
      or v_existing.phone_number is distinct from p_phone_number
      or v_existing.amount is distinct from p_amount
    then
      raise exception 'Purchase reference already used with different details';
    end if;

    return v_existing.id;
  end if;

  select *
  into v_wallet
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Wallet not found';
  end if;

  if v_wallet.balance < p_amount then
    raise exception 'Insufficient wallet balance';
  end if;

  insert into public.wallet_transactions (
    wallet_id,
    user_id,
    transaction_type,
    amount,
    payment_status
  )
  values (
    v_wallet.id,
    p_user_id,
    'purchase',
    p_amount,
    'pending'
  )
  returning id into v_transaction_id;

  update public.wallets
  set balance = balance - p_amount
  where id = v_wallet.id
    and user_id = p_user_id;

  insert into public.data_purchases (
    user_id,
    wallet_id,
    wallet_transaction_id,
    reference,
    service_id,
    plan_code,
    plan_name,
    phone_number,
    amount,
    status
  )
  values (
    p_user_id,
    v_wallet.id,
    v_transaction_id,
    p_reference,
    p_service_id,
    p_plan_code,
    p_plan_name,
    p_phone_number,
    p_amount,
    'pending'
  )
  returning id into v_purchase_id;

  return v_purchase_id;
end;
$$;

revoke all on function public.create_data_purchase_and_debit(
  uuid, text, text, text, text, text, numeric
) from public, anon, authenticated;

grant execute on function public.create_data_purchase_and_debit(
  uuid, text, text, text, text, text, numeric
) to service_role;
