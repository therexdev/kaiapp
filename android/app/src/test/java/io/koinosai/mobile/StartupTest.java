package io.koinosai.mobile;

import android.view.*;
import android.widget.*;
import android.os.Looper;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28)
@LooperMode(LooperMode.Mode.PAUSED)
public class StartupTest {
    private ActivityController<MainActivity> controller;
    private MainActivity activity;
    private KaiApp app;
    @Before public void start() throws Exception {
        controller=Robolectric.buildActivity(MainActivity.class).setup();
        activity=controller.get();app=(KaiApp)activity.getApplication();
        app.account.worker.submit(()->{}).get();Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    @After public void stop() {
        controller.pause().stop().destroy();app.main.removeCallbacksAndMessages(null);
        app.inference.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();app.network.shutdownNow();app.account.worker.shutdownNow();
    }
    private TextView find(View view,String label) {
        if(view instanceof TextView && ((TextView)view).getText().toString().equals(label))return (TextView)view;
        if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++) {
            TextView result=find(((ViewGroup)view).getChildAt(i),label);if(result!=null)return result;
        }
        return null;
    }
    private TextView find(String label) {return find(activity.getWindow().getDecorView(),label);}
    private void signIn() throws Exception {app.account.token="test-only";app.account.account=new JSONObject().put("id","test-account").put("email","test@example.invalid");app.account.validUntil=System.currentTimeMillis()+60000;app.accountChanged();}
    private VoiceController fakeVoice(boolean conversation){
        VoiceController previous=org.robolectric.util.ReflectionHelpers.getField(activity,"voice");previous.close();
        VoiceController voice=new VoiceController(new VoiceControllerTest.Mic(),new VoiceControllerTest.Speaker(),new VoiceControllerTest.Host());
        org.robolectric.util.ReflectionHelpers.setField(activity,"voice",voice);
        String scope=org.robolectric.util.ReflectionHelpers.callInstanceMethod(activity,"voiceScope");org.robolectric.util.ReflectionHelpers.setField(activity,"voiceScope",scope);
        voice.start(conversation);return voice;
    }
    @Test public void leavingChatAndPausingActivityStopVoice()throws Exception{
        signIn();VoiceController voice=fakeVoice(true);assertTrue(voice.listening);find("Accounts").performClick();assertFalse(voice.active());
        find("Chat").performClick();voice=fakeVoice(true);controller.pause();assertFalse(voice.active());controller.resume();assertFalse(voice.active());
    }
    @Test public void dictationStillWorksOfflineWithWebSelected()throws Exception{
        signIn();app.prefs.edit().putBoolean("webSearch",true).apply();VoiceController voice=fakeVoice(false);app.changed();assertTrue(voice.listening);assertFalse(app.networkAllowed());
    }
    @Test public void firstLaunchRequiresAccountAndAllFiveTabsOpen() {
        assertNotNull(find("Get started · Sign in"));assertNull(app.active);assertEquals(2,app.models.size());
        find("Models").performClick();assertNotNull(find("Koinos Fast"));assertNotNull(find("Koinos Balanced"));assertNotNull(find("Import GGUF"));
        find("Network").performClick();assertNotNull(find("Local"));assertNotNull(find("My node"));
        find("Accounts").performClick();assertNotNull(find("Sign in with KAI"));
        find("Settings").performClick();assertNotNull(find("Download on Wi-Fi only"));assertNotNull(find("Save instructions"));
        find("Chat").performClick();assertNull(find("Send"));assertNotNull(find("Get started · Sign in"));
    }
    @Test public void signedInLocalChatOpensWithoutSendingAnythingOnline() throws Exception {
        signIn();assertNotNull(find("Choose a local model"));assertNotNull(find("Mic"));assertNotNull(find("Voice chat"));assertNotNull(find("Web"));assertTrue(find("Send").isEnabled());assertFalse(app.networkAllowed());
        app.send("Hello");assertTrue(app.error.contains("Load a model"));assertFalse(app.generating);
    }
    @Test public void conversationsAreExportableOnlyForTheirAccount() throws Exception {
        signIn();app.newChat();KaiApp.Conversation first=app.current;first.title="Saved sample";first.messages.add(new KaiApp.ChatMessage("user","Hello"));first.messages.add(new KaiApp.ChatMessage("assistant","Hi!"));
        assertTrue(app.exportChat().contains("Hello"));app.newChat();app.selectChat(first);assertEquals(first,app.current);
        app.account.token="";app.hideAccountChats();assertEquals("",app.exportChat());assertTrue(app.visibleChats().isEmpty());
        signIn();app.selectChat(first);app.deleteChat(first);assertFalse(app.chats.contains(first));
    }
    @Test public void signedInModelSwitchesNeedNoDisconnectDialog() throws Exception {
        signIn();app.setNetworkEnabled(true);find("Network").performClick();
        for(String mode:new String[]{"Network","My node","Local"}){
            find("Use "+mode).performClick();
            android.app.AlertDialog dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
            assertTrue(dialog==null||!dialog.isShowing());assertTrue(app.account.signedIn());assertTrue(app.networkAllowed());
        }
        assertEquals("local",app.route);find("Chat").performClick();
        assertNotNull(find("Choose a local model"));assertTrue(find("Send").isEnabled());
    }
    @Test public void offlineSettingIsSeparateAndRequiresExplicitConfirmation() throws Exception {
        signIn();app.setNetworkEnabled(true);find("Settings").performClick();
        ((Switch)find("Offline mode")).setChecked(true);
        android.app.AlertDialog dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
        assertNotNull(dialog);assertTrue(dialog.isShowing());assertTrue(app.networkAllowed());
        dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).performClick();Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(app.networkAllowed());
        ((Switch)find("Offline mode")).setChecked(true);dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
        dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertFalse(app.networkAllowed());assertTrue(app.account.signedIn());assertEquals("local",app.route);assertTrue(((Switch)find("Offline mode")).isChecked());
    }
    private void installedModel()throws Exception{KaiApp.Model model=app.models.get(0);model.installed=true;app.file(model).getParentFile().mkdirs();app.file(model).createNewFile();}
    private void installedVoice()throws Exception{java.io.File directory=app.voicePack.directory();new java.io.File(directory,"am").mkdirs();new java.io.File(directory,".verified").createNewFile();new java.io.File(directory,"am/final.mdl").createNewFile();}
    @Test public void dictatedQuestionCanLoadLocalModelWithoutLosingDraftOrGoingOnline()throws Exception{
        signIn();installedModel();EditText composer=org.robolectric.util.ReflectionHelpers.getField(activity,"composer");composer.setText("Which starter should I choose?");
        assertTrue(find("Send").isEnabled());find("Send").performClick();android.app.AlertDialog dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
        assertTrue(dialog.isShowing());assertNotNull(find(dialog.getWindow().getDecorView(),"Load & send"));assertFalse(app.networkAllowed());assertEquals("local",app.route);
        dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).performClick();assertEquals("Which starter should I choose?",composer.getText().toString());assertTrue(app.current.messages.isEmpty());
        installedVoice();find("Voice chat").performClick();dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();assertNotNull(find(dialog.getWindow().getDecorView(),"Load & start voice"));assertFalse(app.networkAllowed());
    }
    @Test public void localVoiceWithWebEnabledOffersOfflineContinuation()throws Exception{
        signIn();installedVoice();app.active=app.models.get(0);app.prefs.edit().putBoolean("webSearch",true).apply();app.changed();find("Voice chat").performClick();
        android.app.AlertDialog dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();assertEquals("Continue offline",dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).getText().toString());
        dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(app.prefs.getBoolean("webSearch",true));assertFalse(app.networkAllowed());assertEquals("local",app.route);
    }
    @Test public void searchShowsActivityThenCollapsesSourcesUntilOpened()throws Exception{
        signIn();app.searching=true;app.generating=true;app.busy=true;app.searchQuestion="Retroid processor";app.searchProvider="DuckDuckGo";app.changed();assertNotNull(find("Searching the web…"));assertNotNull(find("Searching DuckDuckGo\n“Retroid processor”"));
        app.searching=false;KaiApp.ChatMessage answer=new KaiApp.ChatMessage("assistant","");answer.incomplete=true;answer.research=new WebSearch.Result("DuckDuckGo","Retroid processor",1,java.util.Arrays.asList(new WebSearch.Source("Device specs","https://example.com/specs","Snapdragon processor")));app.current.messages.add(answer);app.changed();
        assertNotNull(find("Thinking…"));assertNotNull(find("Using search snippets from\nexample.com"));assertNull(find("Sources · 1 ▾"));assertNull(find("[1] Device specs"));
        answer.text="The device uses a Snapdragon processor. [1]";answer.incomplete=false;app.generating=false;app.busy=false;app.changed();assertNull(find("Thinking…"));assertNotNull(find("Sources · 1 ▾"));
        View details=activity.getWindow().getDecorView().findViewWithTag("source-details");assertEquals(View.GONE,details.getVisibility());find("Sources · 1 ▾").performClick();assertEquals(View.VISIBLE,details.getVisibility());assertNotNull(find("Snapdragon processor"));find("Sources · 1 ▴").performClick();assertEquals(View.GONE,details.getVisibility());
    }
    @Test public void voiceDownloadProgressAndReadyStateAreVisibleInChat()throws Exception{
        signIn();app.voicePack.downloadId=99;app.voicePack.downloaded=(VoicePack.BYTES+1)/2;app.voicePack.status="Downloading voice input · 50% of 41 MB";app.changed();assertNotNull(find(app.voicePack.status));
        ProgressBar progress=org.robolectric.util.ReflectionHelpers.getField(activity,"voiceDownloadProgress");assertEquals(View.VISIBLE,progress.getVisibility());assertEquals(50,progress.getProgress());
        app.voicePack.downloadId=-1;installedVoice();app.changed();assertNotNull(find("Voice ready · works offline"));assertEquals(View.GONE,progress.getVisibility());
    }
    private Runnable afterLoad(Runnable action){return org.robolectric.util.ReflectionHelpers.callInstanceMethod(activity,"afterModelLoad",org.robolectric.util.ReflectionHelpers.ClassParameter.from(Runnable.class,action));}
    @Test public void loadContinuationRunsOnceAndIsCancelledByBackgroundNavigationOrScopeChange()throws Exception{
        signIn();int[] sends={0};Runnable send=()->sends[0]++;
        Runnable ready=afterLoad(send);ready.run();ready.run();assertEquals(1,sends[0]);
        ready=afterLoad(send);controller.pause();controller.resume();ready.run();assertEquals(1,sends[0]);
        ready=afterLoad(send);find("Models").performClick();find("Chat").performClick();ready.run();assertEquals(1,sends[0]);
        ready=afterLoad(send);app.prefs.edit().putBoolean("webSearch",true).apply();ready.run();assertEquals(1,sends[0]);
    }

}
