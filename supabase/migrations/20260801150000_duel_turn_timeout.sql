-- Adds server-authoritative turn timeout handling.
--
-- Before this migration a turn that ran past its 45-second deadline
-- (now 90s) could only end via the opponent hitting "Claim Forfeit",
-- and that killed the whole duel. That was harsh: a network blip or
-- a slow think meant the entire pot went to the other side.
--
-- The new model:
--   * When a turn expires, the SERVER skips it. The offender loses
--     that one pick, the turn passes to their opponent, and the draft
--     continues. Because the loss is now bounded — a single missed
--     slot — the draft can conclude with an incomplete team on
--     either side, and the simulation is happy to run with fewer
--     than 11 players.
--   * The offender is penalised on their NEXT turn: they may only
--     draft players rated 85 or lower. The cap clears once they
--     successfully make a pick.
--   * pick_attempts counts turns taken (picks OR skips). The draft
--     ends when it hits TOTAL_PICKS (22), regardless of how many
--     slots are actually filled.
--
-- All three columns default sensibly for legacy rooms so existing
-- in-flight duels don't break. pick_attempts backfills from the
-- current squad slot counts.

alter table public.duel_rooms
  add column if not exists pick_attempts              smallint not null default 0
    check (pick_attempts between 0 and 22),
  add column if not exists creator_penalty_max_rating smallint
    check (creator_penalty_max_rating is null or creator_penalty_max_rating between 0 and 100),
  add column if not exists joiner_penalty_max_rating  smallint
    check (joiner_penalty_max_rating is null or joiner_penalty_max_rating between 0 and 100);

-- Backfill: for rooms already in flight, pick_attempts equals the number
-- of slot rows across both squads. No pre-existing room can have any
-- timeouts because timeouts didn't exist yet.
update public.duel_rooms r
   set pick_attempts = coalesce((
     select count(*)::smallint
       from public.duel_squad_slots s
      inner join public.duel_squads q on q.id = s.squad_id
      where q.room_id = r.id
   ), 0)
 where r.status in ('drafting', 'simulating', 'complete')
   and r.pick_attempts = 0;
