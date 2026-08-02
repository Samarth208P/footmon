-- Adds per-player formation choice to duel_rooms.
--
-- Each player selects a formation (e.g. "4-3-3", "3-5-2") during the
-- ready phase. The choice is stored on the room so both the pick route
-- (which validates slot positions against the chosen formation) and the
-- simulation engine (which uses formations for tactical matchup modifiers)
-- can read it without an extra join to duel_squads.
--
-- Defaults to '4-3-3' for backwards compatibility with rooms created
-- before this migration — those were hardcoded to 4-3-3.

alter table public.duel_rooms
  add column if not exists creator_formation text not null default '4-3-3'
    check (creator_formation in (
      '4-3-3', '4-4-2', '4-2-3-1', '4-2-4',
      '3-5-2', '5-3-2', '4-5-1', '3-4-3'
    )),
  add column if not exists joiner_formation text not null default '4-3-3'
    check (joiner_formation in (
      '4-3-3', '4-4-2', '4-2-3-1', '4-2-4',
      '3-5-2', '5-3-2', '4-5-1', '3-4-3'
    ));
