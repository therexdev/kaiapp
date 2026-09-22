package io.koinosai.mobile;

import android.view.*;
import android.widget.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28)
@LooperMode(LooperMode.Mode.PAUSED)
public class StartupTest {
    private ActivityController<MainActivity> controller;
    private MainActivity activity;
    private KaiApp app;
    @Before public void start() {
        controller=Robolectric.buildActivity(MainActivity.class).setup();
        activity=controller.get();app=(KaiApp)activity.getApplication();
    }
    @After public void stop() {
        controller.pause().stop().destroy();app.main.removeCallbacksAndMessages(null);
        app.inference.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();
    }
    private TextView find(View view,String label) {
        if(view instanceof TextView && ((TextView)view).getText().toString().equals(label))return (TextView)view;
        if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++) {
            TextView result=find(((ViewGroup)view).getChildAt(i),label);if(result!=null)return result;
        }
        return null;
    }
    private TextView find(String label) {return find(activity.getWindow().getDecorView(),label);}
    @Test public void firstLaunchAndModelNavigationWorkWithoutModelOrAccount() {
        assertNotNull(find("Choose a local model"));assertNotNull(app.current);assertEquals(2,app.models.size());assertNull(app.active);
        find("Models").performClick();assertNotNull(find("Koinos Fast"));assertNotNull(find("Koinos Balanced"));assertNotNull(find("Import GGUF"));
        find("Settings").performClick();assertNotNull(find("Download on Wi-Fi only"));assertNotNull(find("Save instructions"));
        find("Chat").performClick();assertNotNull(find("Choose a local model"));assertFalse(find("Send").isEnabled());
    }
    @Test public void conversationsExportAndDeleteWithoutADeviceModel() {
        KaiApp.Conversation first=app.current;first.title="Saved sample";first.messages.add(new KaiApp.ChatMessage("user","Hello"));first.messages.add(new KaiApp.ChatMessage("assistant","Hi!"));
        assertTrue(app.exportChat().contains("Hello"));assertTrue(app.exportChat().contains("Hi!"));
        app.newChat();assertNotEquals(first.id,app.current.id);app.selectChat(first);assertEquals("Saved sample",app.current.title);
        app.deleteChat(first);assertFalse(app.chats.contains(first));assertNotNull(app.current);
    }
}
