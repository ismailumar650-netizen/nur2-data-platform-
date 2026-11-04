alter table public.data_purchases
  drop constraint data_purchases_provider_work_state_allowed,
  add constraint data_purchases_provider_work_state_allowed
    check (
      provider_work_state in (
        'uncertain',
        'ready',
        'leased',
        'still_processing',
        'reconciliation_required',
        'confirmed_not_found',
        'complete'
      )
    );

drop index public.data_purchases_provider_reconciliation_idx;
create index data_purchases_provider_reconciliation_idx
  on public.data_purchases (created_at, id)
  where provider_work_state in (
    'uncertain',
    'still_processing',
    'reconciliation_required'
  );

create or replace function public.claim_next_data_purchase_reconciliation(
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
    where provider_work_state in (
        'uncertain',
        'still_processing',
        'reconciliation_required'
      )
      and client_reference is not null
      and status in ('pending', 'unknown')
    order by created_at, id
    for update skip locked
    limit 1
  )
  update public.data_purchases as purchase
  set provider_work_state = 'leased',
      provider_lease_token = gen_random_uuid(),
      provider_lease_expires_at =
        clock_timestamp() + make_interval(secs => p_lease_seconds),
      provider_lease_action = 'reconciliation',
      updated_at = clock_timestamp()
  from candidate
  where purchase.id = candidate.id
  returning purchase.*;
end;
$$;

create or replace function public.transition_data_purchase_outcome(
  p_purchase_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_provider_transaction_id text default null,
  p_provider_external_reference text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase public.data_purchases%rowtype;
begin
  if p_outcome is null
    or p_outcome not in ('successful', 'failed', 'still_processing', 'unknown')
    or (
      p_provider_transaction_id is not null
      and length(btrim(p_provider_transaction_id)) = 0
    )
    or (
      p_provider_external_reference is not null
      and length(btrim(p_provider_external_reference)) = 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid data purchase outcome';
  end if;

  select *
  into v_purchase
  from public.data_purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'Purchase not found';
  end if;

  if v_purchase.provider_work_state <> 'leased'
    or v_purchase.provider_lease_token is distinct from p_lease_token
    or v_purchase.provider_lease_expires_at <= clock_timestamp()
  then
    raise exception 'Invalid or expired provider lease';
  end if;

  if v_purchase.wallet_transaction_id is null then
    raise exception 'Purchase transaction not found';
  end if;

  update public.wallet_transactions
  set payment_status = case
    when p_outcome = 'successful' then 'successful'
    when p_outcome = 'failed' then 'failed'
    else 'pending'
  end
  where id = v_purchase.wallet_transaction_id
    and wallet_id = v_purchase.wallet_id
    and user_id = v_purchase.user_id
    and transaction_type = 'purchase';

  if not found then
    raise exception 'Purchase transaction not found';
  end if;

  update public.data_purchases
  set status = case
        when p_outcome = 'successful' then 'successful'
    when p_outcome = 'failed' then 'failed'
    when p_outcome = 'still_processing' then 'pending'
    else 'unknown'
  end,
      provider_transaction_id =
        coalesce(p_provider_transaction_id, provider_transaction_id),
      provider_external_reference =
        coalesce(p_provider_external_reference, provider_external_reference),
      provider_reference =
        coalesce(p_provider_external_reference, provider_reference),
      provider_work_state = case
        when p_outcome in ('successful', 'failed') then 'complete'
        when p_outcome = 'still_processing' then 'still_processing'
        else 'reconciliation_required'
      end,
      provider_lease_token = null,
      provider_lease_expires_at = null,
      provider_lease_action = null,
      updated_at = clock_timestamp()
  where id = p_purchase_id;

  if p_outcome = 'failed' then
    perform public.refund_failed_data_purchase(p_purchase_id);
  end if;

  return p_outcome;
end;
$$;
