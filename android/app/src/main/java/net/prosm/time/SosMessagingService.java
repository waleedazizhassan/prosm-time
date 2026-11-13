package net.prosm.time;

import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Owner 2026-11-12 ("the SOS must ring even when the phone is on silent, and open on the whole screen like a
 * call"): the server sends an SOS to this app as a data message (send-push, only to phones that said they
 * can take it - set_prosm_time_push_device_alarm), so this service gets it even with the app closed and the
 * screen locked. It rings with the alarm tone on the alarm stream, again and again until it is opened or
 * silenced (at most two minutes), and lights the screen with SosAlarmActivity over the lock screen.
 * Everything else is the Capacitor plugin's as before (the app's listeners, the token).
 */
public class SosMessagingService extends MessagingService {
    static final String SOS_CHANNEL_ID = "prosm-sos-alarm";
    static final int SOS_NOTIFICATION_ID = 7110;
    static final String CALL_CHANNEL_ID = "prosm-connect-calls";
    static final int CALL_NOTIFICATION_ID = 7120;
    static final String EXTRA_PUSH = "prosm.push";
    private static final long RING_FOR_MS = 120_000L;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        // PROSM Connect (owner 2026-11-13): a call rings like a phone call - also closed and locked
        if (message.getNotification() == null && "connect_call".equals(data.get("type"))) {
            if (!appOnScreen(this)) showConnectCall(this, message.getMessageId(), data);
            return;
        }
        if (message.getNotification() != null || !"sos_alert".equals(data.get("type"))) return;
        // the app on screen shows its own SOS window (it got the message just above)
        if (appOnScreen(this)) return;
        showSosAlarm(this, message.getMessageId(), data);
    }

    private static boolean appOnScreen(Context context) {
        try {
            KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
            if (keyguard != null && keyguard.isKeyguardLocked()) return false;
            ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(info);
            return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
        } catch (Exception error) {
            return false;
        }
    }

    static void ensureSosChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null || manager.getNotificationChannel(SOS_CHANNEL_ID) != null) return;
            NotificationChannel channel = new NotificationChannel(SOS_CHANNEL_ID, context.getString(R.string.sos_channel_name), NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(context.getString(R.string.sos_channel_description));
            channel.setSound(alarmTone(), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] {0, 1000, 500, 1000, 500, 1000});
            channel.enableLights(true);
            channel.setLightColor(0xFFDC2626);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            // honoured only if the person lets the app through Do Not Disturb
            channel.setBypassDnd(true);
            manager.createNotificationChannel(channel);
        } catch (Exception error) {
            // without it the SOS still arrives, on the regular channel
        }
    }

    private static Uri alarmTone() {
        Uri tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        return tone != null ? tone : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
    }

    /** The push's data as the app expects a tapped notification (the Capacitor plugin reads google.message_id). */
    static Intent openAppIntent(Context context, Bundle push) {
        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (push != null) open.putExtras(push);
        return open;
    }

    static void silence(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(SOS_NOTIFICATION_ID);
            // an incoming PROSM Connect call stops ringing once the app is open (its own screen rings there)
            manager.cancel(CALL_NOTIFICATION_ID);
        }
    }

    private static String text(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    static void showSosAlarm(Context context, String messageId, Map<String, String> data) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureSosChannel(context);
        String title = text(data.get("title"), context.getString(R.string.sos_default_title));
        String body = text(data.get("body"), "");

        Bundle push = new Bundle();
        push.putString("google.message_id", text(messageId, "sos-" + System.currentTimeMillis()));
        for (Map.Entry<String, String> entry : data.entrySet()) {
            if (!"title".equals(entry.getKey()) && !"body".equals(entry.getKey())) push.putString(entry.getKey(), entry.getValue());
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent openApp = PendingIntent.getActivity(context, 7111, openAppIntent(context, push), flags);

        Intent screen = new Intent(context, SosAlarmActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            .putExtra("title", title)
            .putExtra("body", body)
            .putExtra(EXTRA_PUSH, push);
        PendingIntent fullScreen = PendingIntent.getActivity(context, 7112, screen, flags);
        PendingIntent silence = PendingIntent.getBroadcast(context, 7113, new Intent(context, SosSilenceReceiver.class), flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, SOS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_prosm)
            .setColor(0xFFDC2626)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(alarmTone(), AudioManager.STREAM_ALARM)
            .setVibrate(new long[] {0, 1000, 500, 1000, 500, 1000})
            .setAutoCancel(true)
            .setTimeoutAfter(RING_FOR_MS)
            .setContentIntent(openApp)
            .setFullScreenIntent(fullScreen, true)
            .addAction(0, context.getString(R.string.sos_open), openApp)
            .addAction(0, context.getString(R.string.sos_silence), silence);
        Notification notification = builder.build();
        // rings again and again until opened or silenced
        notification.flags |= Notification.FLAG_INSISTENT;
        try {
            manager.notify(SOS_NOTIFICATION_ID, notification);
        } catch (SecurityException error) {
            // notifications turned off for the app
        }
    }

    // PROSM Connect: the incoming call's own channel - the ringtone, vibration, over the lock screen
    static void ensureCallChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null || manager.getNotificationChannel(CALL_CHANNEL_ID) != null) return;
            NotificationChannel channel = new NotificationChannel(CALL_CHANNEL_ID, context.getString(R.string.connect_call_channel_name), NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(context.getString(R.string.connect_call_channel_description));
            Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            channel.setSound(ring != null ? ring : alarmTone(), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] {0, 800, 600, 800, 600});
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(channel);
        } catch (Exception error) {
            // without it the call still shows, on the default channel
        }
    }

    /** An incoming PROSM Connect call: rings until answered in the app or 45 seconds pass. */
    static void showConnectCall(Context context, String messageId, Map<String, String> data) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureCallChannel(context);
        String title = text(data.get("title"), "PROSM Connect");
        String body = text(data.get("body"), "");
        Bundle push = new Bundle();
        push.putString("google.message_id", text(messageId, "call-" + System.currentTimeMillis()));
        for (Map.Entry<String, String> entry : data.entrySet()) {
            if (!"title".equals(entry.getKey()) && !"body".equals(entry.getKey())) push.putString(entry.getKey(), entry.getValue());
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // opening the app shows the ringing screen (the call waits in the switchboard)
        PendingIntent openApp = PendingIntent.getActivity(context, 7121, openAppIntent(context, push).putExtra("connectCall", true), flags);
        Intent screen = new Intent(context, SosAlarmActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            .putExtra("title", title)
            .putExtra("body", body)
            .putExtra(EXTRA_PUSH, push);
        PendingIntent fullScreen = PendingIntent.getActivity(context, 7122, screen, flags);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CALL_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_prosm)
            .setColor(0xFF1E6FD9)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(45_000L)
            .setContentIntent(openApp)
            .setFullScreenIntent(fullScreen, true)
            .addAction(0, context.getString(R.string.connect_call_open), openApp);
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        try {
            manager.notify(CALL_NOTIFICATION_ID, notification);
        } catch (SecurityException error) {
            // notifications turned off for the app
        }
    }
}
