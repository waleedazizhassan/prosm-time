package net.prosm.time;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Owner 2026-11-11 ("people move away from the sites and nothing happens until they open the app -
 * make it run in the background like WhatsApp, light on battery and data"): the shift is followed by
 * this service from clock-in to clock-out, also after the app is closed (stopWithTask=false). It sends
 * a location when the person has moved 50 m (at most once a minute), and every 5 minutes otherwise,
 * straight to the server with the shift's tracking key - one small request each time. The server
 * records it as the app would (leaving the site, exceptions and notifications follow at once) and
 * answers whether the shift is still on; when it is not, the service stops itself. It is a location
 * foreground service with its own quiet notification, started from the app on screen, so the "while
 * using the app" permission covers it (the app never asks for "Allow all the time").
 */
public class ShiftTrackingService extends Service implements LocationListener {
    static final String PREFS = "prosm_shift_tracking";
    private static final String CHANNEL = "prosm-tracking";
    private static final String EXIT_CHANNEL = "prosm-tracking-exit";
    private static final int NOTIFICATION_ID = 4711;
    private static final int EXIT_NOTIFICATION_ID = 4712;
    private static final long MIN_TIME_MS = 60_000L;
    private static final float MIN_DISTANCE_M = 50f;
    private static final long HEARTBEAT_MS = 5 * 60_000L;
    private static final long MIN_GAP_MS = 20_000L;
    // Owner 2026-11-11 ("there is offline recording - the server must not stop it"): locations that could
    // not be sent are kept (up to this many) and sent later with the time each was taken.
    private static final int QUEUE_MAX = 300;
    // A clock-in made offline reaches the server later: until the server has seen this shift once, "no
    // shift" does not stop the service (for up to this long).
    private static final long UNCONFIRMED_GRACE_MS = 12 * 3600_000L;
    private static final int SENT = 0;
    private static final int RETRY = 1;
    private static final int STOP = 2;

    private LocationManager locationManager;
    private Handler handler;
    private ExecutorService io;
    private Location last;
    private long lastSentAt = 0;
    private long lastSentFix = 0;

    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            Location known = bestKnown();
            if (known != null && (last == null || known.getTime() > last.getTime())) last = known;
            send(true);
            handler.postDelayed(this, HEARTBEAT_MS);
        }
    };

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isActive(Context context) {
        return prefs(context).getBoolean("active", false);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        io = Executors.newSingleThreadExecutor();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = prefs(this);
        if (!p.getBoolean("active", false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            Notification notification = ongoing(p.getString("title", "PROSM Time"), p.getString("text", ""));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception notAllowed) {
            // e.g. started from the background without a location permission: the app restarts it when opened
            stopSelf();
            return START_NOT_STICKY;
        }
        startUpdates();
        handler.removeCallbacks(heartbeat);
        handler.postDelayed(heartbeat, 5_000L);
        return START_STICKY;
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressWarnings("MissingPermission")
    private void startUpdates() {
        if (locationManager == null || !hasLocationPermission()) return;
        try {
            locationManager.removeUpdates(this);
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_TIME_MS, MIN_DISTANCE_M, this, Looper.getMainLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, MIN_TIME_MS, MIN_DISTANCE_M, this, Looper.getMainLooper());
            }
        } catch (Exception ignored) {
            // no provider or no permission: the heartbeat still sends the last known location
        }
    }

    @SuppressWarnings("MissingPermission")
    private Location bestKnown() {
        if (locationManager == null || !hasLocationPermission()) return null;
        Location best = null;
        for (String provider : new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                Location l = locationManager.getLastKnownLocation(provider);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (Exception ignored) {
                // provider unavailable
            }
        }
        return best;
    }

    @Override
    public void onLocationChanged(Location location) {
        // a much less accurate reading right after a good one is not taken over it
        if (last != null && location.hasAccuracy() && last.hasAccuracy()
            && location.getAccuracy() > 3 * last.getAccuracy() && location.getTime() - last.getTime() < 2 * MIN_TIME_MS) return;
        last = location;
        send(false);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    @Override
    public void onProviderEnabled(String provider) {
        startUpdates();
    }

    @Override
    public void onProviderDisabled(String provider) {
    }

    private void send(boolean heartbeatTick) {
        if (last == null) return;
        long now = System.currentTimeMillis();
        if (!heartbeatTick && now - lastSentAt < MIN_GAP_MS) return;
        // the same reading is not sent twice, except as the 5-minute "still here"
        if (!heartbeatTick && last.getTime() == lastSentFix) return;
        lastSentAt = now;
        lastSentFix = last.getTime();
        final JSONObject sample = sampleOf(last);
        io.execute(() -> deliver(sample));
    }

    private static String iso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    @SuppressWarnings("deprecation")
    private static JSONObject sampleOf(Location fix) {
        JSONObject sample = new JSONObject();
        try {
            sample.put("lat", fix.getLatitude());
            sample.put("lng", fix.getLongitude());
            sample.put("acc", fix.hasAccuracy() ? (double) fix.getAccuracy() : JSONObject.NULL);
            sample.put("at", iso(fix.getTime()));
            // Android's own "this location is simulated" (mock location apps)
            boolean simulated = Build.VERSION.SDK_INT >= 31 ? fix.isMock() : fix.isFromMockProvider();
            sample.put("sim", simulated);
        } catch (Exception ignored) {
            // a plain JSON object cannot fail here
        }
        return sample;
    }

    private JSONArray queue() {
        try {
            return new JSONArray(prefs(this).getString("queue", "[]"));
        } catch (Exception broken) {
            return new JSONArray();
        }
    }

    private void saveQueue(JSONArray queue) {
        while (queue.length() > QUEUE_MAX) queue.remove(0);
        prefs(this).edit().putString("queue", queue.toString()).apply();
    }

    /** The kept locations first (oldest first), then this one; anything not delivered stays kept. */
    private void deliver(JSONObject fresh) {
        JSONArray queue = queue();
        JSONArray left = new JSONArray();
        boolean stopNow = false;
        boolean blocked = false;
        for (int i = 0; i < queue.length(); i++) {
            JSONObject sample = queue.optJSONObject(i);
            if (sample == null) continue;
            if (blocked) {
                left.put(sample);
                continue;
            }
            int outcome = post(sample);
            if (outcome == RETRY) {
                left.put(sample);
                blocked = true;
            } else if (outcome == STOP) {
                stopNow = true;
                break;
            }
        }
        if (!stopNow) {
            int outcome = blocked ? RETRY : post(fresh);
            if (outcome == RETRY) left.put(fresh);
            if (outcome == STOP) stopNow = true;
        }
        saveQueue(stopNow ? new JSONArray() : left);
        if (stopNow) handler.post(this::finish);
    }

    private int post(JSONObject sample) {
        SharedPreferences p = prefs(this);
        String base = p.getString("url", null);
        String anon = p.getString("anonKey", null);
        String key = p.getString("key", null);
        // no key yet (a first clock-in made offline): kept until the app hands one over
        if (base == null || anon == null || key == null) return RETRY;
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject();
            body.put("p_key", key);
            body.put("p_latitude", sample.getDouble("lat"));
            body.put("p_longitude", sample.getDouble("lng"));
            body.put("p_accuracy", sample.opt("acc"));
            body.put("p_at", sample.has("at") ? sample.getString("at") : JSONObject.NULL);
            body.put("p_simulated", sample.optBoolean("sim", false));
            connection = (HttpURLConnection) new URL(base + "/rest/v1/rpc/record_prosm_time_location_by_key").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("apikey", anon);
            connection.setRequestProperty("Authorization", "Bearer " + anon);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) return RETRY;
            StringBuilder text = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line);
            }
            JSONObject result = new JSONObject(text.toString());
            if (result.optBoolean("active", true)) {
                p.edit().putBoolean("confirmed", true).apply();
                if (result.optBoolean("exitPrompted", false)) handler.post(this::showExit);
                return SENT;
            }
            if ("no_shift".equals(result.optString("reason", ""))) {
                // the shift ended - unless it has not reached the server yet (an offline clock-in)
                boolean confirmed = p.getBoolean("confirmed", false);
                long startedAt = p.getLong("startedAt", System.currentTimeMillis());
                if (!confirmed && System.currentTimeMillis() - startedAt < UNCONFIRMED_GRACE_MS) return RETRY;
                return STOP;
            }
            // the key is no longer valid: kept until the app hands over a new one
            return RETRY;
        } catch (Exception offline) {
            return RETRY;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void showExit() {
        SharedPreferences p = prefs(this);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Notification notification = new NotificationCompat.Builder(this, EXIT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_prosm)
            .setColor(0xFF1E6FD9)
            .setContentTitle(p.getString("exitTitle", "PROSM Time"))
            .setContentText(p.getString("exitBody", ""))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(p.getString("exitBody", "")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openApp(this))
            .build();
        manager.notify(EXIT_NOTIFICATION_ID, notification);
    }

    private void finish() {
        prefs(this).edit().putBoolean("active", false).putBoolean("confirmed", false).apply();
        if (locationManager != null) locationManager.removeUpdates(this);
        handler.removeCallbacks(heartbeat);
        stopForeground(true);
        stopSelf();
    }

    private Notification ongoing(String title, String text) {
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_prosm)
            .setColor(0xFF1E6FD9)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp(this))
            .build();
    }

    static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel quiet = new NotificationChannel(CHANNEL, "PROSM Time · shift", NotificationManager.IMPORTANCE_LOW);
        quiet.setShowBadge(false);
        manager.createNotificationChannel(quiet);
        NotificationChannel exit = new NotificationChannel(EXIT_CHANNEL, "PROSM Time · left the site", NotificationManager.IMPORTANCE_HIGH);
        exit.enableVibration(true);
        manager.createNotificationChannel(exit);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // the app was swiped away: the shift keeps being followed
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (locationManager != null) locationManager.removeUpdates(this);
        if (handler != null) handler.removeCallbacks(heartbeat);
        if (io != null) io.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
