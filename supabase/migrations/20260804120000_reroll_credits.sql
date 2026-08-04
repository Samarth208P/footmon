-- ════════════════════════════════════════════════════════════════════════════
--  FootMon v2 Fresh Start + Reroll Credits
--
--  PART 1: User data cleanup (preserves wc_players world cup data)
--  PART 2: Reroll credit system tables
--
--  Run order: after all previous migrations.
-- ════════════════════════════════════════════════════════════════════════════

-- ── PART 1: Clean all user-generated data ───────────────────────────────────
-- Preserves: wc_players (world cup player data — never delete)
-- Deletes: all room, squad, profile, leaderboard, match, and legacy tables.
-- Cascade handles child rows automatically.

truncate table public.duel_squad_slots    restart identity cascade;
truncate table public.duel_squads         restart identity cascade;
truncate table public.match_logs          restart identity cascade;
truncate table public.duel_room_secrets   restart identity cascade;
truncate table public.duel_rooms          restart identity cascade;
truncate table public.duel_leaderboard    restart identity cascade;
truncate table public.tournament_leaderboard restart identity cascade;
truncate table public.profiles            restart identity cascade;
truncate table public.duel_challenges     restart identity cascade;
truncate table public.duel_events         restart identity cascade;

-- ── PART 2: Reroll credits system ───────────────────────────────────────────

-- ── reroll_credits ───────────────────────────────────────────────────────────
-- One row per wallet. `credits` is the current spendable balance.

create table if not exists public.reroll_credits (
  wallet      text primary key
              check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  credits     integer not null default 0 check (credits >= 0),
  updated_at  timestamptz not null default timezone('utc', now())
);

-- ── credit_purchases ─────────────────────────────────────────────────────────
-- One row per bundle purchase. Idempotent on tx_hash.

create table if not exists public.credit_purchases (
  id              uuid primary key default gen_random_uuid(),
  wallet          text not null
                  check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  bundle_id       text not null,        -- e.g. 'starter', 'value', 'pro', ...
  credits_added   integer not null check (credits_added > 0),
  amount_mon      numeric(30, 8) not null check (amount_mon > 0),
  -- How much of this purchase is committed to the prize pool settlement.
  -- = credits_added × 0.005
  prize_pot_owed  numeric(30, 8) not null check (prize_pot_owed >= 0),
  -- On-chain tx hash — unique so a retry can never double-credit.
  tx_hash         text not null unique,
  created_at      timestamptz not null default timezone('utc', now())
);

create index if not exists credit_purchases_wallet_idx on public.credit_purchases (wallet);
create index if not exists credit_purchases_created_idx on public.credit_purchases (created_at desc);

-- ── credit_spends ────────────────────────────────────────────────────────────
-- Append-only log. One row per reroll that consumed a credit.
-- Used by the daily settlement to count how many credits were used today.

create table if not exists public.credit_spends (
  id          uuid primary key default gen_random_uuid(),
  wallet      text not null
              check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  settled     boolean not null default false,  -- flipped true after daily settlement
  spent_at    timestamptz not null default timezone('utc', now())
);

create index if not exists credit_spends_unsettled_idx
  on public.credit_spends (settled, spent_at)
  where settled = false;

create index if not exists credit_spends_wallet_idx on public.credit_spends (wallet);

-- ── prize_settlements ────────────────────────────────────────────────────────
-- Audit log of each daily settlement run.

create table if not exists public.prize_settlements (
  id              uuid primary key default gen_random_uuid(),
  credits_spent   integer not null check (credits_spent >= 0),
  amount_mon      numeric(30, 8) not null check (amount_mon >= 0),
  tx_hash         text,   -- null if amount was 0 (nothing to settle)
  settled_at      timestamptz not null default timezone('utc', now())
);

-- ── atomic_spend_credit ──────────────────────────────────────────────────────
-- Atomically decrements credits by 1 if balance > 0, logs the spend, and
-- returns TRUE. Returns FALSE without touching anything if balance = 0.

create or replace function public.atomic_spend_credit(p_wallet text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.reroll_credits
  set credits    = credits - 1,
      updated_at = timezone('utc', now())
  where wallet   = p_wallet
    and credits  > 0;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return false;
  end if;

  insert into public.credit_spends (wallet) values (p_wallet);
  return true;
end;
$$;

-- ── updated_at trigger for reroll_credits ────────────────────────────────────

drop trigger if exists reroll_credits_touch on public.reroll_credits;
create trigger reroll_credits_touch before update on public.reroll_credits
  for each row execute function public.touch_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────────

alter table public.reroll_credits   enable row level security;
alter table public.credit_purchases enable row level security;
alter table public.credit_spends    enable row level security;
alter table public.prize_settlements enable row level security;

-- anon can read their own credit balance (wallet is known to them)
drop policy if exists reroll_credits_read on public.reroll_credits;
create policy reroll_credits_read on public.reroll_credits for select using (true);

-- purchases: public read (transparency)
drop policy if exists credit_purchases_read on public.credit_purchases;
create policy credit_purchases_read on public.credit_purchases for select using (true);

-- spends: no anon read (privacy + prevents gaming the settlement)
-- prize_settlements: public read (transparency)
drop policy if exists prize_settlements_read on public.prize_settlements;
create policy prize_settlements_read on public.prize_settlements for select using (true);

-- ── Grants ───────────────────────────────────────────────────────────────────

grant select on public.reroll_credits    to anon, authenticated;
grant select on public.credit_purchases  to anon, authenticated;
grant select on public.prize_settlements to anon, authenticated;

grant all on public.reroll_credits    to service_role;
grant all on public.credit_purchases  to service_role;
grant all on public.credit_spends     to service_role;
grant all on public.prize_settlements to service_role;

-- atomic_spend_credit is security definer; service_role executes it via RPC.
grant execute on function public.atomic_spend_credit(text) to service_role;
