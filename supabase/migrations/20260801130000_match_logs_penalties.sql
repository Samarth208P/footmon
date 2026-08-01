-- Extend match_logs to record penalty shootouts.
--
-- Knockout matches (tournament rounds, and duels once the engine treats them
-- as knockouts) now emit a three-part event stream when tied at 90':
--
--   pens_start  → clients switch to the shootout UI
--   penalty     → one row per kick, with the taker in scorer_name and the
--                 outcome (scored/missed, kick number, sudden death, running
--                 penalty tally) in payload
--   pens_end    → final penalty score + winner
--
-- Two constraints need to bend:
--
--   1. event_type CHECK previously excluded the three new types.
--   2. scorer_name was only permitted on 'goal' — but a penalty taker is
--      the natural fit for the same column, so we widen it to 'goal' or
--      'penalty'.
--
-- We recreate the constraints rather than mutate them because Postgres has
-- no ALTER CONSTRAINT SET for CHECK.

alter table public.match_logs
  drop constraint if exists match_logs_event_type_check;

alter table public.match_logs
  add constraint match_logs_event_type_check
  check (event_type in (
    'kickoff', 'chance', 'save', 'goal',
    'half_time', 'full_time', 'forfeit',
    'pens_start', 'penalty', 'pens_end'
  ));

alter table public.match_logs
  drop constraint if exists match_logs_scorer_only_on_goal;

alter table public.match_logs
  add constraint match_logs_scorer_only_on_goal
  check (scorer_name is null or event_type in ('goal', 'penalty'));
