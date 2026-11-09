-- 2026-11-09 load test (spec 15.15): the summary report of 1,000 employees took 85 s on the test
-- database. It added each employee to a growing JSON value one at a time (copying it every time)
-- and asked the permission question again for every employee. Now one set-based query builds the
-- list, and the permission is asked once per site. Same rules, same output, same order.

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_payroll_report(uuid, text, uuid[], uuid[], text)'::regprocedure);
    v_from integer := position('    for v_emp in select * from jsonb_array_elements(coalesce(v_data -> ''employees'', ''[]''::jsonb)) loop' in v_def);
    v_to integer := position('    if p_format <> ''preview'' then' in v_def);
    v_new text := $new$
    -- the permission once per site among the people in the report
    with people as (
        select e, ord from jsonb_array_elements(coalesce(v_data -> 'employees', '[]'::jsonb)) with ordinality x(e, ord)
        where (p_user_ids is null or (e ->> 'user_id')::uuid = any(p_user_ids))
          and (p_site_ids is null or nullif(e ->> 'site_id', '')::uuid = any(p_site_ids))
    ), sites as (
        select s.site, public.prosm_time_payroll_allows(v_key, s.site) as allowed
        from (select distinct nullif(e ->> 'site_id', '')::uuid as site from people) s
    ), scoped as (
        select p.e, p.ord, coalesce(si.allowed, false) as allowed
        from people p left join sites si on si.site is not distinct from nullif(p.e ->> 'site_id', '')::uuid
    )
    select
        coalesce(jsonb_agg((s.e - 'lines') || jsonb_build_object('lines', coalesce((
            -- report 1 and 2: only lines in the net (never the extra allowances); report 3: basic + allowances
            select jsonb_agg(l order by (l ->> 'sort_order')::int, l ->> 'name_ar')
            from jsonb_array_elements(s.e -> 'lines') l
            where case p_report_type
                      when 'payslip' then (l ->> 'show_in_payslip')::boolean and (l ->> 'include_in_net')::boolean
                      when 'summary' then (l ->> 'show_in_summary')::boolean and (l ->> 'include_in_net')::boolean
                      else (l ->> 'is_basic')::boolean or ((l ->> 'category') = 'allowance' and (l ->> 'include_in_combined')::boolean)
                  end), '[]'::jsonb)) order by s.ord) filter (where s.allowed), '[]'::jsonb),
        coalesce(jsonb_agg(jsonb_build_object('userId', s.e ->> 'user_id', 'fullName', s.e ->> 'full_name', 'reason', 'OUT_OF_SCOPE') order by s.ord)
                 filter (where not s.allowed), '[]'::jsonb)
    into v_employees, v_excluded
    from scoped s;

$new$;
begin
    if v_from = 0 or v_to = 0 or v_to < v_from then raise exception 'payroll report: loop not found'; end if;
    v_def := substring(v_def from 1 for v_from - 1) || v_new || substring(v_def from v_to);
    execute v_def;
end $$;

commit;
