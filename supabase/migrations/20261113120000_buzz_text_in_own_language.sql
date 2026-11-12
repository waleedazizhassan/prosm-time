-- Owner 2026-11-12 ("Buzz notifications are still not translated"): the Buzz notifications already sent keep
-- their text in each person's own language too (send-push does it for new ones), so an app from before the Buzz
-- translation shows them translated. Texts from shell.json notifications.buzz.
-- Rollback: none needed (the app writes a Buzz from its data; the stored text is only a fallback).

begin;

with texts (language, title, clock_in, clock_out, call_me, attention) as (
    values
        ('ar', 'تنبيه من {{name}}', 'سجّل حضورك من فضلك.', 'سجّل انصرافك من فضلك.', 'كلّمني من فضلك.', 'افتح البرنامج من فضلك.'),
        ('de', 'Buzz von {{name}}', 'Bitte einstempeln.', 'Bitte ausstempeln.', 'Bitte ruf mich an.', 'Bitte schau in die App.'),
        ('en', 'Buzz from {{name}}', 'Please clock in.', 'Please clock out.', 'Please call me.', 'Please check the app.'),
        ('es', 'Aviso de {{name}}', 'Por favor, ficha la entrada.', 'Por favor, ficha la salida.', 'Por favor, llámame.', 'Por favor, revisa la app.'),
        ('fr', 'Buzz de {{name}}', 'Merci de pointer ton arrivée.', 'Merci de pointer ton départ.', 'Merci de m’appeler.', 'Merci de regarder l’application.'),
        ('it', 'Avviso da {{name}}', 'Per favore, timbra l’entrata.', 'Per favore, timbra l’uscita.', 'Per favore, chiamami.', 'Per favore, guarda l’app.'),
        ('pt', 'Alerta de {{name}}', 'Por favor, registe a entrada.', 'Por favor, registe a saída.', 'Por favor, ligue-me.', 'Por favor, veja o app.'),
        ('ru', 'Сигнал от {{name}}', 'Пожалуйста, отметьте приход.', 'Пожалуйста, отметьте уход.', 'Пожалуйста, позвоните мне.', 'Пожалуйста, откройте приложение.'),
        ('zh', '来自 {{name}} 的提醒', '请打卡上班。', '请打卡下班。', '请给我回电话。', '请查看应用。')
)
update public.notifications n set
    title = replace(t.title, '{{name}}', coalesce(n.data ->> 'fromName', '')),
    body = coalesce(nullif(btrim(coalesce(n.data ->> 'message', '')), ''),
                    case n.data ->> 'reason' when 'clock_in' then t.clock_in when 'clock_out' then t.clock_out
                                             when 'call_me' then t.call_me else t.attention end)
from texts t
where n.type = 'buzz' and t.language = public.prosm_time_user_language(n.user_id);

commit;
