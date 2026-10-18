-- Owner 2026-10-18: "allowances must stay editable by the employee until
-- the manager approves them". Editing used to stop once an entry was
-- submitted. Now a draft or a submitted entry can be edited (a submitted
-- one stays waiting for review, with the new values), a rejected one can
-- be edited and goes back to draft to be resubmitted, and only an
-- approved entry is locked.

begin;

create or replace function public.upsert_prosm_time_allowance_entry(
    p_entry_date date,
    p_meal_allowance numeric default 0,
    p_expatriation_allowance numeric default 0,
    p_transportation_allowance numeric default 0,
    p_housing_allowance numeric default 0,
    p_travel_allowance numeric default 0,
    p_other_allowance numeric default 0,
    p_other_allowance_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_status text;
    v_session_id uuid;
    v_overtime_minutes double precision := 0;
    v_entry_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_entry_date is null then
        raise exception 'ENTRY DATE IS REQUIRED';
    end if;

    select status into v_existing_status from allowance_entries where user_id = v_caller_id and entry_date = p_entry_date;
    -- Owner 2026-10-18: the employee may keep editing until a manager approves.
    if v_existing_status = 'approved' then
        raise exception 'THIS ALLOWANCE ENTRY IS ALREADY APPROVED';
    end if;

    select ats.id into v_session_id
    from attendance_sessions ats
    where ats.user_id = v_caller_id and ats.clock_in_at::date = p_entry_date
    order by ats.clock_in_at desc
    limit 1;

    -- Same per-session shift-policy formula generate_prosm_time_timesheet
    -- uses (20260902130000) - a site with no overtime_start_time
    -- configured contributes 0 here, matching that migration's own
    -- "unconfigured site = no shift-based overtime" behavior.
    select coalesce(sum(
        case
            when s.overtime_start_time is not null and ats.clock_out_at is not null then
                greatest(extract(epoch from ((ats.clock_out_at at time zone s.timezone)::time - s.overtime_start_time)) / 60, 0)
            else 0
        end
    ), 0)
    into v_overtime_minutes
    from attendance_sessions ats
    left join sites s on s.id = ats.site_id
    where ats.user_id = v_caller_id and ats.clock_in_at::date = p_entry_date;

    insert into allowance_entries (
        organization_id, user_id, attendance_session_id, entry_date,
        meal_allowance, expatriation_allowance, transportation_allowance,
        housing_allowance, travel_allowance, other_allowance, other_allowance_note,
        overtime_hours, overtime_days, status, updated_at
    ) values (
        v_caller_org, v_caller_id, v_session_id, p_entry_date,
        coalesce(p_meal_allowance, 0), coalesce(p_expatriation_allowance, 0), coalesce(p_transportation_allowance, 0),
        coalesce(p_housing_allowance, 0), coalesce(p_travel_allowance, 0), coalesce(p_other_allowance, 0), p_other_allowance_note,
        round((v_overtime_minutes / 60)::numeric, 2), case when v_overtime_minutes > 0 then 1 else 0 end, 'draft', now()
    )
    on conflict (user_id, entry_date) do update set
        meal_allowance = excluded.meal_allowance,
        expatriation_allowance = excluded.expatriation_allowance,
        transportation_allowance = excluded.transportation_allowance,
        housing_allowance = excluded.housing_allowance,
        travel_allowance = excluded.travel_allowance,
        other_allowance = excluded.other_allowance,
        other_allowance_note = excluded.other_allowance_note,
        attendance_session_id = excluded.attendance_session_id,
        overtime_hours = excluded.overtime_hours,
        overtime_days = excluded.overtime_days,
        -- still waiting for review with the new values; a rejected entry goes back to draft to be resubmitted
        status = case when allowance_entries.status = 'rejected' then 'draft' else allowance_entries.status end,
        updated_at = now()
    returning id into v_entry_id;

    return jsonb_build_object('success', true, 'entryId', v_entry_id);
exception
    when others then
        raise exception 'UPSERT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

commit;
