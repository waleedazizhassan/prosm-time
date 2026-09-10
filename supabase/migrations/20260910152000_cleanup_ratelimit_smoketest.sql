-- Cleans up the real live smoke test performed right after
-- 20260910150000's deploy (3 real HTTP calls to request-password-reset
-- for a disposable test address, confirming the deployed endpoint
-- returns a real 429 past its limit - see this session's own report).
-- No user with this email exists, so no password_reset_requests row
-- was ever created - only the rate-limit counters need removing.
delete from security_rate_limits where identifier = 'verify-ratelimit-smoketest@prosm.net';
delete from security_rate_limits where scope = 'password_reset_request_ip';
