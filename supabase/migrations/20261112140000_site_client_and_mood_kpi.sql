-- Owner 2026-11-12: "the faces rating becomes a KPI for every site, every day, week and month - and every
-- client". A site now says whose it is - the company's own or a client's (with the client's name) - and
-- what kind of place it is (office, warehouse, construction site, factory, shop, or another named kind).
-- The dashboard reads the shift ratings of a period by site and by client.
-- Rollback: drop get_prosm_time_mood_insights(date, date), set_prosm_time_site_profile(uuid, text, text,
-- text, text); alter table sites drop column owner_kind, client_name, site_type, site_type_other.

begin;

alter table public.sites
    add column if not exists owner_kind text not null default 'company' check (owner_kind in ('company', 'client')),
    add column if not exists client_name text,
    add column if not exists site_type text check (site_type in ('office', 'warehouse', 'construction', 'factory', 'shop', 'other')),
    add column if not exists site_type_other text;

create or replace function public.set_prosm_time_site_profile(p_site_id uuid, p_owner_kind text, p_client_name text, p_site_type text, p_site_type_other text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_client text := nullif(btrim(regexp_replace(coalesce(p_client_name, ''), '\s+', ' ', 'g')), '');
    v_other text := nullif(btrim(coalesce(p_site_type_other, '')), '');
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or ('sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_me), array[]::text[]))
            and p_site_id = any(public.current_prosm_time_managed_site_ids()))
    ) then raise exception 'SITES.MANAGE AUTHORITY REQUIRED FOR THIS SITE'; end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then raise exception 'SITE NOT FOUND'; end if;
    if coalesce(p_owner_kind, 'company') not in ('company', 'client') then raise exception 'INVALID SITE OWNER'; end if;
    if p_owner_kind = 'client' and v_client is null then raise exception 'CLIENT NAME REQUIRED'; end if;
    if p_site_type is not null and p_site_type not in ('office', 'warehouse', 'construction', 'factory', 'shop', 'other') then raise exception 'INVALID SITE TYPE'; end if;
    if p_site_type = 'other' and v_other is null then raise exception 'SITE TYPE NAME REQUIRED'; end if;
    -- one spelling per client: reuse the organisation's existing spelling of the same name
    if v_client is not null then
        select coalesce((select s.client_name from sites s where s.organization_id = v_org and lower(s.client_name) = lower(v_client) and s.id <> p_site_id limit 1), v_client)
        into v_client;
    end if;
    update sites set
        owner_kind = coalesce(p_owner_kind, 'company'),
        client_name = case when p_owner_kind = 'client' then left(v_client, 120) end,
        site_type = p_site_type,
        site_type_other = case when p_site_type = 'other' then left(v_other, 80) end
    where id = p_site_id;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_site_profile(uuid, text, text, text, text) from public, anon;
grant execute on function public.set_prosm_time_site_profile(uuid, text, text, text, text) to authenticated;

-- The period's shift ratings: totals, a score (great 100, normal 50, tough 0), by site, by client and by day.
-- The owner sees every site; someone with attendance.view sees the sites they manage.
create or replace function public.get_prosm_time_mood_insights(p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
    v_sites uuid[];
    v_result jsonb;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not v_owner and not public.prosm_time_user_has_permission_internal(v_me, 'attendance.view') then raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED'; end if;
    if p_end_date < p_start_date or p_end_date - p_start_date > 370 then raise exception 'PERIOD TOO LONG'; end if;
    v_sites := case when v_owner then null else public.current_prosm_time_managed_site_ids() end;

    with rated as (
        select a.shift_mood as mood, a.site_id, st.name as site_name, st.owner_kind, st.client_name,
               public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) as day
        from attendance_sessions a
        left join sites st on st.id = a.site_id
        where a.organization_id = v_org and a.shift_mood is not null
          and a.clock_in_at >= (p_start_date - 1)::timestamptz and a.clock_in_at < (p_end_date + 2)::timestamptz
          and (v_owner or a.site_id = any(v_sites))
    ), r as (
        select * from rated where day between p_start_date and p_end_date
    ), counted as (
        select count(*) filter (where mood = 'great') as great, count(*) filter (where mood = 'normal') as normal,
               count(*) filter (where mood = 'tough') as tough, count(*) as total
        from r
    )
    select jsonb_build_object(
        'great', c.great, 'normal', c.normal, 'tough', c.tough, 'total', c.total,
        'score', case when c.total > 0 then round((c.great * 100 + c.normal * 50)::numeric / c.total) end,
        'bySite', coalesce((
            select jsonb_agg(x order by (x ->> 'total')::int desc, x ->> 'name') from (
                select jsonb_build_object('siteId', r.site_id, 'name', r.site_name, 'clientName', max(r.client_name),
                    'great', count(*) filter (where mood = 'great'), 'normal', count(*) filter (where mood = 'normal'),
                    'tough', count(*) filter (where mood = 'tough'), 'total', count(*),
                    'score', round((count(*) filter (where mood = 'great') * 100 + count(*) filter (where mood = 'normal') * 50)::numeric / count(*))) as x
                from r group by r.site_id, r.site_name
            ) s), '[]'::jsonb),
        'byClient', coalesce((
            select jsonb_agg(x order by (x ->> 'total')::int desc) from (
                select jsonb_build_object('client', case when r.owner_kind = 'client' then r.client_name end,
                    'great', count(*) filter (where mood = 'great'), 'normal', count(*) filter (where mood = 'normal'),
                    'tough', count(*) filter (where mood = 'tough'), 'total', count(*),
                    'score', round((count(*) filter (where mood = 'great') * 100 + count(*) filter (where mood = 'normal') * 50)::numeric / count(*))) as x
                from r group by case when r.owner_kind = 'client' then r.client_name end
            ) s), '[]'::jsonb),
        'byDay', coalesce((
            select jsonb_agg(x order by x ->> 'day') from (
                select jsonb_build_object('day', r.day,
                    'great', count(*) filter (where mood = 'great'), 'normal', count(*) filter (where mood = 'normal'),
                    'tough', count(*) filter (where mood = 'tough'), 'total', count(*)) as x
                from r group by r.day
            ) s), '[]'::jsonb)
    ) into v_result
    from counted c;
    return v_result;
end;
$$;
revoke all on function public.get_prosm_time_mood_insights(date, date) from public, anon;
grant execute on function public.get_prosm_time_mood_insights(date, date) to authenticated;

commit;
