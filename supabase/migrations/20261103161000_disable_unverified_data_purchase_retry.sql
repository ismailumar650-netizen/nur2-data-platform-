alter table public.data_purchases
  add constraint data_purchases_leased_action_required
    check (
      provider_work_state <> 'leased'
      or (
        provider_lease_action is not null
        and provider_lease_action in ('submission', 'reconciliation')
      )
    ) not valid;

create or replace function public.claim_next_data_purchase(
  p_lease_seconds integer default 60
)
returns setof public.data_purchases
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'Invalid provider lease duration';
  end if;

  update public.data_purchases
  set provider_work_state = 'reconciliation_required',
      provider_lease_token = null,
      provider_lease_expires_at = null,
      provider_lease_action = null,
      updated_at = clock_timestamp()
  where provider_work_state = 'leased'
    and provider_lease_expires_at <= clock_timestamp();

  return query
  with candidate as (
    select id
    from public.data_purchases
    where provider_work_state = 'ready'
      and client_reference is not null
      and status = 'pending'
    order by created_at, id
    for update skip locked
    limit 1
  )
  update public.data_purchases as purchase
  set provider_work_state = 'leased',
      provider_lease_token = gen_random_uuid(),
      provider_lease_expires_at =
        clock_timestamp() + make_interval(secs => p_lease_seconds),
      provider_lease_action = 'submission',
      provider_attempts = provider_attempts + 1,
      updated_at = clock_timestamp()
  from candidate
  where purchase.id = candidate.id
  returning purchase.*;
end;
$$;

create or replace function public.confirm_data_purchase_not_found(
  p_purchase_id uuid,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase public.data_purchases%rowtype;
begin
  select *
  into v_purchase
  from public.data_purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'Purchase not found';
  end if;

  if v_purchase.provider_work_state is distinct from 'leased'
    or v_purchase.provider_lease_action is distinct from 'reconciliation'
    or v_purchase.provider_lease_token is distinct from p_lease_token
    or v_purchase.provider_lease_expires_at is null
    or v_purchase.provider_lease_expires_at <= clock_timestamp()
  then
    raise exception 'Invalid or expired provider lease';
  end if;

  if v_purchase.status not in ('pending', 'unknown') then
    raise exception 'Purchase is not awaiting provider reconciliation';
  end if;

  if v_purchase.wallet_transaction_id is null then
    raise exception 'Purchase transaction not found';
  end if;

  update public.wallet_transactions
  set payment_status = 'pending'
  where id = v_purchase.wallet_transaction_id
    and wallet_id = v_purchase.wallet_id
    and user_id = v_purchase.user_id
    and transaction_type = 'purchase';

  if not found then
    raise exception 'Purchase transaction not found';
  end if;

  update public.data_purchases
  set status = 'pending',
      provider_work_state = 'confirmed_not_found',
      provider_lease_token = null,
      provider_lease_expires_at = null,
      provider_lease_action = null,
      updated_at = clock_timestamp()
  where id = p_purchase_id;
end;
$$;

-- Keep unverified confirmation unavailable until a trusted evidence path exists.
revoke all on function public.confirm_data_purchase_not_found(uuid, uuid)
  from public, anon, authenticated, service_role;
