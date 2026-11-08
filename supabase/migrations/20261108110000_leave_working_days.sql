-- Owner 2026-11-08: leave counts working days only.
--   * One source of truth for "is this a working day for this person": the work calendar
--     (public holidays, weekly rest days by shift/site/organisation, and days off set as
--     schedule exceptions) - prosm_time_day_type + prosm_time_day_exception.
--   * A request is accepted whole when it has at least one working day, even with holidays
--     inside or at its edges; only the working days are counted and taken from the balance.
--   * A request whose days are all holidays/rest days is refused with a clear reason.
--   * The balance check, the per-request maximum, the unpaid deduction and the balance shown
--     all use the same working-day count.
--   * Approving re-checks everything inside one locked transaction: the working days are
--     recounted from today's calendar, the balance is re-checked, and the request cannot be
--     decided twice at the same time.
--   * preview_prosm_time_leave: what a request would take, before it is sent.
-- Rollback: re-run the function bodies from 20261025160000 / 20261027120000.

begin;

-- The person's site for calendar purposes (their first assignment).
create or replace function public.prosm_time_calendar_site(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select sa.site_id from site_assignments sa where sa.user_id = p_user order by sa.created_at limit 1;
$$;
revoke all on function public.prosm_time_calendar_site(uuid) from public, anon, authenticated;

-- Every day of the range with its type: workday, public_holiday, weekly_rest, day_off.
create or replace function public.prosm_time_leave_days(p_user uuid, p_start date, p_end date)
returns table (day date, day_type text, label text)
language sql
stable
security definer
set search_path = public
as $$
    with site as (select public.prosm_time_calendar_site(p_user) as id)
    select d::date,
           case
               when t.kind = 'workday' and coalesce((x.ex ->> 'is_day_off')::boolean, false) then 'day_off'
               else t.kind
           end,
           case
               when t.kind = 'public_holiday' then (
                   select h.name from public_holidays h join users u on u.organization_id = h.organization_id
                   where u.id = p_user and d::date between h.start_date and h.end_date
                     and (h.site_id is null or h.site_id = (select id from site))
                   order by h.site_id nulls last limit 1)
               when t.kind = 'workday' and coalesce((x.ex ->> 'is_day_off')::boolean, false) then x.ex ->> 'reason'
               else null
           end
    from generate_series(p_start, p_end, interval '1 day') d
    cross join site
    cross join lateral (select public.prosm_time_day_type(p_user, site.id, d::date) as kind) t
    cross join lateral (select public.prosm_time_day_exception(p_user, site.id, d::date) as ex) x
    order by 1;
$$;
revoke all on function public.prosm_time_leave_days(uuid, date, date) from public, anon, authenticated;

create or replace function public.prosm_time_leave_working_dates(p_user uuid, p_start date, p_end date)
returns date[]
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(array_agg(day order by day), array[]::date[])
    from public.prosm_time_leave_days(p_user, p_start, p_end)
    where day_type = 'workday';
$$;
revoke all on function public.prosm_time_leave_working_dates(uuid, date, date) from public, anon, authenticated;

-- The unpaid deduction counts the same working days.
create or replace function public.prosm_time_leave_deduction_days(p_request leave_requests)
returns date[]
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_leave_working_dates(p_request.user_id, p_request.start_date, p_request.end_date);
$$;

-- Rules: working days, refused when none, balance and maximum on working days.
do $patch$
declare
    v_def text;
begin
    v_def := pg_get_functiondef('public.prosm_time_check_leave_rules(uuid,text,date,date,text)'::regprocedure);
    if position('prosm_time_leave_working_dates' in v_def) = 0 then
        if position('v_days numeric := (p_end - p_start) + 1;' in v_def) = 0
           or position('if v_type.id is null then raise exception ''INVALID LEAVE TYPE''; end if;' in v_def) = 0 then
            raise exception 'leave rules: anchor not found';
        end if;
        v_def := replace(v_def, 'v_days numeric := (p_end - p_start) + 1;',
                         'v_days numeric := cardinality(public.prosm_time_leave_working_dates(p_user_id, p_start, p_end));');
        v_def := replace(v_def, 'if v_type.id is null then raise exception ''INVALID LEAVE TYPE''; end if;',
                         'if v_type.id is null then raise exception ''INVALID LEAVE TYPE''; end if;
    if v_days = 0 then
        raise exception ''THIS LEAVE HAS NO WORKING DAY: %'', (
            select string_agg(to_char(day, ''YYYY-MM-DD'') || '' '' || day_type || coalesce('' ('' || label || '')'', ''''), '', '' order by day)
            from public.prosm_time_leave_days(p_user_id, p_start, p_end));
    end if;');
        execute v_def;
    end if;
end;
$patch$;

-- The request and the recorded leave store the working days.
do $patch$
declare
    v_fn text;
    v_def text;
    v_from text;
    v_to text;
begin
    foreach v_fn in array array['public.request_prosm_time_leave(text,date,date,text,text,uuid)', 'public.grant_prosm_time_leave(uuid,text,date,date,text,numeric)'] loop
        begin
            v_def := pg_get_functiondef(v_fn::regprocedure);
        exception when undefined_function then
            raise exception 'leave days patch: % not found', v_fn;
        end;
        if position('prosm_time_leave_working_dates' in v_def) > 0 then continue; end if;
        v_from := 'v_days := (p_end_date - p_start_date) + 1;';
        if position(v_from in v_def) = 0 then raise exception 'leave days patch: anchor not found in %', v_fn; end if;
        v_to := case when v_fn like '%request_%'
                     then 'v_days := cardinality(public.prosm_time_leave_working_dates(v_caller_id, p_start_date, p_end_date));'
                     else 'v_days := cardinality(public.prosm_time_leave_working_dates(p_user_id, p_start_date, p_end_date));' end;
        execute replace(v_def, v_from, v_to);
    end loop;
end;
$patch$;

-- Approval: lock, recount from today's calendar, re-check the balance, decide once.
do $patch$
declare
    v_def text;
    v_lock_from text := 'select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;';
    v_upd_from text := '    update leave_requests
    set status = case when p_action = ''approved'' then ''approved'' else ''rejected'' end,';
begin
    v_def := pg_get_functiondef('public.review_prosm_time_leave(uuid,text,text,numeric)'::regprocedure);
    if position('LEAVE RECHECK' in v_def) > 0 then return; end if;
    if position(v_lock_from in v_def) = 0 then raise exception 'review leave: lock anchor not found'; end if;
    if position(v_upd_from in v_def) = 0 then raise exception 'review leave: update anchor not found'; end if;
    v_def := replace(v_def, v_lock_from, v_lock_from || '
    perform 1 from leave_requests where id = p_request_id for update;
    select * into v_request from leave_requests where id = p_request_id;');
    v_def := replace(v_def, v_upd_from, '    -- LEAVE RECHECK (2026-11-08): recount the working days from the calendar as it is now and
    -- re-check the balance against every other pending/approved request, inside this locked row.
    if p_action = ''approved'' and v_request.status = ''pending'' then
        declare
            v_working numeric := cardinality(public.prosm_time_leave_working_dates(v_request.user_id, v_request.start_date, v_request.end_date));
            v_type leave_types%rowtype;
            v_ent jsonb;
            v_used numeric;
        begin
            if v_working = 0 then
                raise exception ''THIS LEAVE NO LONGER HAS A WORKING DAY'';
            end if;
            select * into v_type from leave_types where organization_id = v_org and key = v_request.leave_type;
            if v_type.id is not null and v_type.enforce_balance then
                v_ent := public.prosm_time_leave_entitlement(v_request.user_id, v_type, extract(year from v_request.start_date)::integer);
                select coalesce(sum(days_count), 0) into v_used from leave_requests
                where user_id = v_request.user_id and leave_type = v_request.leave_type and id <> v_request.id
                  and status = ''approved'' and extract(year from start_date) = extract(year from v_request.start_date);
                if (v_ent ->> ''entitled'') is not null and v_used + v_working > (v_ent ->> ''entitled'')::numeric then
                    raise exception ''NOT ENOUGH LEAVE BALANCE'';
                end if;
            end if;
            if v_working <> v_request.days_count then
                update leave_requests set days_count = v_working, updated_at = now() where id = v_request.id;
                v_request.days_count := v_working;
            end if;
        end;
    end if;
' || v_upd_from);
    execute v_def;
end;
$patch$;

-- What a request would take, before it is sent.
create or replace function public.preview_prosm_time_leave(p_leave_type text, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_type leave_types%rowtype;
    v_ent jsonb;
    v_used numeric := 0;
    v_working date[];
    v_off jsonb;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_start_date is null or p_end_date is null or p_end_date < p_start_date then raise exception 'INVALID DATES'; end if;
    if p_end_date - p_start_date > 366 then raise exception 'THE RANGE IS TOO LONG'; end if;
    select * into v_type from leave_types where organization_id = v_org and key = p_leave_type and is_active;
    if v_type.id is null then raise exception 'INVALID LEAVE TYPE'; end if;
    v_working := public.prosm_time_leave_working_dates(v_caller, p_start_date, p_end_date);
    select coalesce(jsonb_agg(jsonb_build_object('date', day, 'type', day_type, 'name', label) order by day), '[]'::jsonb) into v_off
    from public.prosm_time_leave_days(v_caller, p_start_date, p_end_date) where day_type <> 'workday';
    v_ent := public.prosm_time_leave_entitlement(v_caller, v_type, extract(year from p_start_date)::integer);
    select coalesce(sum(days_count), 0) into v_used from leave_requests
    where user_id = v_caller and leave_type = p_leave_type and status in ('pending', 'approved')
      and extract(year from start_date) = extract(year from p_start_date);
    return jsonb_build_object(
        'workingDays', cardinality(v_working),
        'workingDates', to_jsonb(v_working),
        'offDays', v_off,
        'entitledDays', v_ent -> 'entitled',
        'usedDays', v_used,
        'remainingDays', case when (v_ent ->> 'entitled') is null then null else (v_ent ->> 'entitled')::numeric - v_used end,
        'enforceBalance', v_type.enforce_balance,
        'accepted', cardinality(v_working) > 0
    );
end;
$$;
revoke all on function public.preview_prosm_time_leave(text, date, date) from public, anon;
grant execute on function public.preview_prosm_time_leave(text, date, date) to authenticated;

commit;
