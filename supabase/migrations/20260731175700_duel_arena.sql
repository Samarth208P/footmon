-- ════════════════════════════════════════════════════════════════════════════
--  FootMon duel arena schema
--
--  Security model
--  ──────────────
--  * The browser holds only the publishable/anon key. It gets SELECT and
--    nothing else. Every write goes through the server using the secret key,
--    which is what makes draft turns and match results authoritative.
--  * Room passwords live in `duel_room_secrets`, a separate table with zero
--    grants to anon and deliberately excluded from the Realtime publication.
--    A password hash therefore cannot leak through a `select *`, a view, or a
--    Realtime change payload.
--  * Grants are explicit in both directions. Supabase's default privileges for
--    newly created tables differ between versions, so this migration never
--    relies on them: it GRANTs the reads it wants and REVOKEs every write.
--  * All wallet addresses are stored LOWERCASE (check-constrained) so joins
--    never miss on checksum casing.
--
--  Known, accepted tradeoff
--  ────────────────────────
--  Without Supabase Auth (identity here is a wallet signature, not a JWT) RLS
--  cannot tell one anonymous reader from another. anon can therefore read the
--  row of a private room, including its room_code. That is safe because joining
--  is gated on a server-verified password, not on knowing the code.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Enums ───────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'duel_room_status') then
    create type public.duel_room_status as enum (
      'open',        -- created on-chain, waiting for an opponent
      'full',        -- both stakes escrowed, waiting on ready-check
      'ready',       -- both players readied up
      'drafting',    -- turn-based squad draft in progress
      'simulating',  -- match engine streaming minute ticks
      'complete',    -- winner decided and resolved on-chain
      'cancelled',   -- creator withdrew before anyone joined
      'expired'      -- timed out; stakes refunded on-chain
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'match_mode') then
    create type public.match_mode as enum ('duel', 'tournament');
  end if;
end $$;

-- ── profiles ────────────────────────────────────────────────────────────────
-- One username per address. Addresses are never rendered in the UI.

create table if not exists public.profiles (
  address             text primary key
                      check (address = lower(address) and address ~ '^0x[0-9a-f]{40}$'),
  username            text not null,
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now()),
  -- Drives the 30-day rename cooldown enforced in the claim route.
  username_updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_username_len   check (char_length(username) between 3 and 20),
  constraint profiles_username_chars check (username ~ '^[A-Za-z0-9_]+$')
);

-- Case-insensitive uniqueness: "Pele" and "pele" are the same name.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

-- ── duel_rooms ──────────────────────────────────────────────────────────────
-- Extends the old duel_challenges with privacy, seeds and resolution tracking.
-- Contains NO secrets: safe to expose to anon and to Realtime.

create table if not exists public.duel_rooms (
  id             uuid primary key default gen_random_uuid(),
  -- bytes32 duel id used by the escrow contract.
  duel_id        text not null unique check (duel_id ~ '^0x[0-9a-f]{64}$'),
  -- Short shareable code used in /duel/<room_code> links.
  room_code      text not null unique check (room_code ~ '^[A-Z0-9]{6,10}$'),

  creator        text not null
                 check (creator = lower(creator) and creator ~ '^0x[0-9a-f]{40}$'),
  joiner         text
                 check (joiner is null or (joiner = lower(joiner) and joiner ~ '^0x[0-9a-f]{40}$')),
  stake          numeric(78, 0) not null check (stake > 0),  -- wei

  is_private     boolean not null default false,

  status         public.duel_room_status not null default 'open',

  -- Ready-check
  creator_ready  boolean not null default false,
  joiner_ready   boolean not null default false,
  ready_deadline timestamptz,

  -- Draft turn arbitration (server-authoritative)
  current_turn   text,
  turn_deadline  timestamptz,
  draft_seed     text,

  -- Match simulation. Stored BEFORE the sim runs so results are auditable.
  match_seed     text,
  score_creator  smallint not null default 0 check (score_creator >= 0),
  score_joiner   smallint not null default 0 check (score_joiner  >= 0),

  -- Resolution
  winner         text
                 check (winner is null or (winner = lower(winner) and winner ~ '^0x[0-9a-f]{40}$')),
  is_draw        boolean not null default false,
  resolver_tx    text,
  resolved_at    timestamptz,

  created_at     timestamptz not null default timezone('utc', now()),
  updated_at     timestamptz not null default timezone('utc', now()),

  constraint duel_rooms_no_self_duel check (joiner is null or joiner <> creator),
  -- A winner must actually be in the room.
  constraint duel_rooms_winner_is_participant
    check (winner is null or winner = creator or winner = joiner),
  -- current_turn must be one of the two participants.
  constraint duel_rooms_turn_is_participant
    check (current_turn is null or current_turn = creator or current_turn = joiner)
);

