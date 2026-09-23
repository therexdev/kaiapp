package com.oleddrift.screensaver;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.Choreographer;
import android.view.View;

import java.util.Random;

public class DriftView extends View implements Choreographer.FrameCallback {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Random random = new Random();
    private final RectF shape = new RectF();

    private float x = 120f;
    private float y = 120f;
    private float vx = 34f;
    private float vy = 27f;
    private float size = 42f;
    private float hue = 190f;
    private float phase = 0f;
    private long lastFrameNanos = 0L;
    private long lastDrawNanos = 0L;
    private boolean running = false;

    private static final long FRAME_INTERVAL_NANOS = 41_666_667L;

    public DriftView(Context context) {
        super(context);
        setBackgroundColor(Color.BLACK);
        paint.setStyle(Paint.Style.FILL);
    }

    public void start() {
        if (running) return;
        running = true;
        lastFrameNanos = 0L;
        lastDrawNanos = 0L;
        Choreographer.getInstance().postFrameCallback(this);
    }

    public void stop() {
        running = false;
        Choreographer.getInstance().removeFrameCallback(this);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        start();
    }

    @Override
    protected void onDetachedFromWindow() {
        stop();
        super.onDetachedFromWindow();
    }

    @Override
    public void doFrame(long frameTimeNanos) {
        if (!running) return;

        if (lastFrameNanos == 0L) lastFrameNanos = frameTimeNanos;

        if (lastDrawNanos == 0L || frameTimeNanos - lastDrawNanos >= FRAME_INTERVAL_NANOS) {
            float dt = Math.min((frameTimeNanos - lastFrameNanos) / 1_000_000_000f, 0.1f);
            update(dt);
            invalidate();
            lastDrawNanos = frameTimeNanos;
            lastFrameNanos = frameTimeNanos;
        }

        Choreographer.getInstance().postFrameCallback(this);
    }

    private void update(float dt) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;

        phase += dt;
        x += vx * dt;
        y += vy * dt;

        size = 38f + (float) Math.sin(phase * 0.31f) * 8f;

        float margin = size + 8f;
        boolean bounced = false;

        if (x < margin) {
            x = margin;
            vx = Math.abs(vx);
            bounced = true;
        } else if (x > w - margin) {
            x = w - margin;
            vx = -Math.abs(vx);
            bounced = true;
        }

        if (y < margin) {
            y = margin;
            vy = Math.abs(vy);
            bounced = true;
        } else if (y > h - margin) {
            y = h - margin;
            vy = -Math.abs(vy);
            bounced = true;
        }

        if (bounced) {
            vx += random.nextFloat() * 8f - 4f;
            vy += random.nextFloat() * 8f - 4f;
            hue = (hue + 31f + random.nextFloat() * 47f) % 360f;
        }

        hue = (hue + dt * 1.7f) % 360f;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);

        int color = Color.HSVToColor(145, new float[]{hue, 0.55f, 0.48f});
        paint.setColor(color);

        float pulse = 1f + (float) Math.sin(phase * 0.67f) * 0.08f;
        float half = size * pulse;
        shape.set(x - half, y - half, x + half, y + half);
        canvas.drawRoundRect(shape, half * 0.38f, half * 0.38f, paint);
    }
}
