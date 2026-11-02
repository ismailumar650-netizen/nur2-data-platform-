alter table public.wallet_transactions
add constraint wallet_transactions_id_wallet_user_unique
unique (id, wallet_id, user_id);

create table public.data_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null,
  wallet_transaction_id uuid unique,
  reference text not null unique,
  service_id text not null,
  plan_code text not null,
  plan_name text not null,
  phone_number text not null,
  amount numeric(14,2) not null,
  status text not null default 'pending',
  provider_reference text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint data_purchases_amount_positive check (amount > 0),
  constraint data_purchases_status_allowed
    check (status in ('pending', 'successful', 'failed', 'unknown')),
  constraint data_purchases_wallet_owner_fk
    foreign key (wallet_id, user_id)
    references public.wallets(id, user_id) on delete cascade,
  constraint data_purchases_wallet_transaction_owner_fk
    foreign key (wallet_transaction_id, wallet_id, user_id)
    references public.wallet_transactions(id, wallet_id, user_id)
);

create index data_purchases_user_created_idx
on public.data_purchases(user_id, created_at desc);

alter table public.data_purchases enable row level security;

create policy "Users can read their own data purchases"
on public.data_purchases
for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.data_purchases
from public, anon, authenticated;

grant select on table public.data_purchases to authenticated;
