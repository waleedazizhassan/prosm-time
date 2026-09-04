-- PROSM Time - live UX review, user-directed: approving a correction
-- request (an employee's own request to fix a wrong clock-in/out time)
-- was purely cosmetic - only correction_requests.status changed,
-- nothing ever applied the proposed_correct_time anywhere. Approving
-- now actually writes it to attendance_sessions.clock_in_at/
-- clock_out_at (and the matching attendance_events row, so the two
-- stay consistent) - the same real-consequence principle just applied
-- to geofence exception reviews. Rejecting stays exactly as it is
-- today: only the decision is recorded, nothing changes.

begin;

create or replace function public.review_prosm_time_exception(
    p_kind text,
    p_target_id uuid,
    p_action_type text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_action_id uuid;
    v_ge geofence_exceptions%rowtype;
    v_cr correction_requests%rowtype;
    v_session attendance_sessions%rowtype;
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

    if p_kind not in ('geofence_exception', 'correction_request') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');

        perform public.create_prosm_time_notification(
            v_caller_org, v_ge.user_id, 'correction_reviewed', 'normal', 'Your exception was reviewed',
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id,
            jsonb_build_object('kind', 'exception', 'actionType', p_action_type)
        );
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;

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