create index if not exists duel_rooms_public_lobby_idx
  on public.duel_rooms (status, created_at desc)
  where is_private = false;

create index if not exists duel_rooms_status_idx  on public.duel_rooms (status);
create index if not exists duel_rooms_creator_idx on public.duel_rooms (creator);
create index if not exists duel_rooms_joiner_idx  on public.duel_rooms (joiner);
create index if not exists duel_rooms_turn_deadline_idx
  on public.duel_rooms (turn_deadline)
  where status in ('drafting', 'ready');

-- ── duel_room_secrets ───────────────────────────────────────────────────────
-- SERVER ONLY. No grants, no policies, not published to Realtime.

create table if not exists public.duel_room_secrets (
  room_id       uuid primary key references public.duel_rooms(id) on delete cascade,
  -- scrypt: N$r$p$salt$hash
  password_hash text not null,
  created_at    timestamptz not null default timezone('utc', now())
);

-- ── duel_squads ─────────────────────────────────────────────────────────────
-- One row per player per room: the rolled nation/year and formation choice.

create table if not exists public.duel_squads (
  id          bigint generated by default as identity primary key,
  room_id     uuid not null references public.duel_rooms(id) on delete cascade,
  player      text not null
              check (player = lower(player) and player ~ '^0x[0-9a-f]{40}$'),
  nation      text,
  year        smallint check (year is null or (year between 1970 and 2030)),
  formation   text,
  style       text check (style is null or style in ('defensive', 'balanced', 'attacking')),
  avg_rating  numeric(6, 2),
  is_complete boolean not null default false,
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now()),
  unique (room_id, player)
);

create index if not exists duel_squads_room_idx on public.duel_squads (room_id);

-- ── duel_squad_slots ────────────────────────────────────────────────────────
-- One row per filled pitch slot. Written per-pick so a mid-draft reconnect
-- replays exactly what was picked, in order.

create table if not exists public.duel_squad_slots (
  id              bigint generated by default as identity primary key,
  squad_id        bigint not null references public.duel_squads(id) on delete cascade,
  slot_index      smallint not null check (slot_index between 0 and 10),
  slot_pos        text not null,
  player_name     text not null,
  player_position text,
  player_rating   numeric(6, 2),
  picked_at       timestamptz not null default timezone('utc', now()),
  unique (squad_id, slot_index),
  -- The same footballer cannot be used twice in one squad.
  unique (squad_id, player_name)
);

create index if not exists duel_squad_slots_squad_idx on public.duel_squad_slots (squad_id);

-- ── match_logs ──────────────────────────────────────────────────────────────
-- Append-only minute ticks. `seq` makes replay deterministic and writes
-- idempotent, so a retried broadcast can never duplicate a goal.

create table if not exists public.match_logs (
  id            bigint generated by default as identity primary key,
  room_id       uuid not null references public.duel_rooms(id) on delete cascade,
  mode          public.match_mode not null default 'duel',
  seq           integer not null check (seq >= 0),
  minute        smallint not null check (minute between 0 and 120),
  event_type    text not null check (event_type in (
                  'kickoff', 'chance', 'save', 'goal',
                  'half_time', 'full_time', 'forfeit'
                )),
  -- 'creator' | 'joiner' | 'ai' | null for neutral events.
  team          text check (team is null or team in ('creator', 'joiner', 'ai')),
  scorer_name   text,
  score_creator smallint not null default 0,
  score_joiner  smallint not null default 0,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default timezone('utc', now()),
  unique (room_id, seq),
  -- Only goals may name a scorer.
  constraint match_logs_scorer_only_on_goal
    check (scorer_name is null or event_type = 'goal')
);

create index if not exists match_logs_room_seq_idx on public.match_logs (room_id, seq);

