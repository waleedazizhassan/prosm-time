-- 2026-11-11 (owner): "notifications are slow and arrive late - make the app stronger." The checks that
-- raise notifications ran every 5 minutes (clock-in/out reminders, manager alerts, leaving a site) or 15
-- (open sessions), so a notice could wait that long before it was even created. They now run every
-- minute (open sessions every 5). Each check already keeps a log, so nothing is sent twice.
-- Rollback: schedule them again at '*/5 * * * *' (open sessions '*/15 * * * *').

select cron.unschedule('prosm-time-clock-reminders') where exists (select 1 from cron.job where jobname = 'prosm-time-clock-reminders');
select cron.schedule('prosm-time-clock-reminders', '* * * * *', $$select public.process_prosm_time_clock_reminders();$$);

select cron.unschedule('prosm-time-manager-alerts') where exists (select 1 from cron.job where jobname = 'prosm-time-manager-alerts');
select cron.schedule('prosm-time-manager-alerts', '* * * * *', $cron$select public.process_prosm_time_manager_alerts();$cron$);

select cron.unschedule('prosm-time-site-exits') where exists (select 1 from cron.job where jobname = 'prosm-time-site-exits');
select cron.schedule('prosm-time-site-exits', '* * * * *', $$select public.process_prosm_time_site_exits();$$);

select cron.unschedule('prosm-time-open-sessions') where exists (select 1 from cron.job where jobname = 'prosm-time-open-sessions');
select cron.schedule('prosm-time-open-sessions', '*/5 * * * *', $$select public.process_prosm_time_open_sessions();$$);
