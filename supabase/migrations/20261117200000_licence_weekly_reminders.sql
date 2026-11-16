-- Owner 2026-11-16: "a month before the end, an email once; then the same email every week" - with what to do and
-- the contacts (info@ / support@). Before: a month, a week and a day before - three emails. Now: the first a month
-- before (30 days), then one every 7 days until the end, and the day-before one stays. The owner's notification
-- inside the app follows the same rhythm. A renewal (a new end date) starts over.
-- Rollback: re-run claim_prosm_time_trial_notices from 20261101200000; drop license_notice_last_at.

begin;

alter table public.license_activation_state add column if not exists license_notice_last_at timestamptz;

do $$
declare
    v_def text := replace(pg_get_functiondef('public.claim_prosm_time_trial_notices()'::regprocedure), chr(13) || chr(10), chr(10));
    v_old_where text := $q$          and (
              (l.expires_at <= now() + interval '1 day' and l.license_day_notice_for is distinct from l.expires_at)
              or (l.expires_at > now() + interval '1 day' and l.expires_at <= now() + interval '7 days' and l.license_week_notice_for is distinct from l.expires_at)
              or (l.expires_at > now() + interval '7 days' and l.expires_at <= now() + interval '30 days' and l.license_month_notice_for is distinct from l.expires_at)
          )$q$;
    v_new_where text := $q$          and (
              -- the day before (once)
              (l.expires_at <= now() + interval '1 day' and l.license_day_notice_for is distinct from l.expires_at)
              -- within the month: the first, then every 7 days
              or (l.expires_at > now() + interval '1 day' and l.expires_at <= now() + interval '30 days'
                  and (l.license_month_notice_for is distinct from l.expires_at
                       or l.license_notice_last_at is null or l.license_notice_last_at <= now() - interval '7 days'))
          )$q$;
    v_old_kind text := $q$case when l.expires_at <= now() + interval '1 day' then 'LICENSE_DAY' when l.expires_at <= now() + interval '7 days' then 'LICENSE_WEEK' else 'LICENSE_MONTH' end as k$q$;
    v_new_kind text := $q$case when l.expires_at <= now() + interval '1 day' then 'LICENSE_DAY' when l.license_month_notice_for is distinct from l.expires_at then 'LICENSE_MONTH' else 'LICENSE_WEEK' end as k$q$;
    v_old_upd text := $q$        else
            update license_activation_state set license_month_notice_for = r.expires_at where license_activation_state.organization_id = r.organization_id;
        end if;$q$;
    v_new_upd text := $q$        else
            update license_activation_state set license_month_notice_for = r.expires_at where license_activation_state.organization_id = r.organization_id;
        end if;
        -- the weekly rhythm counts from the last reminder
        update license_activation_state set license_notice_last_at = now() where license_activation_state.organization_id = r.organization_id;$q$;
begin
    if position('license_notice_last_at' in v_def) > 0 then return; end if;
    if position(v_old_where in v_def) = 0 then raise exception 'licence notices: where anchor not found'; end if;
    if position(v_old_kind in v_def) = 0 then raise exception 'licence notices: kind anchor not found'; end if;
    if position(v_old_upd in v_def) = 0 then raise exception 'licence notices: update anchor not found'; end if;
    execute replace(replace(replace(v_def, v_old_where, v_new_where), v_old_kind, v_new_kind), v_old_upd, v_new_upd);
end $$;

commit;