-- ── duel_leaderboard ────────────────────────────────────────────────────────
-- Server-maintained aggregate, one row per address.

create table if not exists public.duel_leaderboard (
  address        text primary key
                 check (address = lower(address) and address ~ '^0x[0-9a-f]{40}$'),
  wins           integer not null default 0 check (wins   >= 0),
  losses         integer not null default 0 check (losses >= 0),
  draws          integer not null default 0 check (draws  >= 0),
  goals_for      integer not null default 0 check (goals_for     >= 0),
  goals_against  integer not null default 0 check (goals_against >= 0),
  mon_won        numeric(78, 0) not null default 0 check (mon_won >= 0),  -- wei
  updated_at     timestamptz not null default timezone('utc', now())
);

create index if not exists duel_leaderboard_rank_idx
  on public.duel_leaderboard (wins desc, (goals_for - goals_against) desc);

-- ── tournament_leaderboard ──────────────────────────────────────────────────
-- One row per completed solo run. Ranked wins → goal difference → rating.

create table if not exists public.tournament_leaderboard (
  id            bigint generated by default as identity primary key,
  address       text not null
                check (address = lower(address) and address ~ '^0x[0-9a-f]{40}$'),
  wins          smallint not null check (wins between 0 and 7),
  goals_for     integer  not null default 0 check (goals_for     >= 0),
  goals_against integer  not null default 0 check (goals_against >= 0),
  goal_diff     integer  not null default 0,
  team_rating   numeric(6, 2) not null,
  nation        text,
  year          smallint,
  formation     text,
  run_seed      text,
  completed_at  timestamptz not null default timezone('utc', now())
);

create index if not exists tournament_leaderboard_rank_idx
  on public.tournament_leaderboard (wins desc, goal_diff desc, team_rating desc);

create index if not exists tournament_leaderboard_address_idx
  on public.tournament_leaderboard (address);

-- ── Legacy tables (kept so the current API keeps working during migration) ──

create table if not exists public.duel_challenges (
  duel_id         text primary key,
  creator         text not null,
  joiner          text,
  stake           numeric not null,
  session_pub_key text not null,
  status          text not null default 'open',
  created_at      timestamptz not null default timezone('utc', now()),
  updated_at      timestamptz not null default timezone('utc', now())
);

