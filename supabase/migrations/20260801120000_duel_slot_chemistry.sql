-- Adds per-slot nation/year to duel_squad_slots so the match engine can
-- compute hidden chemistry (same-nation and same-year cores) at simulation
-- time.
--
-- Why per-slot and not per-squad: the wheel roll that produces each pick
-- can produce a different nation and year, so a single squad can legally
-- have players from many origins. Chemistry is calculated across the XI,
-- so the origin needs to be remembered for each individual pick.
--
-- Both columns are nullable. Squads drafted before this migration ran will
-- keep NULL here and simply forfeit the chemistry axes those NULLs cover.
-- That is graceful degradation, not corruption — the match still simulates
-- correctly, chemistry just falls back to position-fit only.

alter table public.duel_squad_slots
  add column if not exists player_nation text,
  add column if not exists player_year   smallint;

-- Helpful when a future query wants to count nation cores across many
-- squads (leaderboard filters, analytics). Cheap because slot rows are
-- small and there are at most 11 per squad.
create index if not exists duel_squad_slots_nation_idx
  on public.duel_squad_slots (player_nation)
  where player_nation is not null;

create index if not exists duel_squad_slots_year_idx
  on public.duel_squad_slots (player_year)
  where player_year is not null;
