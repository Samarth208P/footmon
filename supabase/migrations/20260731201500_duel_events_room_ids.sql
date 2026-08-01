-- ════════════════════════════════════════════════════════════════════════════
--  Let duel_events carry room-based duels.
--
--  duel_events.duel_id had a foreign key to duel_challenges(duel_id). The
--  room-based flow (duel_rooms) never creates a duel_challenges row, so every
--  ready / pick / join broadcast failed with a foreign key violation — which
--  meant the two players' screens could never agree on state.
--
--  duel_events is transport bookkeeping, not the source of truth: durable state
--  lives in duel_rooms, duel_squad_slots and match_logs. So the column becomes a
--  plain identifier that can hold either a legacy challenge id or a room id.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  fk_name text;
begin
  select con.conname
    into fk_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'duel_events'
    and con.contype = 'f'
    and pg_get_constraintdef(con.oid) like '%duel_challenges%'
  limit 1;

  if fk_name is not null then
    execute format('alter table public.duel_events drop constraint %I', fk_name);
  end if;
end $$;

-- Room ids are UUIDs, challenge ids are arbitrary text; keep the column text.
-- An index still matters because the reconnection poll filters on it.
create index if not exists duel_events_duel_id_created_idx
  on public.duel_events (duel_id, id);

-- Cleanup: events for rooms that no longer exist are useless. Without the old
-- cascade nothing removed them, so prune on room deletion.
create or replace function public.prune_duel_events_for_room()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.duel_events where duel_id = old.id::text;
  return old;
end;
$$;

drop trigger if exists duel_rooms_prune_events on public.duel_rooms;

create trigger duel_rooms_prune_events
  after delete on public.duel_rooms
  for each row execute function public.prune_duel_events_for_room();
