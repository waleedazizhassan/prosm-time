-- Fixes a real syntax bug in the previous migration (ORDER BY inside
-- a jsonb_agg subquery referencing a column not in the aggregate).
create or replace function public.diagnose_lido_clockin_after_fix()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    return jsonb_build_object(
        'all_sites', (select jsonb_agg(to_jsonb(s)) from sites s where s.organization_id = 'cef9fc27-343d-4194-8167-033d1823b3d0'),
        'lido_user', (select to_jsonb(u) from users u where u.id = '347ea231-ad1e-4481-a633-dba1ed3c4246'),
        'lido_site_assignments', (select jsonb_agg(to_jsonb(sa)) from site_assignments sa where sa.user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246'),
        'lido_open_attendance', (select jsonb_agg(to_jsonb(a)) from (select * from attendance_events where user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246' and event_type = 'clock_in' order by created_at desc limit 3) a)
    );
end;
$function$;
