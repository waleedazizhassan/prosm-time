-- Cleanup for 20260911140000/140100/140200 - the Lido clock-in
-- investigation found both the RPC and the real Edge Function work
-- correctly with Lido's exact real parameters (verified via both a
-- direct simulated session and a real Edge Function call from a known
-- account) - most likely a transient network condition on the real
-- device at that moment, not a code bug.
drop function if exists public.diagnose_lido_clockin_after_fix();
