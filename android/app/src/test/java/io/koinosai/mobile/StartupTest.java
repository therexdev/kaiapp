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
    @Test public void firstLaunchRequiresAccountAndAllFiveTabsOpen() {
        assertNotNull(find("Get started · Sign in"));assertNull(app.active);assertEquals(2,app.models.size());
        find("Models").performClick();assertNotNull(find("Koinos Fast"));assertNotNull(find("Koinos Balanced"));assertNotNull(find("Import GGUF"));
        find("Network").performClick();assertNotNull(find("Local only"));assertNotNull(find("My node"));
        find("Accounts").performClick();assertNotNull(find("Sign in with KAI"));
        find("Settings").performClick();assertNotNull(find("Download on Wi-Fi only"));assertNotNull(find("Save instructions"));
        find("Chat").performClick();assertNull(find("Send"));assertNotNull(find("Get started · Sign in"));
    }
    @Test public void signedInLocalChatOpensWithoutSendingAnythingOnline() throws Exception {
        signIn();assertNotNull(find("Choose a local model"));assertFalse(find("Send").isEnabled());assertFalse(app.networkAllowed());
        app.send("Hello");assertTrue(app.error.contains("Load a model"));assertFalse(app.generating);
    }
    @Test public void conversationsAreExportableOnlyForTheirAccount() throws Exception {
        signIn();app.newChat();KaiApp.Conversation first=app.current;first.title="Saved sample";first.messages.add(new KaiApp.ChatMessage("user","Hello"));first.messages.add(new KaiApp.ChatMessage("assistant","Hi!"));
        assertTrue(app.exportChat().contains("Hello"));app.newChat();app.selectChat(first);assertEquals(first,app.current);
        app.account.token="";app.hideAccountChats();assertEquals("",app.exportChat());assertTrue(app.visibleChats().isEmpty());
        signIn();app.selectChat(first);app.deleteChat(first);assertFalse(app.chats.contains(first));
    }
}