create table if not exists public.duel_events (
  id         bigint generated by default as identity primary key,
  duel_id    text not null references public.duel_challenges(duel_id) on delete cascade,
  sender     text not null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists duel_challenges_status_created_idx
  on public.duel_challenges (status, created_at desc);

create index if not exists duel_events_duel_id_id_idx
  on public.duel_events (duel_id, id);

-- ── updated_at triggers ─────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists duel_rooms_touch  on public.duel_rooms;
drop trigger if exists duel_squads_touch on public.duel_squads;
drop trigger if exists profiles_touch    on public.profiles;

create trigger duel_rooms_touch  before update on public.duel_rooms
  for each row execute function public.touch_updated_at();
create trigger duel_squads_touch before update on public.duel_squads
  for each row execute function public.touch_updated_at();
create trigger profiles_touch    before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── Views ───────────────────────────────────────────────────────────────────
-- security_invoker = true keeps the caller's RLS in force, so these are
-- convenience shapes, not privilege escalations.

-- Public lobby: open, non-private rooms only. Private rooms are unlisted.
create or replace view public.duel_lobby
with (security_invoker = true)
as
  select
    r.id,
    r.duel_id,
    r.room_code,
    r.creator,
    r.stake,
    r.status,
    r.created_at,
    coalesce(p.username, 'unclaimed') as creator_username
  from public.duel_rooms r
  left join public.profiles p on p.address = r.creator
  where r.is_private = false
    and r.status = 'open'
    and r.joiner is null
  order by r.created_at desc;

create or replace view public.duel_leaderboard_ranked
with (security_invoker = true)
as
  select
    coalesce(p.username, 'unclaimed')            as username,
    l.address,
    l.wins,
    l.losses,
    l.draws,
    l.goals_for,
    l.goals_against,
    (l.goals_for - l.goals_against)              as goal_diff,
    l.mon_won,
    rank() over (
      order by l.wins desc, (l.goals_for - l.goals_against) desc, l.address asc
    )                                            as rank
  from public.duel_leaderboard l
  left join public.profiles p on p.address = l.address;

create or replace view public.tournament_leaderboard_ranked
with (security_invoker = true)
as
  select
    coalesce(p.username, 'unclaimed') as username,
    t.address,
    t.wins,
    t.goals_for,
    t.goals_against,
    t.goal_diff,
    t.team_rating,
    t.nation,
    t.year,
    t.formation,
    t.completed_at,
    rank() over (
      order by t.wins desc, t.goal_diff desc, t.team_rating desc, t.completed_at asc
    )                                 as rank
  from public.tournament_leaderboard t
  left join public.profiles p on p.address = t.address;

-- ── Row Level Security ──────────────────────────────────────────────────────

alter table public.profiles               enable row level security;
alter table public.duel_rooms             enable row level security;
alter table public.duel_room_secrets      enable row level security;
alter table public.duel_squads            enable row level security;
alter table public.duel_squad_slots       enable row level security;
alter table public.match_logs             enable row level security;
alter table public.duel_leaderboard       enable row level security;
alter table public.tournament_leaderboard enable row level security;
alter table public.duel_challenges        enable row level security;
alter table public.duel_events            enable row level security;

-- Read-only policies. No INSERT/UPDATE/DELETE policy exists anywhere, so even
-- if a write privilege were granted by accident, RLS still denies the write.
drop policy if exists profiles_read               on public.profiles;
drop policy if exists duel_rooms_read             on public.duel_rooms;
drop policy if exists duel_squads_read            on public.duel_squads;
drop policy if exists duel_squad_slots_read       on public.duel_squad_slots;
drop policy if exists match_logs_read             on public.match_logs;
drop policy if exists duel_leaderboard_read       on public.duel_leaderboard;
drop policy if exists tournament_leaderboard_read on public.tournament_leaderboard;
drop policy if exists duel_challenges_read        on public.duel_challenges;
drop policy if exists duel_events_read            on public.duel_events;

create policy profiles_read               on public.profiles               for select using (true);
create policy duel_rooms_read             on public.duel_rooms             for select using (true);
create policy duel_squads_read            on public.duel_squads            for select using (true);
create policy duel_squad_slots_read       on public.duel_squad_slots       for select using (true);
create policy match_logs_read             on public.match_logs             for select using (true);
create policy duel_leaderboard_read       on public.duel_leaderboard       for select using (true);
create policy tournament_leaderboard_read on public.tournament_leaderboard for select using (true);
create policy duel_challenges_read        on public.duel_challenges        for select using (true);
create policy duel_events_read            on public.duel_events            for select using (true);

-- duel_room_secrets intentionally has NO policy at all: unreachable by anon
-- and authenticated even if a grant were added later.

-- ── Explicit grants ─────────────────────────────────────────────────────────
-- Do not rely on Supabase default privileges; they vary by version.

-- Start from a clean slate for the client roles.
revoke all on all tables in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;

grant select on public.profiles               to anon, authenticated;
grant select on public.duel_rooms             to anon, authenticated;
grant select on public.duel_squads            to anon, authenticated;
grant select on public.duel_squad_slots       to anon, authenticated;
grant select on public.match_logs             to anon, authenticated;
grant select on public.duel_leaderboard       to anon, authenticated;
grant select on public.tournament_leaderboard to anon, authenticated;
grant select on public.duel_challenges        to anon, authenticated;
grant select on public.duel_events            to anon, authenticated;

grant select on public.duel_lobby                    to anon, authenticated;
grant select on public.duel_leaderboard_ranked       to anon, authenticated;
grant select on public.tournament_leaderboard_ranked to anon, authenticated;

-- The server key needs full access.
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Belt and braces: secrets are unreachable for client roles no matter what.
revoke all on public.duel_room_secrets from anon, authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────
-- Postgres changes feed used as the reconnection safety net. Live turn/draft
-- traffic rides on broadcast channels, not these.
-- duel_room_secrets is deliberately absent.

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['duel_rooms', 'match_logs', 'duel_squad_slots', 'duel_events']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Realtime needs full row images to diff updates client-side.
alter table public.duel_rooms       replica identity full;
alter table public.match_logs       replica identity full;
alter table public.duel_squad_slots replica identity full;
