package io.koinosai.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.widget.*;
import java.util.function.Consumer;

/** Foreground-only setup. Returning from an installer is never treated as proof of success. */
final class VoiceSetup {
    static final int MICROPHONE = 12;
    static final String GOOGLE_TTS = "com.google.android.tts";
    enum State { CHECKING, READY, MISSING_VOICE, MISSING_ENGINE, ERROR }
    static final class Result {
        final State state; final String engine;
        Result(State state, String engine) { this.state=state; this.engine=engine==null?"":engine; }
    }
    interface Speech {
        void check(Consumer<Result> callback);
        void preview(Runnable done, Consumer<String> error);
        void close();
    }
    static final class AndroidSpeech implements Speech {
        final KaiApp app;
        TextToSpeech probe;
        AndroidVoice.Speaker sample;
        int epoch;
        Runnable timeout;
        AndroidSpeech(KaiApp app) { this.app=app; }
        String engine() {
            if (probe!=null) try { String name=probe.getDefaultEngine();if(name!=null&&!name.isEmpty())return name; } catch (Exception ignored) {}
            String preferred=Settings.Secure.getString(app.getContentResolver(), "tts_default_synth");
            for (android.content.pm.ResolveInfo info : app.getPackageManager().queryIntentServices(
                    new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0)) {
                if (preferred!=null && preferred.equals(info.serviceInfo.packageName)) return preferred;
            }
            for (android.content.pm.ResolveInfo info : app.getPackageManager().queryIntentServices(
                    new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0)) return info.serviceInfo.packageName;
            return "";
        }
        @Override public void check(Consumer<Result> callback) {
            close(); int ticket=epoch;
            timeout=()->{
                if (ticket!=epoch) return;
                String name=engine(); close();
                callback.accept(new Result(name.isEmpty()?State.MISSING_ENGINE:State.ERROR,name));
            };
            app.main.postDelayed(timeout,10000);
            try {
                probe=new TextToSpeech(app,status->app.main.post(()->{
                    if (ticket!=epoch) return;
                    app.main.removeCallbacks(timeout);
                    String name=engine();
                    State state;
                    try {
                        android.speech.tts.Voice voice=status==TextToSpeech.SUCCESS?AndroidVoice.Speaker.offlineVoice(probe.getVoices()):null;
                        state=status!=TextToSpeech.SUCCESS?(name.isEmpty()?State.MISSING_ENGINE:State.ERROR):
                            voice!=null&&probe.setVoice(voice)==TextToSpeech.SUCCESS?State.READY:State.MISSING_VOICE;
                    } catch (Exception e) { state=State.ERROR; }
                    callback.accept(new Result(state,name));
                }));
            } catch (Exception e) {
                app.main.removeCallbacks(timeout);
                callback.accept(new Result(State.MISSING_ENGINE,engine()));
            }
        }
        @Override public void preview(Runnable done, Consumer<String> error) {
            if(sample!=null)sample.close();
            sample=new AndroidVoice.Speaker(app);
            sample.say("Hi, I'm KAI. My voice is ready. Let's talk.",done,error);
        }
        @Override public void close() {
            epoch++;
            if(timeout!=null)app.main.removeCallbacks(timeout);
            if(probe!=null){probe.shutdown();probe=null;}
            if(sample!=null){sample.close();sample=null;}
        }
    }

