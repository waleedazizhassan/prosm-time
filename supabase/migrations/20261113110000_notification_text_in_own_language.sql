-- Owner 2026-11-12 ("Buzz notifications are still not translated - check everything follows the translation"):
-- an app installed before a notification type was translated shows the text stored with the notification,
-- which was English. send-push now keeps that text in the person's own language (the same words the app
-- and the push use), so every app version shows it translated. The push message carries that language.
-- Rollback: restore get_prosm_time_push_message from 20261113100000.

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_push_message(uuid)'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def, '''notificationId'', n.id,', '''notificationId'', n.id, ''language'', public.prosm_time_user_language(n.user_id),');
    if v_new = v_def then raise exception 'get_prosm_time_push_message: notificationId not found'; end if;
    execute v_new;
end $$;

commit;
