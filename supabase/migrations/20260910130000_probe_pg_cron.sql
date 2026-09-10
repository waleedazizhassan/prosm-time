-- Enables pg_cron ahead of 20260910140000's real scheduled job
-- (missing-clock-out detection). Split into its own migration since
-- CREATE EXTENSION requires its own transaction boundary on some
-- Postgres/Supabase setups - kept separate rather than folded into
-- that migration's own `begin`/`commit` block.
create extension if not exists pg_cron;