    final Activity activity; final KaiApp app; final boolean replies; final Runnable continuation;
    final Speech speech; final String owner;
    AlertDialog dialog; LinearLayout content;
    TextView downloadStatus;ProgressBar packProgress;boolean primaryShown;
    Result result=new Result(State.CHECKING,"");
    boolean foreground=true, disposed, mobileData, previewing, waitingPermission, external;
    int epoch; String note="", rendered="";
    VoiceSetup(Activity activity,KaiApp app,boolean replies,Runnable continuation) {
        this(activity,app,replies,continuation,new AndroidSpeech(app));
    }
    VoiceSetup(Activity activity,KaiApp app,boolean replies,Runnable continuation,Speech speech) {
        this.activity=activity;this.app=app;this.replies=replies;this.continuation=continuation;this.speech=speech;
        owner=app.account.owner();mobileData=!app.prefs.getBoolean("wifi",true);
    }
    void show() {
        content=new LinearLayout(activity);content.setOrientation(LinearLayout.VERTICAL);
        int pad=dp(22);content.setPadding(pad,dp(6),pad,dp(10));
        ScrollView scroll=new ScrollView(activity);scroll.setFillViewport(true);scroll.addView(content);
        dialog=new AlertDialog.Builder(activity).setTitle("Let's get KAI talking").setView(scroll)
            .setNegativeButton("Not now",(d,w)->close()).create();
        dialog.setOnDismissListener(d->close());
        dialog.show();refresh();checkSpeech();
    }
    int dp(int size) { return Math.round(size*activity.getResources().getDisplayMetrics().density); }
    boolean microphone() { return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED; }
    boolean allReady() { return app.voicePack.ready()&&microphone()&&(!replies||result.state==State.READY); }
    void checkSpeech() {
        if(disposed||!foreground)return;
        int ticket=++epoch;result=new Result(replies?State.CHECKING:State.READY,result.engine);rendered="";
        if(!replies){refresh();return;}
        speech.check(value->{if(!disposed&&foreground&&ticket==epoch){result=value;refresh();}});
        refresh();
    }
    void pause() { foreground=false;epoch++;speech.close();previewing=false; }
    void resume() {
        if(disposed)return;
        foreground=true;external=false;
        // Permission results update only microphone readiness; they cannot validate a voice installer.
        checkSpeech();
    }
    void permissionResult(boolean granted) {
        waitingPermission=false;
        note=granted?"":"KAI needs microphone access to hear you. Tap Allow microphone, then Allow. If Android no longer asks, open App settings → Permissions → Microphone → Allow while using the app.";
        if(foreground)refresh();
    }
    void refresh() {
        if(disposed||!foreground||dialog==null)return;
        if(!owner.equals(app.account.owner())){close();return;}
        if(allReady()&&continuation!=null&&!previewing&&!waitingPermission){
            close();continuation.run();return;
        }
        boolean downloading=app.voicePack.downloadId!=-1||app.voicePack.installing;
        if(downloadStatus!=null)downloadStatus.setText(app.voicePack.status.isEmpty()?"Preparing voice input…":app.voicePack.status);
        if(packProgress!=null){packProgress.setIndeterminate(app.voicePack.installing);packProgress.setProgress((int)Math.min(100,app.voicePack.downloaded*100/VoicePack.BYTES));}
        String packState=downloading?(app.voicePack.status.contains("paused")?"paused":"downloading"):app.voicePack.status;
        String key=app.voicePack.ready()+"|"+packState+"|"+app.voicePack.downloadId+"|"+app.voicePack.installing+"|"+app.networkAllowed()+"|"+result.state+"|"+microphone()+"|"+app.prefs.getBoolean("voice.micAsked",false)+"|"+note+"|"+previewing;
        if(key.equals(rendered))return;rendered=key;
        content.removeAllViews();downloadStatus=null;packProgress=null;primaryShown=false;
        dialog.getButton(DialogInterface.BUTTON_NEGATIVE).setText(allReady()?"Close":"Not now");
        label("A quick setup, then you can talk. KAI checks each step for you.",15,false);
        label((app.voicePack.ready()?"✓":"1")+"  Hear you",17,true);
        label(app.voicePack.ready()?"English voice input is ready and works offline.":"KAI needs a 41 MB English listening pack. It turns your speech into text on this device.",14,false);
        if(replies){
            label((result.state==State.READY?"✓":"2")+"  Talk back",17,true);
            label(result.state==State.READY?"An English speaking voice is ready offline.":
                result.state==State.CHECKING?"Checking your Android speaking voice…":
                result.state==State.MISSING_ENGINE?"Install an Android speech engine so KAI can answer aloud.":
                result.state==State.ERROR?"Android's speech engine did not respond. Retry the check or open voice settings.":
                "An English speaking voice needs to be downloaded in Android.",14,false);
        }
        label((microphone()?"✓":replies?"3":"2")+"  Microphone",17,true);
        label(microphone()?"Permission is ready. Listening begins only after you start.":"Allow microphone access when Android asks. KAI listens only during a visible voice session.",14,false);
        if(!note.isEmpty())label(note,14,true);
        if(!app.voicePack.ready()){
            boolean pending=app.voicePack.downloadId!=-1||app.voicePack.installing;
            if(pending){
                downloadStatus=label(app.voicePack.status.isEmpty()?"Preparing voice input…":app.voicePack.status,14,true);
                ProgressBar progress=new ProgressBar(activity,null,android.R.attr.progressBarStyleHorizontal);
                packProgress=progress;
                progress.setIndeterminate(app.voicePack.installing);progress.setMax(100);
                progress.setProgress((int)Math.min(100,app.voicePack.downloaded*100/VoicePack.BYTES));content.addView(progress);
                if(!app.voicePack.installing){
                    if(app.voicePack.status.contains("paused"))button("Download using mobile data",()->{mobileData=true;app.voicePack.cancel();download();});
                    button("Cancel download",()->{app.voicePack.cancel();refresh();});
                }
            }else{
                if(!app.voicePack.status.isEmpty())label(app.voicePack.status,14,true);
                label("Allow 160 MB of free space during setup. After setup, voice input works without internet.",13,false);
                CheckBox metered=new CheckBox(activity);metered.setText("Allow mobile data for this 41 MB download");metered.setChecked(mobileData);
                metered.setOnCheckedChangeListener((v,on)->mobileData=on);content.addView(metered);
                button(app.networkAllowed()?"Download voice input · 41 MB":"Go online & download · 41 MB",this::download);
            }
        }else if(replies&&result.state!=State.READY){
            if(result.state!=State.CHECKING){
                if(result.state==State.MISSING_ENGINE){
                    label("Tap Install, install Speech Recognition & Synthesis from Google, then return to KAI. If asked, choose it as your preferred engine in Android voice settings.",14,false);
                    button("Install speech engine",this::openEngineStore);
                }else if(result.state==State.MISSING_VOICE){
                    label("Tap Install English voice. In Android, choose English and tap its download button. Return to KAI when it finishes; we'll check automatically.",14,false);
                    button("Install English voice",this::installVoice);
                }else{
                    button("Install or update speech engine",this::openEngineStore);
                }
                button("Android voice settings",this::openVoiceSettings);
                button("Check again",this::checkSpeech);
            }
        }else if(!microphone()){
            boolean asked=app.prefs.getBoolean("voice.micAsked",false);
            if(asked&&!activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)){
                label("In App settings, choose Permissions → Microphone → Allow while using the app. Then return to KAI.",14,false);
                button("Open microphone settings",this::openMicrophoneSettings);
            }else button("Allow microphone",()->{
                app.prefs.edit().putBoolean("voice.micAsked",true).apply();waitingPermission=true;
                activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},MICROPHONE);
            });
        }else{
            label("You're all set. Return to KAI and tap Talk to KAI.",15,true);
            if(replies)button(previewing?"Stop voice test":"Test KAI's voice",this::preview);
        }
        // A voice can be tested before the microphone has been granted.
        if(replies&&result.state==State.READY&&!microphone())button(previewing?"Stop voice test":"Test KAI's voice",this::preview);
    }
    void download() {
        note="";if(!app.networkAllowed())app.setNetworkEnabled(true);
        app.voicePack.download(mobileData);
        if(app.voicePack.downloadId==-1&&!app.voicePack.ready()&&!app.error.isEmpty()){note=app.error;app.clearError();}
        refresh();
    }
    void preview() {
        if(previewing){previewing=false;speech.close();checkSpeech();return;}
        previewing=true;note="Playing a short voice test. Turn up media volume if needed.";refresh();int ticket=epoch;
        speech.preview(()->{if(!disposed&&foreground&&ticket==epoch){previewing=false;note="Voice test finished. If you heard nothing, turn up media volume and test again.";refresh();}},
            message->{if(!disposed&&foreground&&ticket==epoch){previewing=false;result=new Result(State.ERROR,result.engine);note=message;refresh();}});
    }
    boolean launch(Intent intent) {
        try{external=true;activity.startActivity(intent);return true;}
        catch(ActivityNotFoundException|SecurityException e){external=false;return false;}
    }
    void installVoice() {
        Intent intent=new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
        if(!result.engine.isEmpty())intent.setPackage(result.engine);
        if(!launch(intent)){note="This Android voice has no direct installer. In voice settings, select your preferred engine, open its settings, then download English.";openVoiceSettings();}
    }
    void openVoiceSettings() {
        if(!launch(new Intent("com.android.settings.TTS_SETTINGS"))){
            note="This device has no direct voice settings screen. Open Android Settings and search for Text-to-speech. Choose an engine, then download English.";
            if(!launch(new Intent(Settings.ACTION_SETTINGS)))note="Android settings could not open. Open your device's Settings app, search for Text-to-speech, and download English. You can still type in KAI.";
        }
        refresh();
    }
    void openMicrophoneSettings() {
        if(!launch(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+activity.getPackageName())))){
            note="Open Android Settings → Apps → KAI → Permissions → Microphone and allow access.";refresh();
        }
    }
    void openEngineStore() {
        note="Install Speech Recognition & Synthesis from Google, then return to KAI.";
        if(!launch(new Intent(Intent.ACTION_VIEW,Uri.parse("market://details?id="+GOOGLE_TTS)))&&
           !launch(new Intent(Intent.ACTION_VIEW,Uri.parse("https://play.google.com/store/apps/details?id="+GOOGLE_TTS)))){
            note="No app store or browser could open. Install a text-to-speech engine from your device's app store, then choose it in Android voice settings. You can still type in KAI.";
        }
        refresh();
    }
    TextView label(String value,int size,boolean bold) {
        TextView view=new TextView(activity);view.setText(value);view.setTextSize(size);view.setTextColor(bold?0xff14284e:0xff61728d);
        if(bold)view.setTypeface(null,android.graphics.Typeface.BOLD);
        view.setPadding(0,dp(bold?14:6),0,dp(3));content.addView(view);return view;
    }
    void button(String title,Runnable action) {
        boolean primary=!primaryShown&&!title.startsWith("Cancel")&&!title.equals("Android voice settings")&&!title.equals("Check again");
        if(primary)primaryShown=true;
        Button button=new Button(activity);button.setAllCaps(false);button.setText(title);button.setTextSize(14);button.setTextColor(primary?0xffffffff:0xff155eef);
        android.graphics.drawable.GradientDrawable background=new android.graphics.drawable.GradientDrawable();
        background.setCornerRadius(dp(12));background.setColor(primary?0xff155eef:0xffeef3fc);
        button.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x33155eef),background,null));
        button.setPadding(dp(12),dp(8),dp(12),dp(8));
        button.setMinHeight(dp(48));button.setOnClickListener(v->{if(foreground&&!disposed)action.run();});
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(10);content.addView(button,params);
    }
    void close() {
        if(disposed)return;disposed=true;epoch++;speech.close();
        if(dialog!=null&&dialog.isShowing())dialog.dismiss();
    }
}
