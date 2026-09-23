package com.oleddrift.screensaver;

import android.app.Activity;
import android.content.Context;
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
import android.widget.SeekBar;

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
        FrameLayout panel = new FrameLayout(this);

        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(220, 24, 24, 24));
        background.setCornerRadius(dp(18));
        panel.setBackground(background);
        panel.setPadding(dp(14), dp(8), dp(14), dp(8));
        panel.setVisibility(View.GONE);
        panel.setAlpha(0f);

        volumeSlider = new SeekBar(this);
        volumeSlider.setMax(audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        volumeSlider.setProgress(audioManager.getStreamVolume(AudioManager.STREAM_MUSIC));

        FrameLayout.LayoutParams sliderParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        );
        panel.addView(volumeSlider, sliderParams);

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

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(280), dp(58));
        root.addView(panel, params);
    }

    private void showVolumeControl(float tapX, float tapY) {
        if (volumePanel == null) return;

        uiHandler.removeCallbacks(hideVolumeRunnable);

        volumeSlider.setMax(audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        volumeSlider.setProgress(audioManager.getStreamVolume(AudioManager.STREAM_MUSIC));

        int panelWidth = dp(280);
        int panelHeight = dp(58);
        int margin = dp(12);
        int gap = dp(26);

        int availableWidth = Math.max(root.getWidth(), panelWidth + margin * 2);
        int availableHeight = Math.max(root.getHeight(), panelHeight + margin * 2);

        int left = Math.round(tapX - panelWidth / 2f);
        left = Math.max(margin, Math.min(left, availableWidth - panelWidth - margin));

        int top = Math.round(tapY + gap);
        if (top + panelHeight + margin > availableHeight) {
            top = Math.round(tapY - panelHeight - gap);
        }
        top = Math.max(margin, Math.min(top, availableHeight - panelHeight - margin));

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
        uiHandler.postDelayed(hideVolumeRunnable, 3500);
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
