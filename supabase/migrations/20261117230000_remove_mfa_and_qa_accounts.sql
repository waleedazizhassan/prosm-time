-- Owner 2026-11-17: "remove two-step verification from every account (I will add it later)". One-time data step: every
-- authenticator factor is removed (people sign in with their password again; anyone can turn it on again from their
-- profile) and the organisation switch for required MFA is off.
begin;
delete from auth.mfa_factors;
update public.organizations set security_mfa = false where security_mfa;
commit;
