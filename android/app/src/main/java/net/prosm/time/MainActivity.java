package net.prosm.time;

import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.security.MessageDigest;

/**
 * PROSM Time - Android host activity.
 *
 * Behaviour is unchanged from the stock Capacitor BridgeActivity; the
 * additions are release hardening:
 *  - remote WebView inspection (chrome://inspect) is switched off, so the
 *    shipped bundle cannot be read or stepped through from a connected
 *    machine;
 *  - v2.3.55 (owner 2026-10-27: "I modified the APK myself in a test - I
 *    want strong protection"): the app checks it is signed with PROSM's own
 *    release certificate. A copy that was unpacked, changed and signed again
 *    (the only way to install a modified APK) has another certificate, and
 *    refuses to run, pointing to the official download instead;
 *  - touches are ignored while another app draws over this one (tapjacking).
 * Debug builds are untouched.
 */
public class MainActivity extends BridgeActivity {
    // SHA-256 of PROSM Time's release signing certificate (CN=PROSM Time, O=PROSM, C=EG),
    // checked against the published APK with apksigner on 2026-10-27.
    private static final String RELEASE_CERT_SHA256 = "f5e747b81cc3d4490b6c60d2cc5cb7edcea730c3578dada5bf4b56bbb3811880";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (BuildConfig.DEBUG) return;

        WebView.setWebContentsDebuggingEnabled(false);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setFilterTouchesWhenObscured(true);
        }
        if (!signedByProsm()) {
            refuseModifiedCopy();
        }
    }

    private boolean signedByProsm() {
        try {
            Signature[] signatures;
            PackageManager manager = getPackageManager();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo info = manager.getPackageInfo(getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                if (info.signingInfo == null) return true;
                // a rotated key keeps its history: the original certificate is still in it
                signatures = info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
            } else {
                signatures = manager.getPackageInfo(getPackageName(), PackageManager.GET_SIGNATURES).signatures;
            }
            if (signatures == null || signatures.length == 0) return true;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (Signature signature : signatures) {
                if (RELEASE_CERT_SHA256.equals(hex(digest.digest(signature.toByteArray())))) return true;
            }
            return false;
        } catch (Exception error) {
            // Android could not answer: never lock a genuine user out on a
            // platform quirk - only a certificate that is read and differs refuses
            return true;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format("%02x", value));
        return out.toString();
    }

    private void refuseModifiedCopy() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().loadUrl("about:blank");
        }
        new AlertDialog.Builder(this)
            .setTitle("PROSM Time")
            .setMessage("هذه النسخة من التطبيق معدّلة ولا يمكن تشغيلها. حمّل النسخة الرسمية من prosm.net.\n\nThis copy of the app has been modified and cannot run. Download the official app from prosm.net.")
            .setCancelable(false)
            .setPositiveButton("prosm.net", (dialog, which) -> {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://time.prosm.net")));
                finishAndRemoveTask();
            })
            .setNegativeButton(android.R.string.cancel, (dialog, which) -> finishAndRemoveTask())
            .show();
    }
}
