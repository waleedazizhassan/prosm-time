-- v2.3.55 (owner 2026-10-27, a security review: "the server must refuse,
-- not just hide a screen"):
--   * an ended paid licence - or one PROSM marks suspended, revoked,
--     cancelled, blocked or expired - now locks the organisation on the
--     server exactly as an ended trial does (it kept working after its end
--     date); the data is kept, and a new code reopens it;
--   * "your organisation" resolves only for an active person: a deactivated
--     account could still read data that rules check by organisation alone;
--   * three tables whose rules allow reading only kept write grants: the
--     rules already refused, the grants go too (defence in depth).

begin;

create or replace function public.prosm_time_org_locked(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from license_activation_state l
        where l.organization_id = p_org
          and (
              (l.expires_at is not null and l.expires_at <= now())
              or upper(coalesce(l.status, '')) in ('SUSPENDED', 'REVOKED', 'CANCELLED', 'BLOCKED', 'EXPIRED')
          ));
$function$;

create or replace function public.current_prosm_time_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select u.organization_id from public.users u
    where u.auth_user_id = auth.uid() and u.is_active = true and not public.prosm_time_org_locked(u.organization_id);
$function$;

create or replace function public.get_prosm_time_trial_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select coalesce((
        select jsonb_build_object(
            'isTrial', l.is_trial,
            -- v2.3.55: an ended paid licence (or a suspended one) locks too, as an ended trial does
            'locked', public.prosm_time_org_locked(l.organization_id),
            'licenseEnded', not l.is_trial and public.prosm_time_org_locked(l.organization_id),
            'expiresAt', l.expires_at,
            'daysLeft', case when l.expires_at is null then null else greatest(0, ceil(extract(epoch from (l.expires_at - now())) / 86400)::int) end,
            -- v2.3.55: the licence number is the Owner's to see
            'licenseNumber', case when u.is_owner then l.license_number else null end,
            'isOwner', u.is_owner,
            'organizationName', o.name,
            'serverTime', now())
        from users u
        join license_activation_state l on l.organization_id = u.organization_id
        join organizations o on o.id = u.organization_id
        where u.auth_user_id = auth.uid() and u.is_active = true
        limit 1), jsonb_build_object('isTrial', false, 'locked', false));
$function$;

revoke insert, update, delete on public.legal_acknowledgements, public.mock_location_flags, public.offline_time_reviews from authenticated, anon;

commit;
