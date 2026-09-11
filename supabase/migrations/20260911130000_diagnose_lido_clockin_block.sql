-- Temporary diagnostic RPC (SECURITY DEFINER, bypasses RLS internally)
-- to investigate a real user-reported bug: clocking in with the "Lido"
-- account (waleedelnhrawee@gmail.com) fails, while other accounts
-- clock in fine. Dropped by its own companion cleanup migration once
-- the investigation is done.
create or replace function public.diagnose_lido_clockin_issue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
begin
    select jsonb_build_object(
        'site', (select to_jsonb(s) from sites s where s.id = 'bc2564d0-44ea-42d1-888b-927cc0a4fd10'),
        'shift_templates', (select jsonb_agg(to_jsonb(st)) from shift_templates st where st.site_id = 'bc2564d0-44ea-42d1-888b-927cc0a4fd10'),
        'now_utc', now(),
        'recent_attendance', (
            select jsonb_agg(to_jsonb(a) order by a.created_at desc)
            from (select * from attendance_events where user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246' order by created_at desc limit 5) a
        ),
        'location_flags', (
            select jsonb_agg(to_jsonb(f))
            from location_plausibility_flags f where f.user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246'
        )
    ) into v_result;
    return v_result;
end;
$function$;

grant execute on function public.diagnose_lido_clockin_issue() to authenticated;
