-- Create the wc_players table for World Cup squad data.
-- This replaces the static /public/data/*.json files.

CREATE TABLE IF NOT EXISTS wc_players (
  id           TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  year         SMALLINT    NOT NULL,
  nation_code  TEXT        NOT NULL,   -- ISO-3 e.g. "BRA"
  nation_name  TEXT        NOT NULL,   -- "Brazil"
  jersey_number SMALLINT   DEFAULT 0,
  rating       SMALLINT    NOT NULL,
  position     TEXT        NOT NULL,   -- primary position
  positions    TEXT[]      NOT NULL DEFAULT '{}',
  attack       SMALLINT    NOT NULL DEFAULT 0,
  defense      SMALLINT    NOT NULL DEFAULT 0,
  is_legendary BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Indexes for the common query patterns used by /api/roll
CREATE INDEX IF NOT EXISTS idx_wc_players_year ON wc_players (year);
CREATE INDEX IF NOT EXISTS idx_wc_players_nation_year ON wc_players (nation_code, year);
CREATE INDEX IF NOT EXISTS idx_wc_players_year_nation ON wc_players (year, nation_code);

-- RLS: public read access (no auth needed for reading player data)
ALTER TABLE wc_players ENABLE ROW LEVEL SECURITY;

-- Idempotent: this migration was originally applied outside the migration
-- runner, so re-running it on an already-configured project would trip on
-- "policy already exists". Dropping first keeps `supabase db push` clean
-- on both fresh projects and any project where the policies were created
-- manually.
DROP POLICY IF EXISTS "wc_players_public_read" ON wc_players;
CREATE POLICY "wc_players_public_read" ON wc_players
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "wc_players_service_write" ON wc_players;
CREATE POLICY "wc_players_service_write" ON wc_players
  FOR ALL USING (auth.role() = 'service_role');
