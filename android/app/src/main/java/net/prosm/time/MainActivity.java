package net.prosm.time;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * PROSM Time - Android host activity.
 *
 * Behaviour is unchanged from the stock Capacitor BridgeActivity; the
 * only addition is release hardening: remote WebView inspection
 * (chrome://inspect) is explicitly switched off in release builds so
 * the shipped bundle cannot be read or stepped through from a
 * connected machine. Debug builds are untouched.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(false);
        }
    }
}
