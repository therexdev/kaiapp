package com.oleddrift.screensaver;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

public class MainActivity extends Activity {
    private DriftView driftView;
    private FrameLayout root;
    private View volumePanel;
    private SeekBar volumeSlider;
    private AudioManager audioManager;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final Runnable hideVolumeRunnable = this::hideVolumeControl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);

        setLowBrightness();
        enterImmersiveMode();

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        driftView = new DriftView(this);
        driftView.setOnDotTapListener(this::showVolumeControl);

        root.addView(
                driftView,
                new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                )
        );

        createVolumeControl();
        setContentView(root);
    }

    private void createVolumeControl() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.HORIZONTAL);
        panel.setGravity(Gravity.CENTER_VERTICAL);

        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(230, 22, 22, 22));
        background.setCornerRadius(dp(22));
        panel.setBackground(background);
        panel.setPadding(dp(8), dp(8), dp(8), dp(8));
        panel.setVisibility(View.GONE);
        panel.setAlpha(0f);

        TextView minusButton = createVolumeButton("−");
        TextView plusButton = createVolumeButton("+");

        volumeSlider = new SeekBar(this);
        volumeSlider.setMax(audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        volumeSlider.setProgress(audioManager.getStreamVolume(AudioManager.STREAM_MUSIC));
        volumeSlider.setPadding(dp(12), 0, dp(12), 0);
        volumeSlider.setMinimumHeight(dp(60));
        volumeSlider.setThumbTintList(ColorStateList.valueOf(Color.WHITE));
        volumeSlider.setProgressTintList(ColorStateList.valueOf(Color.rgb(112, 211, 255)));
        volumeSlider.setProgressBackgroundTintList(ColorStateList.valueOf(Color.rgb(72, 72, 72)));
        volumeSlider.setScaleY(1.35f);

        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(dp(58), dp(58));
        panel.addView(minusButton, buttonParams);

        LinearLayout.LayoutParams sliderParams = new LinearLayout.LayoutParams(
                0,
                dp(64),
                1f
        );
        sliderParams.leftMargin = dp(4);
        sliderParams.rightMargin = dp(4);
        panel.addView(volumeSlider, sliderParams);

        panel.addView(plusButton, new LinearLayout.LayoutParams(dp(58), dp(58)));

        minusButton.setOnClickListener(v -> changeVolumeBy(-1));
        plusButton.setOnClickListener(v -> changeVolumeBy(1));

        volumeSlider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser) {
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, progress, 0);
                    scheduleVolumeHide();
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {
                uiHandler.removeCallbacks(hideVolumeRunnable);
            }

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                scheduleVolumeHide();
            }
        });

        volumePanel = panel;

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(360), dp(76));
        root.addView(panel, params);
    }

    private TextView createVolumeButton(String label) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(32);
        button.setGravity(Gravity.CENTER);
        button.setClickable(true);
        button.setFocusable(true);

        GradientDrawable buttonBackground = new GradientDrawable();
        buttonBackground.setColor(Color.rgb(50, 50, 50));
        buttonBackground.setCornerRadius(dp(18));
        button.setBackground(buttonBackground);

        return button;
    }

    private void changeVolumeBy(int delta) {
        int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        int next = Math.max(0, Math.min(max, current + delta));

        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, next, 0);
        volumeSlider.setMax(max);
        volumeSlider.setProgress(next);
        scheduleVolumeHide();
    }

    private void showVolumeControl(float tapX, float tapY) {
        if (volumePanel == null) return;

        uiHandler.removeCallbacks(hideVolumeRunnable);

        volumeSlider.setMax(audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        volumeSlider.setProgress(audioManager.getStreamVolume(AudioManager.STREAM_MUSIC));

        int margin = dp(12);
        int panelHeight = dp(76);
        int desiredPanelWidth = dp(360);
        int rootWidth = Math.max(root.getWidth(), dp(300));
        int rootHeight = Math.max(root.getHeight(), panelHeight + margin * 2);
        int panelWidth = Math.min(desiredPanelWidth, rootWidth - margin * 2);
        panelWidth = Math.max(dp(290), panelWidth);
        int gap = dp(28);

        int left = Math.round(tapX - panelWidth / 2f);
        left = Math.max(margin, Math.min(left, rootWidth - panelWidth - margin));

        int top = Math.round(tapY + gap);
        if (top + panelHeight + margin > rootHeight) {
            top = Math.round(tapY - panelHeight - gap);
        }
        top = Math.max(margin, Math.min(top, rootHeight - panelHeight - margin));

        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) volumePanel.getLayoutParams();
        params.width = panelWidth;
        params.height = panelHeight;
        params.leftMargin = left;
        params.topMargin = top;
        volumePanel.setLayoutParams(params);

        volumePanel.animate().cancel();
        volumePanel.setVisibility(View.VISIBLE);
        volumePanel.animate()
                .alpha(1f)
                .setDuration(120)
                .start();

        scheduleVolumeHide();
    }

    private void scheduleVolumeHide() {
        uiHandler.removeCallbacks(hideVolumeRunnable);
        uiHandler.postDelayed(hideVolumeRunnable, 4000);
    }

    private void hideVolumeControl() {
        if (volumePanel == null || volumePanel.getVisibility() != View.VISIBLE) return;

        volumePanel.animate().cancel();
        volumePanel.animate()
                .alpha(0f)
                .setDuration(180)
                .withEndAction(() -> volumePanel.setVisibility(View.GONE))
                .start();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void setLowBrightness() {
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.screenBrightness = 0.08f;
        getWindow().setAttributes(params);
    }

    private void enterImmersiveMode() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersiveMode();
        if (driftView != null) driftView.start();
    }

    @Override
    protected void onPause() {
        uiHandler.removeCallbacks(hideVolumeRunnable);
        hideVolumeControl();
        if (driftView != null) driftView.stop();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }
}
