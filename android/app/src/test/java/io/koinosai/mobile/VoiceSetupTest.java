package io.koinosai.mobile;

import android.Manifest;
import android.content.Intent;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,qualifiers="w411dp-h891dp-mdpi")
@LooperMode(LooperMode.Mode.PAUSED)
public class VoiceSetupTest {
    ActivityController<MainActivity> controller; MainActivity activity; KaiApp app;
    VoiceSetup setup; FakeSpeech speech; int continued;
    static class FakeSpeech implements VoiceSetup.Speech {
        Consumer<VoiceSetup.Result> result; Runnable done; int checks,closes,previews;
        public void check(Consumer<VoiceSetup.Result> callback){checks++;result=callback;}
        public void preview(Runnable complete,Consumer<String> error){previews++;done=complete;}
        public void close(){closes++;}
        void complete(VoiceSetup.State state){result.accept(new VoiceSetup.Result(state,"test.engine"));}
    }
    @Before public void start() throws Exception {
        controller=Robolectric.buildActivity(MainActivity.class).setup();activity=controller.get();app=(KaiApp)activity.getApplication();
        app.account.worker.submit(()->{}).get();Shadows.shadowOf(Looper.getMainLooper()).idle();
        app.account.token="test-only";app.account.validUntil=System.currentTimeMillis()+60000;
        app.account.account=new JSONObject().put("id","setup-test").put("email","voice@example.invalid");app.accountChanged();
        speech=new FakeSpeech();
    }
    @After public void stop(){
        if(setup!=null)setup.close();controller.pause().stop().destroy();app.main.removeCallbacksAndMessages(null);
        app.inference.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();app.network.shutdownNow();app.account.worker.shutdownNow();
    }
    void pack() throws Exception {File dir=app.voicePack.directory();new File(dir,"am").mkdirs();new File(dir,".verified").createNewFile();new File(dir,"am/final.mdl").createNewFile();}
    void mic(){Shadows.shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO);}
    void show(boolean replies,boolean start){
        setup=new VoiceSetup(activity,app,replies,start?()->continued++:null,speech);setup.show();
    }
    TextView find(View v,String title){
        if(v instanceof TextView&&title.contentEquals(((TextView)v).getText()))return (TextView)v;
        if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){TextView value=find(((ViewGroup)v).getChildAt(i),title);if(value!=null)return value;}return null;
    }
    TextView find(String title){return find(setup.dialog.getWindow().getDecorView(),title);}
    void click(String title){TextView value=find(title);assertNotNull(title,value);value.performClick();}
    @Test public void missingVoiceOffersTargetedInstallerBeforeListening() throws Exception {
        pack();mic();show(true,true);speech.complete(VoiceSetup.State.MISSING_VOICE);
        assertEquals(0,continued);assertTrue(setup.dialog.isShowing());click("Install English voice");
        Intent intent=Shadows.shadowOf(activity).getNextStartedActivity();
        assertEquals(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA,intent.getAction());assertEquals("test.engine",intent.getPackage());
    }
    @Test public void installerReturnRechecksAndDoesNotAssumeSuccess() throws Exception {
        pack();mic();show(true,true);speech.complete(VoiceSetup.State.MISSING_VOICE);setup.pause();setup.resume();
        assertEquals(2,speech.checks);assertEquals(0,continued);speech.complete(VoiceSetup.State.MISSING_VOICE);
        assertNotNull(find("Install English voice"));assertEquals(0,continued);
        setup.pause();setup.resume();speech.complete(VoiceSetup.State.READY);
        assertEquals(1,continued);assertFalse(setup.dialog.isShowing());setup.refresh();assertEquals(1,continued);
    }
    @Test public void lateChecksCannotContinueWhileBackgroundedOrCancelled() throws Exception {
        pack();mic();show(true,true);Consumer<VoiceSetup.Result> late=speech.result;
        setup.pause();late.accept(new VoiceSetup.Result(VoiceSetup.State.READY,"test.engine"));assertEquals(0,continued);
        setup.resume();late=speech.result;setup.close();late.accept(new VoiceSetup.Result(VoiceSetup.State.READY,"test.engine"));assertEquals(0,continued);
    }
    @Test public void noEngineLinksToItsRealStoreListing() throws Exception {
        pack();show(true,true);speech.complete(VoiceSetup.State.MISSING_ENGINE);click("Install speech engine");
        assertEquals("market://details?id=com.google.android.tts",Shadows.shadowOf(activity).getNextStartedActivity().getDataString());assertEquals(0,continued);
    }
    @Test public void blockedPermissionHasDirectAppSettingsButton() throws Exception {
        pack();app.prefs.edit().putBoolean("voice.micAsked",true).apply();show(true,true);speech.complete(VoiceSetup.State.READY);
        click("Open microphone settings");Intent intent=Shadows.shadowOf(activity).getNextStartedActivity();
        assertEquals(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,intent.getAction());
        assertEquals("package:io.koinosai.mobile",intent.getDataString());assertEquals(0,continued);
    }
    @Test public void deniedPermissionKeepsSetupOpenWithInstructions() throws Exception {
        pack();show(true,true);speech.complete(VoiceSetup.State.READY);click("Allow microphone");setup.permissionResult(false);
        assertEquals(0,continued);assertTrue(setup.dialog.isShowing());assertNotNull(find("Open microphone settings"));
        mic();setup.permissionResult(true);assertEquals(1,continued);
    }
    @Test public void dictationDoesNotRequireSpeakingVoice() throws Exception {
        pack();mic();show(false,true);assertEquals(1,continued);assertEquals(0,speech.checks);
    }
    @Test public void installedRequirementsContinueExactlyOnce() throws Exception {
        pack();mic();show(true,true);assertEquals(0,continued);speech.complete(VoiceSetup.State.READY);speech.complete(VoiceSetup.State.READY);assertEquals(1,continued);
    }
    @Test public void downloadIsExplicitAndContinuesWhenVerifiedPackArrives() throws Exception {
        mic();show(false,true);assertEquals(-1,app.voicePack.downloadId);assertFalse(app.networkAllowed());click("Go online & download · 41 MB");
        assertTrue(app.networkAllowed());assertTrue(app.voicePack.downloadId!=-1);assertEquals(0,continued);
        app.voicePack.cancel();pack();setup.refresh();assertEquals(1,continued);
    }
    @Test public void voiceTestStopsOnLeavingApp() throws Exception {
        pack();mic();show(true,false);speech.complete(VoiceSetup.State.READY);click("Test KAI's voice");assertEquals(1,speech.previews);
        int old=speech.closes;setup.pause();assertTrue(speech.closes>old);speech.done.run();assertFalse(setup.previewing);assertEquals(0,continued);
    }
    @Test public void signOutCancelsPendingContinuation() throws Exception {
        pack();mic();show(true,true);app.account.account=new JSONObject().put("id","another-account");
        speech.complete(VoiceSetup.State.READY);assertEquals(0,continued);assertTrue(setup.disposed);
    }
    @Test public void missingStoreFallsBackToOfficialBrowserListing() {
        java.util.List<Intent> attempts=new java.util.ArrayList<>();
        android.app.Activity noStore=new android.app.Activity(){
            @Override public void startActivity(Intent intent){attempts.add(intent);if("market".equals(intent.getScheme()))throw new android.content.ActivityNotFoundException();}
        };
        setup=new VoiceSetup(noStore,app,true,null,speech);setup.openEngineStore();
        assertEquals(2,attempts.size());assertEquals("https://play.google.com/store/apps/details?id=com.google.android.tts",attempts.get(1).getDataString());
    }
    @Test public void unavailableSystemScreensProvideManualDirectionsWithoutCrashing() {
        android.app.Activity noSettings=new android.app.Activity(){
            @Override public void startActivity(Intent intent){throw new android.content.ActivityNotFoundException();}
        };
        setup=new VoiceSetup(noSettings,app,true,null,speech);setup.result=new VoiceSetup.Result(VoiceSetup.State.MISSING_VOICE,"test.engine");
        setup.installVoice();assertTrue(setup.note.contains("Open your device's Settings app"));
        setup.openEngineStore();assertTrue(setup.note.contains("No app store or browser"));
    }
    @Test public void stalledAndroidSpeechCheckTimesOutAndCloseInvalidatesIt() {
        VoiceSetup.AndroidSpeech probe=new VoiceSetup.AndroidSpeech(app);java.util.List<VoiceSetup.Result> replies=new java.util.ArrayList<>();
        probe.check(replies::add);Shadows.shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(16));
        assertEquals(1,replies.size());assertNotEquals(VoiceSetup.State.READY,replies.get(0).state);
        replies.clear();probe.check(replies::add);probe.close();Shadows.shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(16));assertTrue(replies.isEmpty());
    }
    @Test public void voiceCheckRequiresGeneratedAudioNotOnlyMetadata() throws Exception {
        File audio=File.createTempFile("voice-check-test",".wav",app.getCacheDir());
        assertFalse(VoiceSetup.AndroidSpeech.validWave(audio));
        byte[] bytes=new byte[100];java.nio.file.Files.write(audio.toPath(),bytes);assertFalse(VoiceSetup.AndroidSpeech.validWave(audio));
        System.arraycopy("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII),0,bytes,0,4);
        System.arraycopy("WAVE".getBytes(java.nio.charset.StandardCharsets.US_ASCII),0,bytes,8,4);
        java.nio.file.Files.write(audio.toPath(),bytes);assertFalse(VoiceSetup.AndroidSpeech.validWave(audio));
        wave(audio);assertTrue(VoiceSetup.AndroidSpeech.validWave(audio));
        try(java.io.RandomAccessFile truncated=new java.io.RandomAccessFile(audio,"rw")){truncated.setLength(44);}
        assertFalse(VoiceSetup.AndroidSpeech.validWave(audio));audio.delete();
    }
    @Test public void engineChoiceOnlyChangesKaisPreference() throws Exception {
        pack();mic();android.provider.Settings.Secure.putString(app.getContentResolver(),"tts_default_synth","com.samsung.SMT");
        show(true,true);speech.complete(VoiceSetup.State.MISSING_VOICE);
        setup.useEngine(VoiceSetup.GOOGLE_TTS);
        assertEquals(VoiceSetup.GOOGLE_TTS,OfflineSpeech.requestedEngine(app));
        assertEquals("com.samsung.SMT",android.provider.Settings.Secure.getString(app.getContentResolver(),"tts_default_synth"));
        assertEquals(2,speech.checks);assertEquals(0,continued);speech.complete(VoiceSetup.State.READY);assertEquals(1,continued);
    }
    @Test public void installedVoiceFailureOffersAlternativesWithoutReinstallLoop() throws Exception {
        pack();mic();show(true,true);speech.complete(VoiceSetup.State.MISSING_VOICE);
        assertNotNull(find("Choose speech engine"));assertNotNull(find("Install Google speech instead"));assertNotNull(find("Voice details"));
        assertEquals(0,continued);
    }
    void wave(File file)throws Exception{
        java.nio.ByteBuffer wav=java.nio.ByteBuffer.allocate(100).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(92).put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        wav.putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16);
        wav.put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(56);
        while(wav.hasRemaining())wav.putShort((short)100);
        java.nio.file.Files.write(file.toPath(),wav.array());
    }
    VoiceSetup.AndroidSpeech startProbe(java.util.List<VoiceSetup.Result> results)throws Exception{
        System.setProperty("robolectric.enableShadowTtsSynthesisToFileCallbackSuppression","true");
        app.prefs.edit().putString("voice.engine","test.engine").apply();
        VoiceSetup.AndroidSpeech probe=new VoiceSetup.AndroidSpeech(app);probe.check(results::add);
        Shadows.shadowOf(probe.probe).getOnInitListener().onInit(TextToSpeech.SUCCESS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();return probe;
    }
    @Test public void realSetupAdapterRequiresSynthesisCompletionAndRemembersVerifiedVoice()throws Exception{
        android.speech.tts.Voice english=new android.speech.tts.Voice("oem-english",new java.util.Locale("eng","USA"),300,300,false,java.util.Collections.emptySet());
        org.robolectric.shadows.ShadowTextToSpeech.addVoice(english);
        java.util.List<VoiceSetup.Result> results=new java.util.ArrayList<>();VoiceSetup.AndroidSpeech probe=startProbe(results);
        try{
            assertTrue(results.isEmpty());File audio=probe.audioFile;assertNotNull(audio);wave(audio);
            Shadows.shadowOf(probe.probe).getUtteranceProgressListener().onDone(probe.utterance);Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(1,results.size());assertEquals(VoiceSetup.State.READY,results.get(0).state);assertFalse(audio.exists());
            assertEquals("oem-english",OfflineSpeech.preferredVoice(app,"test.engine"));
        }finally{probe.close();System.clearProperty("robolectric.enableShadowTtsSynthesisToFileCallbackSuppression");}
    }
    @Test public void synthesisErrorTriesNextVoiceAndIgnoresOldUtterance()throws Exception{
        org.robolectric.shadows.ShadowTextToSpeech.addVoice(new android.speech.tts.Voice("first",java.util.Locale.US,500,300,false,java.util.Collections.emptySet()));
        org.robolectric.shadows.ShadowTextToSpeech.addVoice(new android.speech.tts.Voice("second",new java.util.Locale("eng","USA"),300,300,false,java.util.Collections.emptySet()));
        java.util.List<VoiceSetup.Result> results=new java.util.ArrayList<>();VoiceSetup.AndroidSpeech probe=startProbe(results);
        try{
            String oldId=probe.utterance;File oldFile=probe.audioFile;android.speech.tts.UtteranceProgressListener first=Shadows.shadowOf(probe.probe).getUtteranceProgressListener();
            first.onError(oldId,TextToSpeech.ERROR);Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(oldFile.exists());assertEquals(2,probe.attempt);assertTrue(results.isEmpty());
            first.onDone(oldId);Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(results.isEmpty());
            wave(probe.audioFile);Shadows.shadowOf(probe.probe).getUtteranceProgressListener().onDone(probe.utterance);Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(1,results.size());assertEquals(VoiceSetup.State.READY,results.get(0).state);assertEquals("second",OfflineSpeech.preferredVoice(app,"test.engine"));
        }finally{probe.close();System.clearProperty("robolectric.enableShadowTtsSynthesisToFileCallbackSuppression");}
    }
    @Test public void closingProbeDeletesAudioAndRejectsLateCompletion()throws Exception{
        org.robolectric.shadows.ShadowTextToSpeech.addVoice(new android.speech.tts.Voice("english",java.util.Locale.US,300,300,false,java.util.Collections.emptySet()));
        java.util.List<VoiceSetup.Result> results=new java.util.ArrayList<>();VoiceSetup.AndroidSpeech probe=startProbe(results);
        try{
            File audio=probe.audioFile;String id=probe.utterance;android.speech.tts.UtteranceProgressListener listener=Shadows.shadowOf(probe.probe).getUtteranceProgressListener();
            probe.close();listener.onDone(id);Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertTrue(results.isEmpty());assertFalse(audio.exists());
        }finally{probe.close();System.clearProperty("robolectric.enableShadowTtsSynthesisToFileCallbackSuppression");}
    }
}
