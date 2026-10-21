-- Owner 2026-10-21 (the review's "things we don't need", approved): the
-- employees' kiosk (pick your name, type a PIN) has been switched off since
-- 2026-10-19 - the kiosk is for external workers only, who use the number
-- the app gives them, and employees clock in from their own app. Its
-- functions, the PIN column and the roster are removed, which also removes
-- the PIN-guessing surface the security review found (H1/H2).

begin;

-- Personal-data deletion cleared the PIN; that line goes with the column.
do $$
declare
    v_def text;
    v_line constant text := 'update users set kiosk_pin_hash = null where id = p_user_id;';
begin
    v_def := pg_get_functiondef('public.delete_prosm_time_employee_data(uuid, uuid, text)'::regprocedure);
    if position(v_line in v_def) > 0 then
        execute replace(v_def, v_line, '');
    end if;
end;
$$;

do $$
declare
    v_fn record;
begin
    for v_fn in
        select p.oid::regprocedure as signature
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
              'kiosk_clock_in_prosm_time_attendance', 'kiosk_clock_in_prosm_time_attendance_unchecked',
              'kiosk_clock_out_prosm_time_attendance', 'kiosk_clock_out_prosm_time_attendance_unchecked',
              'set_prosm_time_kiosk_pin', 'admin_set_prosm_time_kiosk_pin', 'admin_set_prosm_time_kiosk_pin_unchecked',
              'list_prosm_time_kiosk_roster', 'prosm_time_caller_operates_kiosk')
    loop
        execute format('drop function if exists %s', v_fn.signature);
    end loop;
end;
$$;

alter table public.users drop column if exists kiosk_pin_hash;

commit;
