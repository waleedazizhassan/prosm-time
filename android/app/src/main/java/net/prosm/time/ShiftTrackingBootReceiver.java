package net.prosm.time;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.app.NotificationCompat;

/**
 * Owner 2026-11-11: after the phone restarts (or the app is updated) during a shift, Android does not
 * let a location service start without the app on screen ("while using the app" permission). The
 * person is told at once: tapping the notification opens the app, which resumes following the shift.
 */
public class ShiftTrackingBootReceiver extends BroadcastReceiver {
    private static final int RESUME_NOTIFICATION_ID = 4713;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ShiftTrackingService.isActive(context)) return;
        SharedPreferences p = ShiftTrackingService.prefs(context);
        ShiftTrackingService.createChannels(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Notification notification = new NotificationCompat.Builder(context, "prosm-tracking-exit")
            .setSmallIcon(R.drawable.ic_stat_prosm)
            .setColor(0xFF1E6FD9)
            .setContentTitle(p.getString("resumeTitle", "PROSM Time"))
            .setContentText(p.getString("resumeBody", ""))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(p.getString("resumeBody", "")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(ShiftTrackingService.openApp(context))
            .build();
        manager.notify(RESUME_NOTIFICATION_ID, notification);
    }
}
