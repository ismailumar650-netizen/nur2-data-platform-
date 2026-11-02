-- Additive provider-submission safety for data purchases.
-- Historical purchases remain uncertain and are never assigned an invented
-- VTUGate reference. New idempotent purchases persist their client reference
-- in the same transaction that creates the purchase.

alter table public.data_purchases
  add column idempotency_key text,
  add column client_reference text,
  add column provider_transaction_id text,
  add column provider_external_reference text,
  add column provider_work_state text not null default 'uncertain',
  add column provider_lease_token uuid,
  add column provider_lease_expires_at timestamptz,
  add column provider_lease_action text,
  add column provider_attempts integer not null default 0;

alter table public.data_purchases
  add constraint data_purchases_user_idempotency_key_unique
    unique (user_id, idempotency_key),
  add constraint data_purchases_client_reference_unique
    unique (client_reference),
  add constraint data_purchases_provider_transaction_id_unique
    unique (provider_transaction_id),
  add constraint data_purchases_provider_external_reference_unique
    unique (provider_external_reference),
  add constraint data_purchases_idempotency_key_valid
    check (
      idempotency_key is null
      or length(btrim(idempotency_key)) between 1 and 200
    ),
  add constraint data_purchases_provider_work_state_allowed
    check (
      provider_work_state in (
        'uncertain',
        'ready',
        'leased',
        'reconciliation_required',
        'confirmed_not_found',
        'complete'
      )
    ),
  add constraint data_purchases_provider_lease_consistent
    check (
      (
        provider_work_state = 'leased'
        and provider_lease_token is not null
        and provider_lease_expires_at is not null
        and provider_lease_action in ('submission', 'reconciliation')
      )
      or (
        provider_work_state <> 'leased'
        and provider_lease_token is null
        and provider_lease_expires_at is null
        and provider_lease_action is null
      )
    ),
  add constraint data_purchases_provider_attempts_nonnegative
    check (provider_attempts >= 0),
  add constraint data_purchases_provider_client_reference_required
    check (provider_work_state = 'uncertain' or client_reference is not null);

create index data_purchases_provider_submission_idx
  on public.data_purchases (created_at, id)
  where provider_work_state in ('ready', 'confirmed_not_found');

create index data_purchases_provider_reconciliation_idx
  on public.data_purchases (created_at, id)
  where provider_work_state in ('uncertain', 'reconciliation_required');


-- A refund must identify its source purchase debit. The generated type and
-- composite FK prevent linking to a deposit, refund, another wallet, or user.
alter table public.wallet_transactions
  add column refunds_purchase_transaction_id uuid,
  add column refund_of_transaction_type text
    generated always as (
      case
        when refunds_purchase_transaction_id is not null then 'purchase'::text
      end
    ) stored;

alter table public.wallet_transactions
  add constraint wallet_transactions_id_wallet_user_type_unique
    unique (id, wallet_id, user_id, transaction_type),
  add constraint wallet_transactions_refund_source_type
    check (
      refunds_purchase_transaction_id is null
      or transaction_type = 'refund'
    ),
  add constraint wallet_transactions_refund_source_fk
    foreign key (
      refunds_purchase_transaction_id,
      wallet_id,
      user_id,
      refund_of_transaction_type
    )
    references public.wallet_transactions (
      id,
      wallet_id,
      user_id,
      transaction_type
    ),
  add constraint wallet_transactions_new_refunds_require_source
    check (
      transaction_type <> 'refund'
      or refunds_purchase_transaction_id is not null
    ) not valid;

create unique index wallet_transactions_refund_source_unique
  on public.wallet_transactions (refunds_purchase_transaction_id)
  where refunds_purchase_transaction_id is not null;


create or replace function public.create_data_purchase_and_debit_idempotent(
  p_user_id uuid,
  p_idempotency_key text,
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
  v_client_reference text;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 1 and 200
    or p_reference is null
    or length(btrim(p_reference)) = 0
    or length(p_reference) > 64
    or p_service_id is null
    or p_plan_code is null
    or p_plan_name is null
    or p_phone_number is null
    or p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <= 0
    or p_amount <> round(p_amount, 2)
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid data purchase details';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_idempotency_key, 0)
  );

  select *
  into v_existing
  from public.data_purchases
  where user_id = p_user_id
    and idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.reference is distinct from p_reference
      or v_existing.service_id is distinct from p_service_id
      or v_existing.plan_code is distinct from p_plan_code
      or v_existing.plan_name is distinct from p_plan_name
      or v_existing.phone_number is distinct from p_phone_number
      or v_existing.amount is distinct from p_amount
    then
      raise exception
        'Idempotency key already used with different purchase details';
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

  v_client_reference := gen_random_uuid()::text;

  insert into public.data_purchases (
    user_id,
    wallet_id,
    wallet_transaction_id,
    idempotency_key,
    client_reference,
    reference,
    service_id,
    plan_code,
    plan_name,
    phone_number,
    amount,
    status,
    provider_work_state
  )
  values (
    p_user_id,
    v_wallet.id,
    v_transaction_id,
    p_idempotency_key,
    v_client_reference,
    p_reference,
    p_service_id,
    p_plan_code,
    p_plan_name,
    p_phone_number,
    p_amount,
    'pending',
    'ready'
  )
  returning id into v_purchase_id;

  return v_purchase_id;
