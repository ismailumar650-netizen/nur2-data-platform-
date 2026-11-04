create function public.admin_data_purchase_summary(
  p_page_purchase_ids uuid[],
  p_aging_before timestamptz
)
returns table (
  unresolved_purchase_count bigint,
  customer_funds_awaiting_resolution numeric,
  aging_purchase_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with page_ids as (
    select distinct unnest(coalesce(p_page_purchase_ids, array[]::uuid[])) as id
  ),
  purchase_funds as (
    select
      purchase.id,
      purchase.status,
      purchase.created_at,
      debit.amount as debit_amount,
      coalesce(refunds.amount, 0::numeric) as successful_refund_amount,
      coalesce(refunds.has_successful_refund, false) as has_successful_refund
    from public.data_purchases as purchase
    left join public.wallet_transactions as debit
      on debit.id = purchase.wallet_transaction_id
      and debit.wallet_id = purchase.wallet_id
      and debit.user_id = purchase.user_id
      and debit.transaction_type = 'purchase'
      and debit.payment_status in ('pending', 'failed')
    left join lateral (
      select
        sum(refund.amount) as amount,
        count(*) > 0 as has_successful_refund
      from public.wallet_transactions as refund
      where refund.refunds_purchase_transaction_id = debit.id
        and refund.wallet_id = purchase.wallet_id
        and refund.user_id = purchase.user_id
        and refund.transaction_type = 'refund'
        and refund.payment_status = 'successful'
    ) as refunds on true
  ),
  unresolved as (
    select
      funds.*,
      (
        funds.status in ('pending', 'unknown')
        or (
          funds.status = 'failed'
          and not funds.has_successful_refund
        )
      ) as is_unresolved
    from purchase_funds as funds
  )
  select
    count(*) filter (where unresolved.is_unresolved),
    coalesce(
      sum(
        greatest(
          coalesce(unresolved.debit_amount, 0::numeric)
            - unresolved.successful_refund_amount,
          0::numeric
        )
      ) filter (where unresolved.is_unresolved),
      0::numeric
    ),
    coalesce(
      array_agg(unresolved.id order by unresolved.created_at desc, unresolved.id desc)
        filter (
          where page_ids.id is not null
            and unresolved.created_at < p_aging_before
            and unresolved.is_unresolved
        ),
      array[]::uuid[]
    )
  from unresolved
  left join page_ids on page_ids.id = unresolved.id;
$$;

revoke all on function public.admin_data_purchase_summary(uuid[], timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_data_purchase_summary(uuid[], timestamptz)
  to service_role;
