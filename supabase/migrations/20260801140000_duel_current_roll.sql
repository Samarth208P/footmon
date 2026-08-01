-- Adds the current-turn roll to duel_rooms so both players can see what
-- the drafter has drawn from the wheel. Before this migration the roll
-- lived only in the drafter's own React state, so the opponent couldn't
-- follow along — they just saw "Wait for your opponent to finish their pick"
-- until a slot was filled.
--
-- Design notes
-- ────────────
-- * We store nation + year, not the full squad list. The squad is
--   deterministic per (year, nation_code) via wc_players, so both clients
--   can render the same 20-odd players by looking it up.
-- * `current_roll_at` is informational for now (debugging / UI freshness
--   hints); it isn't used for authorisation.
-- * All three columns get cleared by the server whenever the turn advances
--   (a successful pick, a forfeit, or the draft completing), so a stale
--   "opponent rolled X" state can't leak between turns.

alter table public.duel_rooms
  add column if not exists current_roll_nation text,
  add column if not exists current_roll_year   smallint
    check (current_roll_year is null or (current_roll_year between 1970 and 2030)),
  add column if not exists current_roll_at     timestamptz;
