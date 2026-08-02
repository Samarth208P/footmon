-- ════════════════════════════════════════════════════════════════════════════
--  FootMon storage hygiene
--
--  Auto-deletes rooms and events that are provably finished, so Supabase
--  storage stays small and lobby / room queries stay fast.
--
--  Nothing that participates in a live game or in an aggregate leaderboard
--  is ever touched. The retention windows are deliberately generous —
--  activity in ANY non-terminal status resets the clock via updated_at, and
--  terminal statuses give returning players a window to re-read the result.
--
--  Cascade deletes wired in the arena migration mean:
--    duel_rooms → duel_squads → duel_squad_slots
--    duel_rooms → duel_room_secrets
--    duel_rooms → match_logs
--  … so we only ever have to delete parents. Children go with them.
--
--  duel_leaderboard  and  tournament_leaderboard  are NEVER touched — they
--  are the aggregate boards the UI reads.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Cleanup function ────────────────────────────────────────────────────────
-- SECURITY DEFINER lets pg_cron (running as its own role) invoke it while
-- still bypassing table-level grants and RLS, but the function is otherwise
-- inert: it only ever deletes rows that match the retention filters below.

create or replace function public.cleanup_stale_duels()
returns table (
  rooms_complete_cleaned  integer,
  rooms_cancelled_cleaned integer,
  rooms_expired_cleaned   integer,
  rooms_open_cleaned      integer,
  rooms_stalled_cleaned   integer,
  events_cleaned          integer,
  challenges_cleaned      integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Retention windows. Tune here if traffic changes.
  RETENTION_COMPLETE constant interval := interval '24 hours';
  RETENTION_TERMINAL constant interval := interval '1 hour';   -- cancelled / expired
  RETENTION_OPEN     constant interval := interval '2 hours';  -- past on-chain 1h expiry
  RETENTION_STALLED  constant interval := interval '24 hours'; -- non-terminal but idle
  RETENTION_EVENTS   constant interval := interval '1 hour';
  RETENTION_LEGACY   constant interval := interval '24 hours';

  n_complete  integer := 0;
  n_cancelled integer := 0;
  n_expired   integer := 0;
  n_open      integer := 0;
  n_stalled   integer := 0;
  n_events    integer := 0;
  n_legacy    integer := 0;
begin
  -- Completed duels older than the retention window. Cascade takes their
  -- match_logs, squads, slots and secrets with them.
  with deleted as (
    delete from public.duel_rooms
     where status = 'complete'
       and updated_at < timezone('utc', now()) - RETENTION_COMPLETE
    returning 1
  )
  select count(*) into n_complete from deleted;

  -- Cancelled duels. Short window because there's nothing to look back at.
  with deleted as (
    delete from public.duel_rooms
     where status = 'cancelled'
       and updated_at < timezone('utc', now()) - RETENTION_TERMINAL
    returning 1
  )
  select count(*) into n_cancelled from deleted;

  -- Expired duels (refunded on-chain via refundExpiredDuel). Same short window.
  with deleted as (
    delete from public.duel_rooms
     where status = 'expired'
       and updated_at < timezone('utc', now()) - RETENTION_TERMINAL
    returning 1
  )
  select count(*) into n_expired from deleted;

  -- Never-joined open rooms past on-chain expiry. Anyone can still call
  -- refundExpiredDuel on the contract even after we drop the DB row —
  -- the escrow state lives on-chain, this table is bookkeeping.
  with deleted as (
    delete from public.duel_rooms
     where status = 'open'
       and joiner is null
       and created_at < timezone('utc', now()) - RETENTION_OPEN
    returning 1
  )
  select count(*) into n_open from deleted;

  -- Non-terminal rooms that have been idle for a whole day — genuinely
  -- abandoned. Extremely rare because the ready / draft / simulate flows
  -- push updates continuously, but we cover the case so a lost client
  -- can't pin a row forever.
  with deleted as (
    delete from public.duel_rooms
     where status in ('full', 'ready', 'drafting', 'simulating')
       and updated_at < timezone('utc', now()) - RETENTION_STALLED
    returning 1
  )
  select count(*) into n_stalled from deleted;

  -- duel_events is pure realtime bookkeeping. Broadcast is the primary
  -- transport; these rows are only the "durable" copy used for the
  -- reconnection safety net. Anything past an hour is stale.
  with deleted as (
    delete from public.duel_events
     where created_at < timezone('utc', now()) - RETENTION_EVENTS
    returning 1
  )
  select count(*) into n_events from deleted;

  -- Legacy duel_challenges rows. Nothing new writes here since the arena
  -- migration; keep just enough for the tail of any still-in-flight
  -- legacy clients.
  with deleted as (
    delete from public.duel_challenges
     where updated_at < timezone('utc', now()) - RETENTION_LEGACY
    returning 1
  )
  select count(*) into n_legacy from deleted;

  rooms_complete_cleaned  := n_complete;
  rooms_cancelled_cleaned := n_cancelled;
  rooms_expired_cleaned   := n_expired;
  rooms_open_cleaned      := n_open;
  rooms_stalled_cleaned   := n_stalled;
  events_cleaned          := n_events;
  challenges_cleaned      := n_legacy;

  return next;
end;
$$;

comment on function public.cleanup_stale_duels() is
  'Deletes finished duel rooms and stale event bookkeeping. Cascade FKs take '
  'their squads, slots, secrets and match_logs with them. Leaderboards are '
  'never touched. Invoked automatically by pg_cron; safe to run manually.';

revoke all on function public.cleanup_stale_duels() from public;
revoke all on function public.cleanup_stale_duels() from anon, authenticated;
grant execute on function public.cleanup_stale_duels() to service_role;

-- ── Scheduled run ───────────────────────────────────────────────────────────
-- pg_cron is bundled with Supabase and enabled by default. Every 15 minutes
-- is plenty — the retention windows are hours, not seconds — and keeps the
-- steady-state footprint tiny even under high traffic.

create extension if not exists pg_cron with schema extensions;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'footmon-cleanup-stale-duels'
  ) then
    perform cron.unschedule('footmon-cleanup-stale-duels');
  end if;

  perform cron.schedule(
    'footmon-cleanup-stale-duels',
    '*/15 * * * *',
    $cmd$ select public.cleanup_stale_duels(); $cmd$
  );
end $$;
