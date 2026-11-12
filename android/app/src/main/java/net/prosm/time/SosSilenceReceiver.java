package net.prosm.time;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The SOS notification's "Silence" button: stops the ringing (the alert stays in the app's bell). */
public class SosSilenceReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        SosMessagingService.silence(context);
    }
}
