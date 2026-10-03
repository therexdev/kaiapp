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
        final State state; final String engine,detail;
        Result(State state, String engine) { this(state,engine,""); }
        Result(State state, String engine,String detail) { this.state=state; this.engine=engine==null?"":engine;this.detail=detail; }
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
        int epoch,attempt;
        Runnable timeout,voiceTimeout;
        java.io.File audioFile;
        String utterance="",lastFailure="";
        final java.util.Set<String> rejected=new java.util.HashSet<>();
        AndroidSpeech(KaiApp app) { this.app=app; }
        String engine() {return OfflineSpeech.engineName(app,probe);}
        @Override public void check(Consumer<Result> callback) {
            close(); int ticket=epoch;attempt=0;lastFailure="";rejected.clear();
            timeout=()->{
                if(ticket!=epoch)return;
                String name=engine(),detail=diagnostic("Speech engine check timed out.");close();
                callback.accept(new Result(name.isEmpty()?State.MISSING_ENGINE:State.ERROR,name,detail));
            };
            app.main.postDelayed(timeout,15000);
            try {
                probe=OfflineSpeech.create(app,status->app.main.post(()->{
                    if(ticket!=epoch)return;
                    if(status!=TextToSpeech.SUCCESS){finish(ticket,callback,new Result(engine().isEmpty()?State.MISSING_ENGINE:State.ERROR,engine(),"The speech engine failed to initialize."));return;}
                    tryVoice(ticket,callback);
                }));
            } catch(Exception e) {
                finish(ticket,callback,new Result(State.ERROR,engine(),"The speech engine could not be opened."));
            }
        }
        void tryVoice(int ticket,Consumer<Result> callback) {
            if(ticket!=epoch||probe==null)return;
            final android.speech.tts.Voice voice;
            try {voice=OfflineSpeech.select(OfflineSpeech.access(probe),OfflineSpeech.preferredVoice(app,engine()),rejected);}
            catch(Exception e){finish(ticket,callback,new Result(State.ERROR,engine(),diagnostic("Voice selection failed.")));return;}
            if(voice==null||attempt>=12){
                finish(ticket,callback,new Result(rejected.isEmpty()?State.MISSING_VOICE:State.ERROR,engine(),diagnostic(lastFailure.isEmpty()?"No usable offline English voice was found.":lastFailure)));return;
            }
            attempt++;String id="kai-setup-"+ticket+"-"+attempt;utterance=id;
            try {
                audioFile=java.io.File.createTempFile("kai-voice-check-",".wav",app.getCacheDir());
                java.io.File file=audioFile;
                probe.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener(){
                    public void onStart(String ignored){}
                    public void onDone(String completed){app.main.post(()->{
                        if(ticket!=epoch||!id.equals(utterance)||!id.equals(completed))return;
                        if(validWave(file)){
                            app.prefs.edit().putString("voice.selected."+engine(),voice.getName()).apply();
                            finish(ticket,callback,new Result(State.READY,engine(),diagnostic("Verified speech output: "+voice.getName())));
                        }else failedVoice(ticket,id,voice,callback,"The engine returned no usable speech audio.");
                    });}
                    public void onError(String failed){onError(failed,TextToSpeech.ERROR);}
                    public void onError(String failed,int code){app.main.post(()->{
                        if(id.equals(failed))failedVoice(ticket,id,voice,callback,"Speech synthesis returned error "+code+".");
                    });}
                });
                voiceTimeout=()->failedVoice(ticket,id,voice,callback,"A voice did not finish its speech check.");
                app.main.postDelayed(voiceTimeout,3500);
                android.os.Bundle params=new android.os.Bundle();
                params.putString(TextToSpeech.Engine.KEY_FEATURE_EMBEDDED_SYNTHESIS,"true");
                if(probe.synthesizeToFile("KAI is ready.",params,file,id)!=TextToSpeech.SUCCESS)
                    failedVoice(ticket,id,voice,callback,"The engine rejected the speech check.");
            }catch(Exception e){failedVoice(ticket,id,voice,callback,"The speech check could not run.");}
        }
        void failedVoice(int ticket,String id,android.speech.tts.Voice voice,Consumer<Result> callback,String reason){
            if(ticket!=epoch||!id.equals(utterance))return;
            lastFailure=reason;rejected.add(voice.getName());utterance="";
            if(voiceTimeout!=null)app.main.removeCallbacks(voiceTimeout);
            probe.stop();removeAudio();
            app.main.post(()->tryVoice(ticket,callback));
        }
        static boolean validWave(java.io.File file){
            if(file==null||file.length()<=44)return false;
            try(java.io.RandomAccessFile in=new java.io.RandomAccessFile(file,"r")){
                if(in.readInt()!=0x52494646)return false;in.readInt();if(in.readInt()!=0x57415645)return false;
                boolean format=false,data=false;
                for(int i=0;i<64&&in.getFilePointer()+8<=in.length();i++){
                    int kind=in.readInt();long size=Integer.toUnsignedLong(Integer.reverseBytes(in.readInt())),start=in.getFilePointer();
                    if(size>in.length()-start)return false;
                    if(kind==0x666d7420&&size>=16){int encoding=Short.toUnsignedInt(Short.reverseBytes(in.readShort()));int channels=Short.toUnsignedInt(Short.reverseBytes(in.readShort()));int rate=Integer.reverseBytes(in.readInt());format=(encoding==1||encoding==3)&&channels>0&&channels<=8&&rate>0;}
                    if(kind==0x64617461&&size>0)data=true;
                    if(format&&data)return true;
                    in.seek(start+size+(size&1));
                }
                return false;
            }catch(Exception e){return false;}
        }
        String diagnostic(String reason){
            return reason+(probe==null?"":"\n"+OfflineSpeech.describe(OfflineSpeech.access(probe)));
        }
        void finish(int ticket,Consumer<Result> callback,Result result){
            if(ticket!=epoch)return;
            close();callback.accept(result);
        }
        void removeAudio(){if(audioFile!=null){audioFile.delete();audioFile=null;}}
        @Override public void preview(Runnable done, Consumer<String> error) {
            if(sample!=null)sample.close();
            sample=new AndroidVoice.Speaker(app);
            sample.say("Hi, I'm KAI. My voice is ready. Let's talk.",done,error);
        }
        @Override public void close() {
            epoch++;utterance="";
            if(timeout!=null)app.main.removeCallbacks(timeout);
            if(voiceTimeout!=null)app.main.removeCallbacks(voiceTimeout);
            if(probe!=null){probe.stop();probe.shutdown();probe=null;}
            if(sample!=null){sample.close();sample=null;}
            removeAudio();
        }
    }

    final Activity activity; final KaiApp app; final boolean replies; final Runnable continuation;
    final Speech speech; final String owner;
    AlertDialog dialog; LinearLayout content;
    TextView downloadStatus,pocketStatus;ProgressBar packProgress,pocketProgress;boolean primaryShown;
    Result result=new Result(State.CHECKING,"");
    boolean foreground=true, disposed, mobileData, previewing, waitingPermission, external;
    int epoch; String note="", rendered="";
    VoiceSetup(Activity activity,KaiApp app,boolean replies,Runnable continuation) {
        this(activity,app,replies,continuation,new KaiSpeechSetup(app));
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
    boolean allReady() { return app.voicePack.ready()&&microphone()&&(!replies||result.state==State.READY&&(!PocketPack.ENGINE.equals(result.engine)||app.pocketPack.ready())); }
    void checkSpeech() {
        if(disposed||!foreground)return;
        int ticket=++epoch;result=new Result(replies?State.CHECKING:State.READY,PocketPack.selected(app)?PocketPack.ENGINE:OfflineSpeech.requestedEngine(app));rendered="";
        if(!replies){refresh();return;}
        speech.check(value->{if(!disposed&&foreground&&ticket==epoch){result=value;refresh();}});
        refresh();
    }
    void pause() { foreground=false;epoch++;speech.close();previewing=false; }
    void resume() {
        if(disposed)return;
        foreground=true;external=false;
        String installing=app.prefs.getString("voice.installEngine","");
        if(!installing.isEmpty()){
            if(OfflineSpeech.engines(app).containsKey(installing))app.prefs.edit().putString("voice.provider","android").putString("voice.engine",installing).apply();
            app.prefs.edit().remove("voice.installEngine").apply();
        }
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
        boolean pocket=PocketPack.ENGINE.equals(result.engine);
        if(replies&&pocket&&result.state==State.READY&&!app.pocketPack.ready())result=new Result(State.MISSING_VOICE,PocketPack.ENGINE);
        if(replies&&pocket&&result.state==State.MISSING_VOICE&&app.pocketPack.ready()&&!app.pocketPack.active){checkSpeech();return;}
        if(allReady()&&continuation!=null&&!previewing&&!waitingPermission){
            close();continuation.run();return;
        }
        boolean downloading=app.voicePack.downloadId!=-1||app.voicePack.installing;
        if(downloadStatus!=null)downloadStatus.setText(app.voicePack.status.isEmpty()?"Preparing voice input…":app.voicePack.status);
        if(packProgress!=null){packProgress.setIndeterminate(app.voicePack.installing);packProgress.setProgress((int)Math.min(100,app.voicePack.downloaded*100/VoicePack.BYTES));}
        if(pocketStatus!=null)pocketStatus.setText(app.pocketPack.status);
        if(pocketProgress!=null){pocketProgress.setIndeterminate(app.pocketPack.verifying);pocketProgress.setProgress((int)Math.min(100,app.pocketPack.downloaded*100/PocketPack.BYTES));}
        String packState=downloading?(app.voicePack.status.contains("paused")?"paused":"downloading"):app.voicePack.status;
        String key=app.voicePack.ready()+"|"+packState+"|"+app.voicePack.downloadId+"|"+app.voicePack.installing+"|"+app.networkAllowed()+"|"+result.state+"|"+result.engine+"|"+result.detail+"|"+microphone()+"|"+app.prefs.getBoolean("voice.micAsked",false)+"|"+note+"|"+previewing+"|"+app.pocketPack.active+"|"+app.pocketPack.verifying+"|"+(app.pocketPack.active?app.pocketPack.status.contains("paused"):app.pocketPack.status);
        if(key.equals(rendered))return;rendered=key;
        content.removeAllViews();downloadStatus=null;packProgress=null;pocketStatus=null;pocketProgress=null;primaryShown=false;
        dialog.getButton(DialogInterface.BUTTON_NEGATIVE).setText(allReady()?"Close":"Not now");
        label("A quick setup, then you can talk. KAI checks each step for you.",15,false);
        label((app.voicePack.ready()?"✓":"1")+"  Hear you",17,true);
        label(app.voicePack.ready()?"English voice input is ready and works offline.":"KAI needs a 41 MB English listening pack. It turns your speech into text on this device.",14,false);
        if(replies){
            label((result.state==State.READY?"✓":"2")+"  Talk back",17,true);
            label(pocket?(result.state==State.READY?"KAI's desktop Azelma voice is ready offline.":result.state==State.CHECKING?"Warming up Azelma and generating a short test. The first check can take a moment…":result.state==State.ERROR?"Azelma could not finish its speech test. Tap Check again to retry.":"Get KAI's desktop voice with one 199 MB download. No Android voice settings needed."):result.state==State.READY?"An English speaking voice is ready offline.":
                result.state==State.CHECKING?"Testing your Android speaking voice…":
                result.state==State.MISSING_ENGINE?"Install an Android speech engine so KAI can answer aloud.":
                result.state==State.ERROR?"This engine could not generate speech for KAI. Try another installed engine below.":
                "KAI could not activate an offline English voice in this engine. It may already be installed.",14,false);
            if(!pocket&&!result.engine.isEmpty())label("Engine: "+OfflineSpeech.engines(app).getOrDefault(result.engine,result.engine),13,false);
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
            if(pocket){
                if(app.pocketPack.active){
                    pocketStatus=label(app.pocketPack.status,14,true);pocketProgress=new ProgressBar(activity,null,android.R.attr.progressBarStyleHorizontal);pocketProgress.setMax(100);pocketProgress.setIndeterminate(app.pocketPack.verifying);pocketProgress.setProgress((int)Math.min(100,app.pocketPack.downloaded*100/PocketPack.BYTES));content.addView(pocketProgress);
                    button("Cancel voice download",()->{app.pocketPack.cancel();refresh();});
                    if(app.pocketPack.status.contains("paused"))button("Download using mobile data",()->{app.pocketPack.cancel();mobileData=true;downloadPocket();});
                }else if(!app.pocketPack.ready()){
                    if(!app.pocketPack.status.isEmpty())label(app.pocketPack.status,14,true);
                    label("Allow 450 MB of free space during setup. Afterward, KAI speaks offline using the same Azelma voice and character effects as desktop.",13,false);
                    CheckBox metered=new CheckBox(activity);metered.setText("Allow mobile data for this 199 MB download");metered.setChecked(mobileData);metered.setOnCheckedChangeListener((v,on)->mobileData=on);content.addView(metered);
                    button(app.networkAllowed()?"Download KAI's voice · 199 MB":"Go online & get KAI's voice",this::downloadPocket);
                    button("Choose speaking voice",this::chooseEngine);
                }else if(result.state==State.ERROR){
                    label(result.detail,13,false);button("Check again",()->{app.pocketChecked=false;checkSpeech();});button("Choose speaking voice",this::chooseEngine);button("Voice details",this::showDetails);
                }
            }else if(result.state!=State.CHECKING){
                if(result.state==State.MISSING_ENGINE){
                    label("Install Speech Recognition & Synthesis from Google, then return. KAI will use it without changing your phone's preferred engine.",14,false);
                    button("Install speech engine",this::openEngineStore);
                }else if(result.state==State.MISSING_VOICE){
                    label("If Android says Latest version, you do not need to download that voice again. Try another engine below. Use Install English voice only if English is missing.",14,false);
                }
                if(result.state!=State.MISSING_ENGINE){
                    if(OfflineSpeech.engines(app).containsKey(GOOGLE_TTS)&&!GOOGLE_TTS.equals(result.engine))
                        button("Use Google speech instead",()->useEngine(GOOGLE_TTS));
                    else if(!GOOGLE_TTS.equals(result.engine))button("Install Google speech instead",this::openEngineStore);
                    button("Choose speech engine",this::chooseEngine);
                    if(result.state==State.MISSING_VOICE)button("Install English voice",this::installVoice);
                }
                button("Android voice settings",this::openVoiceSettings);
                button("Check again",this::checkSpeech);
                button("Voice details",this::showDetails);
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
            if(replies){button(previewing?"Stop voice test":"Test KAI's voice",this::preview);button(pocket?"Choose speaking voice":"Choose speech engine",this::chooseEngine);}
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
    void downloadPocket(){note="";if(!app.networkAllowed())app.setNetworkEnabled(true);app.pocketPack.download(mobileData);refresh();}
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
        note="Install Speech Recognition & Synthesis from Google, then return. KAI will use it without changing your phone's preferred engine.";
        app.prefs.edit().putString("voice.installEngine",GOOGLE_TTS).apply();
        if(!launch(new Intent(Intent.ACTION_VIEW,Uri.parse("market://details?id="+GOOGLE_TTS)))&&
           !launch(new Intent(Intent.ACTION_VIEW,Uri.parse("https://play.google.com/store/apps/details?id="+GOOGLE_TTS)))){
            note="No app store or browser could open. Install a text-to-speech engine from your device's app store, then choose it in Android voice settings. You can still type in KAI.";
            app.prefs.edit().remove("voice.installEngine").apply();
        }
        refresh();
    }
    void useEngine(String engine){
        if(disposed||!foreground)return;
        if(PocketPack.ENGINE.equals(engine))app.prefs.edit().putString("voice.provider","pocket").apply();
        else app.prefs.edit().putString("voice.provider","android").putString("voice.engine",engine).apply();
        note=PocketPack.ENGINE.equals(engine)?"KAI will use his desktop Azelma voice.":"Checking this engine for KAI. Your phone's preferred engine is unchanged.";checkSpeech();
    }
    void chooseEngine(){
        java.util.Map<String,String> installed=OfflineSpeech.engines(app);
        epoch++;speech.close();
        java.util.List<String> keys=new java.util.ArrayList<>(),labels=new java.util.ArrayList<>();
        keys.add(PocketPack.ENGINE);labels.add("KAI's desktop voice · Azelma");
        keys.add("");labels.add("Use phone's preferred engine");
        for(java.util.Map.Entry<String,String> engine:installed.entrySet()){keys.add(engine.getKey());labels.add(engine.getValue());}
        int chosen=keys.indexOf(PocketPack.selected(app)?PocketPack.ENGINE:OfflineSpeech.requestedEngine(app));
        new AlertDialog.Builder(activity).setTitle("Speaking voice for KAI")
            .setSingleChoiceItems(labels.toArray(new String[0]),Math.max(0,chosen),(d,index)->{d.dismiss();useEngine(keys.get(index));})
            .setNegativeButton("Cancel",(d,w)->checkSpeech()).setOnCancelListener(d->checkSpeech()).show();
    }
    void showDetails(){
        String details="KAI voice check\nDevice: "+android.os.Build.MANUFACTURER+" "+android.os.Build.MODEL+
            "\nAndroid API: "+android.os.Build.VERSION.SDK_INT+"\nEngine: "+result.engine+"\nStatus: "+result.state+"\n"+result.detail;
        new AlertDialog.Builder(activity).setTitle("Voice details").setMessage(details)
            .setPositiveButton("Copy details",(d,w)->{
                android.content.ClipboardManager clipboard=(android.content.ClipboardManager)activity.getSystemService(Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("KAI voice check",details));
                Toast.makeText(activity,"Voice details copied",Toast.LENGTH_SHORT).show();
            }).setNegativeButton("Close",null).show();
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