end;
$$;


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
    where provider_work_state in ('ready', 'confirmed_not_found')
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
    where provider_work_state in ('uncertain', 'reconciliation_required')
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
    or p_outcome not in ('successful', 'failed', 'unknown')
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
  set status = p_outcome,
      provider_transaction_id =
        coalesce(p_provider_transaction_id, provider_transaction_id),
      provider_external_reference =
        coalesce(p_provider_external_reference, provider_external_reference),
      provider_reference =
        coalesce(p_provider_external_reference, provider_reference),
      provider_work_state = case
        when p_outcome = 'unknown' then 'reconciliation_required'
        else 'complete'
      end,
      provider_lease_token = null,
      provider_lease_expires_at = null,
      provider_lease_action = null,
      updated_at = clock_timestamp()
  where id = p_purchase_id;

  return p_outcome;
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

  if v_purchase.provider_work_state <> 'leased'
    or v_purchase.provider_lease_action <> 'reconciliation'
    or v_purchase.provider_lease_token is distinct from p_lease_token
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


create or replace function public.refund_failed_data_purchase(
  p_purchase_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase public.data_purchases%rowtype;
  v_wallet public.wallets%rowtype;
  v_refund_transaction_id uuid;
begin
  select *
  into v_purchase
  from public.data_purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'Purchase not found';
  end if;

  if v_purchase.status <> 'failed'
    or v_purchase.provider_work_state <> 'complete'
  then
    raise exception 'Purchase is not failed';
  end if;

  if v_purchase.wallet_transaction_id is null then
    raise exception 'Purchase transaction not found';
  end if;

  perform 1
  from public.wallet_transactions
  where id = v_purchase.wallet_transaction_id
    and wallet_id = v_purchase.wallet_id
    and user_id = v_purchase.user_id
    and transaction_type = 'purchase'
    and payment_status = 'failed'
  for update;

  if not found then
    raise exception 'Purchase transaction is not refundable';
  end if;

  select id
  into v_refund_transaction_id
  from public.wallet_transactions
  where refunds_purchase_transaction_id = v_purchase.wallet_transaction_id;

  if found then
    return v_refund_transaction_id;
  end if;

  select *
  into v_wallet
  from public.wallets
  where id = v_purchase.wallet_id
    and user_id = v_purchase.user_id
  for update;

  if not found then
    raise exception 'Wallet not found';
  end if;

  insert into public.wallet_transactions (
    wallet_id,
    user_id,
    transaction_type,
    amount,
    payment_status,
    refunds_purchase_transaction_id
  )
  values (
    v_purchase.wallet_id,
    v_purchase.user_id,
    'refund',
    v_purchase.amount,
    'successful',
    v_purchase.wallet_transaction_id
  )
  returning id into v_refund_transaction_id;

  update public.wallets
  set balance = balance + v_purchase.amount
  where id = v_wallet.id
    and user_id = v_purchase.user_id;

  if not found then
    raise exception 'Wallet not found';
  end if;

  return v_refund_transaction_id;
end;
$$;


-- Preserve the existing legacy function signature. Its omitted provider state
-- uses the uncertain column default, and its omitted client reference remains
-- NULL. Both properties intentionally prevent automatic submission.
revoke all on function public.create_data_purchase_and_debit(
  uuid, text, text, text, text, text, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.create_data_purchase_and_debit(
  uuid, text, text, text, text, text, numeric
) to service_role;

revoke all on function public.create_data_purchase_and_debit_idempotent(
  uuid, text, text, text, text, text, text, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.create_data_purchase_and_debit_idempotent(
  uuid, text, text, text, text, text, text, numeric
) to service_role;

revoke all on function public.claim_next_data_purchase(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_data_purchase(integer)
  to service_role;

revoke all on function public.claim_next_data_purchase_reconciliation(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_data_purchase_reconciliation(integer)
  to service_role;

revoke all on function public.transition_data_purchase_outcome(
  uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.transition_data_purchase_outcome(
  uuid, uuid, text, text, text
) to service_role;

revoke all on function public.confirm_data_purchase_not_found(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_data_purchase_not_found(uuid, uuid)
  to service_role;

revoke all on function public.refund_failed_data_purchase(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.refund_failed_data_purchase(uuid)
  to service_role;
