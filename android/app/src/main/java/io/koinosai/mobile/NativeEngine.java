package io.koinosai.mobile;

final class NativeEngine {
    static final String unavailable;
    static {
        String failure = null;
        try { System.loadLibrary("kai-inference"); }
        catch (UnsatisfiedLinkError e) { failure = "This preview requires a 64-bit ARM Android device."; }
        unavailable = failure;
    }
    interface Callback { void onText(byte[] text, int tokens, int droppedTurns); }
    static native void resetCancel();
    static native void cancel();
    static native void load(byte[] path, int context, int threads);
    static native void unload();
    static native int[] generate(byte[][] roles, byte[][] contents, int maxTokens, float temperature, Callback callback);
}
