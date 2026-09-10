-- Read-only confirmation, kept as real migration history: verifies
-- 20260910140000's pg_cron job actually registered and is active.
do $$
declare
    v_job record;
begin
    select jobname, schedule, active into v_job from cron.job where jobname = 'prosm-time-missing-clockout-check';
    if v_job.jobname is null then
        raise exception 'CRON JOB NOT FOUND';
    end if;
    raise notice 'CRON JOB CONFIRMED: name=%, schedule=%, active=%', v_job.jobname, v_job.schedule, v_job.active;
end $$;
