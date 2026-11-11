package net.prosm.time;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Owner 2026-11-11: the app's side of ShiftTrackingService - start it at clock-in (with the server
 * address, the public key and the shift's tracking key, and the texts in the person's language), stop
 * it at clock-out, and say whether the phone is ready for it (location, notifications, battery).
 */
@CapacitorPlugin(name = "ShiftTracking")
public class ShiftTrackingPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String anonKey = call.getString("anonKey");
        String key = call.getString("key");
        if (url == null || anonKey == null || key == null) {
            call.reject("url, anonKey and key are required");
            return;
        }
        Context context = getContext();
        ShiftTrackingService.prefs(context).edit()
            .putBoolean("active", true)
            .putString("url", url)
            .putString("anonKey", anonKey)
            .putString("key", key)
            .putString("title", call.getString("title", "PROSM Time"))
            .putString("text", call.getString("text", ""))
            .putString("exitTitle", call.getString("exitTitle", "PROSM Time"))
            .putString("exitBody", call.getString("exitBody", ""))
            .putString("resumeTitle", call.getString("resumeTitle", "PROSM Time"))
            .putString("resumeBody", call.getString("resumeBody", ""))
            .apply();
        try {
            ContextCompat.startForegroundService(context, new Intent(context, ShiftTrackingService.class));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "could not start" : error.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        ShiftTrackingService.prefs(context).edit().putBoolean("active", false).remove("key").apply();
        context.stopService(new Intent(context, ShiftTrackingService.class));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        JSObject result = new JSObject();
        result.put("active", ShiftTrackingService.isActive(context));
        result.put("location", fine || coarse);
        result.put("preciseLocation", fine);
        result.put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("ignoringBattery", power == null || power.isIgnoringBatteryOptimizations(context.getPackageName()));
        call.resolve(result);
    }

    /** The phone's "battery optimisation" list, where PROSM Time is set to "not optimised". */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context context = getContext();
        try {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception noScreen) {
            openDetails(context);
        }
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openDetails(getContext());
        call.resolve();
    }

    private static void openDetails(Context context) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
}
