package net.prosm.time;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Owner 2026-11-12: an SOS opens on the whole screen, also over the lock screen, like a call. It shows who
 * asked for help; "Open" unlocks the phone and opens the alert in the app (its location is there), "Silence"
 * stops the ringing. Nothing of the app is shown before the phone is unlocked.
 */
public class SosAlarmActivity extends Activity {
    private Bundle push;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (!BuildConfig.DEBUG) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        render(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        render(intent);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private Button button(String label, int background, int foreground) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(foreground);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(background);
        shape.setCornerRadius(dp(28));
        button.setBackground(shape);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        params.topMargin = dp(12);
        button.setLayoutParams(params);
        return button;
    }

    private void render(Intent intent) {
        push = intent.getBundleExtra(SosMessagingService.EXTRA_PUSH);
        // owner 2026-11-14: an incoming call has its own screen - never the red SOS one
        if (intent.getBooleanExtra("connectCall", false)) {
            renderCall(intent);
            return;
        }
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(24), dp(48), dp(24), dp(48));
        root.setBackgroundColor(Color.parseColor("#B91C1C"));

        TextView badge = new TextView(this);
        badge.setText("SOS");
        badge.setTextColor(Color.WHITE);
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 56);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setGravity(Gravity.CENTER);
        root.addView(badge);

        TextView heading = new TextView(this);
        heading.setText(title == null || title.isEmpty() ? getString(R.string.sos_default_title) : title);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setGravity(Gravity.CENTER);
        heading.setPadding(0, dp(16), 0, dp(8));
        root.addView(heading);

        if (body != null && !body.isEmpty()) {
            TextView text = new TextView(this);
            text.setText(body);
            text.setTextColor(Color.parseColor("#FEE2E2"));
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            text.setGravity(Gravity.CENTER);
            text.setPadding(0, 0, 0, dp(32));
            root.addView(text);
        }

        Button open = button(getString(R.string.sos_open), Color.WHITE, Color.parseColor("#B91C1C"));
        open.setOnClickListener((View view) -> openInApp());
        root.addView(open);
        Button silence = button(getString(R.string.sos_silence), Color.parseColor("#7F1D1D"), Color.WHITE);
        silence.setOnClickListener((View view) -> {
            SosMessagingService.silence(this);
            finish();
        });
        root.addView(silence);

        setContentView(root);
    }

    /** An incoming call: dark blue like the app, the caller's name, decline and answer. */
    private void renderCall(Intent intent) {
        String name = intent.getStringExtra("title");
        String kind = intent.getStringExtra("body");
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(24), dp(72), dp(24), dp(56));
        GradientDrawable ground = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] {Color.parseColor("#0B2A4A"), Color.parseColor("#060B1A")});
        root.setBackground(ground);

        TextView brand = new TextView(this);
        brand.setText("PROSM Time");
        brand.setTextColor(Color.parseColor("#7DD3FC"));
        brand.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        brand.setGravity(Gravity.CENTER);
        root.addView(brand);

        TextView avatar = new TextView(this);
        String initial = name == null || name.trim().isEmpty() ? "?" : name.trim().substring(0, 1).toUpperCase();
        avatar.setText(initial);
        avatar.setTextColor(Color.parseColor("#60A5FA"));
        avatar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 44);
        avatar.setTypeface(Typeface.DEFAULT_BOLD);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.parseColor("#13294B"));
        circle.setStroke(dp(3), Color.parseColor("#1E6FD9"));
        avatar.setBackground(circle);
        LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(120), dp(120));
        avatarParams.topMargin = dp(56);
        avatar.setLayoutParams(avatarParams);
        root.addView(avatar);

        TextView heading = new TextView(this);
        heading.setText(name == null || name.isEmpty() ? "PROSM Time" : name);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setGravity(Gravity.CENTER);
        heading.setPadding(0, dp(20), 0, dp(6));
        root.addView(heading);

        TextView sub = new TextView(this);
        sub.setText(kind == null || kind.isEmpty() ? getString(R.string.connect_call_incoming) : kind);
        sub.setTextColor(Color.parseColor("#93A2C4"));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        sub.setGravity(Gravity.CENTER);
        root.addView(sub);

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        Button decline = button(getString(R.string.connect_call_decline), Color.parseColor("#DC2626"), Color.WHITE);
        decline.setOnClickListener((View view) -> {
            SosMessagingService.silence(this);
            finish();
        });
        Button answer = button(getString(R.string.connect_call_answer), Color.parseColor("#16A34A"), Color.WHITE);
        answer.setOnClickListener((View view) -> openInApp());
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, dp(60), 1f);
        half.setMarginStart(dp(8));
        half.setMarginEnd(dp(8));
        row.addView(decline, half);
        row.addView(answer, new LinearLayout.LayoutParams(half));
        root.addView(row, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);
    }

    private void openInApp() {
        SosMessagingService.silence(this);
        Intent open = SosMessagingService.openAppIntent(this, push);
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && keyguard != null && keyguard.isKeyguardLocked()) {
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    startActivity(open);
                    finish();
                }
            });
            return;
        }
        startActivity(open);
        finish();
    }
}
