create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  balance numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  constraint wallets_balance_nonnegative check (balance >= 0),
  constraint wallets_id_user_id_unique unique (id, user_id)
);

comment on column public.wallets.balance is
  'Wallet balance denominated in Nigerian Naira (NGN).';

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_type text not null,
  amount numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  constraint wallet_transactions_type_allowed
    check (transaction_type in ('deposit', 'purchase', 'refund')),
  constraint wallet_transactions_amount_positive check (amount > 0),
  constraint wallet_transactions_wallet_owner_fk
    foreign key (wallet_id, user_id)
    references public.wallets (id, user_id)
    on delete cascade
);

create index wallet_transactions_user_created_idx
  on public.wallet_transactions (user_id, created_at desc);

create index wallet_transactions_wallet_created_idx
  on public.wallet_transactions (wallet_id, created_at desc);

alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;

create policy "Users can read their own wallet"
  on public.wallets
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own wallet transactions"
  on public.wallet_transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.wallets from public, anon, authenticated;
revoke all on table public.wallet_transactions from public, anon, authenticated;
grant select on table public.wallets to authenticated;
grant select on table public.wallet_transactions to authenticated;

create or replace function public.create_wallet_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_wallet_for_new_user() from public, anon, authenticated;

create trigger create_wallet_after_user_signup
  after insert on auth.users
  for each row
  execute function public.create_wallet_for_new_user();

insert into public.wallets (user_id)
select users.id
from auth.users as users
on conflict (user_id) do nothing;
