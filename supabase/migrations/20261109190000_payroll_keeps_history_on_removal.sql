-- 2026-11-09 (spec acceptance: "history and approved payslips remain after an employee is
-- deactivated or removed"). The payroll tables referenced users with ON DELETE RESTRICT, so removing
-- anyone who had a payroll profile failed outright. Now:
--   * the payroll profile (current settings) goes with the person;
--   * their rows in past cycles stay - name, code, lines and totals are stored on the row, and the
--     approved snapshots are untouched - only the link to the removed account is cleared;
--   * installment plans stay with their payments, the link cleared.
-- Deactivation never deleted anything; it keeps everything as before.

begin;

alter table public.payroll_cycle_employees alter column user_id drop not null;
alter table public.payroll_installment_plans alter column user_id drop not null;

do $$
declare
    v record;
begin
    for v in
        select c.conrelid::regclass::text as tbl, c.conname, a.attname as col
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.confrelid = 'public.users'::regclass and a.attname = 'user_id'
          and c.conrelid in ('public.payroll_profiles'::regclass, 'public.payroll_cycle_employees'::regclass, 'public.payroll_installment_plans'::regclass)
    loop
        execute format('alter table %s drop constraint %I', v.tbl, v.conname);
        execute format('alter table %s add constraint %I foreign key (user_id) references public.users(id) on delete %s',
                       v.tbl, v.conname, case when v.tbl = 'payroll_profiles' then 'cascade' else 'set null' end);
    end loop;
end $$;

commit;
