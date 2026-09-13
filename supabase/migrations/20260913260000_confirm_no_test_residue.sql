-- PROSM Time - confirm the rolled-back verification migrations left
-- zero residue in the real database.
do $$
declare
    v_projects int;
    v_assignments int;
begin
    select count(*) into v_projects from projects where name like '__audit_test%';
    select count(*) into v_assignments from project_assignments;
    raise notice 'residual test projects=% (expect 0), total real project_assignments=% (expect 0)', v_projects, v_assignments;
end $$;
