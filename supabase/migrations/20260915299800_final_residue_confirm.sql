do $final$
declare v_n integer;
begin
    select count(*) into v_n from notifications where organization_id = 'cef9fc27-343d-4194-8167-033d1823b3d0';
    raise notice 'FINAL notifications count: % (baseline was 59)', v_n;
end;
$final$;
