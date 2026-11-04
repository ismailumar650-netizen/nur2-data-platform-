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

  if v_purchase.provider_lease_action is null
    or v_purchase.provider_lease_action not in ('submission', 'reconciliation')
    or (
      v_purchase.provider_lease_action = 'submission'
      and v_purchase.status <> 'pending'
    )
    or (
      v_purchase.provider_lease_action = 'reconciliation'
      and v_purchase.status not in ('pending', 'unknown')
    )
  then
    raise exception 'Purchase status is invalid for provider lease action';
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
