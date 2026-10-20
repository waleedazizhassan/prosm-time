-- Owner 2026-10-20 (what happens to a reason after the manager decides?):
-- "Request clarification" was a dead end - the employee was told, but had
-- nowhere to answer, and the item stayed in the manager's queue. Now the
-- exception goes back to the employee, showing the manager's question, to
-- explain again; it returns to the manager when they do. Clarification is
-- refused for items the person can't answer (time corrections, offline
-- times, fake locations).

begin;

alter table public.geofence_exceptions add column if not exists clarification_request text;

CREATE OR REPLACE FUNCTION public.review_prosm_time_exception(p_kind text, p_target_id uuid, p_action_type text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_action_id uuid;
    v_ge geofence_exceptions%rowtype;
    v_cr correction_requests%rowtype;
    v_session attendance_sessions%rowtype;
    v_ot offline_time_reviews%rowtype;
    v_mock mock_location_flags%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'EXCEPTIONS.MANAGE AUTHORITY REQUIRED';
    end if;

    if p_kind not in ('geofence_exception', 'correction_request', 'offline_time', 'mock_location') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;
    -- Owner 2026-10-20: asking for clarification only makes sense where the
    -- person can answer - a reason for being outside the work area.
    if p_action_type = 'clarification_requested' and p_kind <> 'geofence_exception' then
        raise exception 'INVALID ACTION TYPE FOR THIS ITEM';
    end if;

    -- Audit 1.4 - an offline action recorded with the device's time: the
    -- decision is kept on the review itself (the recorded time stays; a
    -- correction request or an admin edit changes it when needed).
    -- Audit 2.4 - a clock in/out from a location the device reported as simulated.
    if p_kind = 'mock_location' then
        select * into v_mock from mock_location_flags where id = p_target_id and organization_id = v_caller_org;
        if v_mock.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_mock.user_id, v_mock.site_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        update mock_location_flags
        set status = case p_action_type when 'clarification_requested' then 'pending_review' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_mock.user_id, 'correction_reviewed', 'normal', 'Your location was reviewed',
            'Decision: ' || p_action_type || '.', 'mock_location_flags', p_target_id,
            jsonb_build_object('kind', 'mock_location', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'offline_time' then
        select * into v_ot from offline_time_reviews where id = p_target_id and organization_id = v_caller_org;
        if v_ot.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_ot.user_id, v_ot.site_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        update offline_time_reviews
        set status = case p_action_type when 'clarification_requested' then 'pending' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_ot.user_id, 'correction_reviewed', 'normal', 'Your offline time was reviewed',
            'Decision: ' || p_action_type || '.', 'offline_time_reviews', p_target_id,
            jsonb_build_object('kind', 'offline_time', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_ge.user_id, coalesce(
            (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_events ae join attendance_sessions ats on ats.id = ae.session_id where ae.id = v_ge.attendance_event_id),
            (select coalesce(ps.site_id, ats.site_id, ats.responsible_site_id) from presence_sessions ps left join attendance_sessions ats on ats.id = ps.attendance_session_id where ps.id = v_ge.presence_session_id)
        )) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');
        -- Clarification: back to the person, with the manager's question, to explain again.
        update geofence_exceptions
        set status = 'pending_reason', clarification_request = nullif(trim(coalesce(p_notes, '')), '')
        where id = p_target_id and p_action_type = 'clarification_requested';

        perform public.create_prosm_time_notification(
            v_caller_org, v_ge.user_id, 'correction_reviewed', 'normal', 'Your exception was reviewed',
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id,
            jsonb_build_object('kind', 'exception', 'actionType', p_action_type)
        );
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_cr.user_id,
            (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_sessions ats where ats.id = v_cr.attendance_session_id)
        ) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        insert into exception_actions (organization_id, correction_request_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update correction_requests set status = p_action_type where id = p_target_id;

        -- § live UX review, user-directed - approving now actually
        -- applies the proposed time, not just a recorded decision.
        if p_action_type = 'approved' then
            select * into v_session from attendance_sessions where id = v_cr.attendance_session_id;
            if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;

            if v_cr.proposed_event_type = 'clock_in' then
                if v_session.clock_out_at is not null and v_cr.proposed_correct_time >= v_session.clock_out_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_in_at = v_cr.proposed_correct_time, updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_in';
            else
                if v_cr.proposed_correct_time <= v_session.clock_in_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_out_at = v_cr.proposed_correct_time, status = 'clocked_out', updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_out';

                -- Same cleanup clock_out_prosm_time_attendance's own
                -- self-service path already does - a retroactive
                -- clock-out correction shouldn't leave presence
                -- monitoring running against someone no longer "at work".
                update presence_sessions
                set status = 'ended', ended_at = now(), end_reason = 'clock_out'
                where attendance_session_id = v_cr.attendance_session_id and status = 'active';
            end if;
        end if;

        perform public.create_prosm_time_notification(
            v_caller_org, v_cr.user_id, 'correction_reviewed', 'normal', 'Your correction request was reviewed',
            'Decision: ' || p_action_type || '.', 'correction_requests', p_target_id,
            jsonb_build_object('kind', 'correction', 'actionType', p_action_type)
        );
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

commit;
