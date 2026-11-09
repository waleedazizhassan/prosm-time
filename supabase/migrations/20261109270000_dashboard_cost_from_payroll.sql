-- 2026-11-09 (owner tour): the dashboard's estimated cost used only the older pay rate on the person's
-- page, while the labour cost report now prices from the payroll basic salary. Both use the same
-- source now: the basic salary in the payroll profile first, the older rate only without one.
-- Rollback: restore get_prosm_time_manager_dashboard's "rates" CTE (worker_pay_rates only).

begin;

do $patch$
declare
    v_oid oid;
    v_def text;
    v_anchor text := '    rates as (
        select distinct on (w.user_id) w.user_id, w.rate_type, w.rate_amount
        from worker_pay_rates w where w.user_id = any(v_team) and w.effective_from <= p_to and (w.effective_to is null or w.effective_to >= p_from)
        order by w.user_id, w.effective_from desc
    )';
begin
    select p.oid into v_oid from pg_proc p where p.proname = 'get_prosm_time_manager_dashboard' and p.pronamespace = 'public'::regnamespace;
    v_def := pg_get_functiondef(v_oid);
    if position(v_anchor in v_def) = 0 then raise exception 'dashboard rates anchor not found'; end if;
    v_def := replace(v_def, v_anchor, '    rates as (
        -- the payroll basic salary first (monthly), the older pay rate only without one
        select distinct on (x.user_id) x.user_id, x.rate_type, x.rate_amount
        from (
            select p.user_id, ''MONTHLY''::text as rate_type, ppc.amount as rate_amount, 0 as pri, ppc.effective_from
            from payroll_profiles p
            join payroll_profile_components ppc on ppc.profile_id = p.id
            join payroll_components c on c.id = ppc.component_id and c.is_basic and c.calc_type = ''amount''
            where p.user_id = any(v_team) and p.is_active and ppc.effective_from <= p_to and (ppc.effective_to is null or ppc.effective_to >= p_from)
            union all
            select w.user_id, w.rate_type, w.rate_amount, 1, w.effective_from
            from worker_pay_rates w where w.user_id = any(v_team) and w.effective_from <= p_to and (w.effective_to is null or w.effective_to >= p_from)
        ) x
        order by x.user_id, x.pri, x.effective_from desc
    )');
    execute v_def;
end;
$patch$;

commit;
