package io.koinosai.mobile;

import android.graphics.*;
import android.os.Looper;
import android.view.*;
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import java.io.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.*;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35,qualifiers="w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE) @LooperMode(LooperMode.Mode.PAUSED)
public class ComposerLayoutTest {
    ActivityController<MainActivity> controller;MainActivity activity;KaiApp app;LinearLayout root;
    @Before public void start()throws Exception{
        controller=Robolectric.buildActivity(MainActivity.class).setup();activity=controller.get();app=(KaiApp)activity.getApplication();
        app.account.worker.submit(()->{}).get();Shadows.shadowOf(Looper.getMainLooper()).idle();
        app.account.token="layout-fixture";app.account.validUntil=System.currentTimeMillis()+60000;app.account.account=new JSONObject().put("id","layout-fixture");app.accountChanged();
        app.active=app.models.get(0);app.error="";app.status="Koinos Fast is ready · offline";app.changed();root=ReflectionHelpers.getField(activity,"root");
    }
    @After public void close(){controller.pause().stop().destroy();app.main.removeCallbacksAndMessages(null);app.account.worker.shutdownNow();app.network.shutdownNow();app.inference.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();}
    void layout(int width,int height){Shadows.shadowOf(Looper.getMainLooper()).idle();root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));root.layout(0,0,width,height);root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));root.layout(0,0,width,height);}
    void insets(int keyboard){root.dispatchApplyWindowInsets(new WindowInsets.Builder().setInsets(WindowInsets.Type.systemBars(),Insets.of(0,24,0,24)).setInsets(WindowInsets.Type.ime(),Insets.of(0,0,0,keyboard)).setVisible(WindowInsets.Type.ime(),keyboard>0).build());}
    Rect bounds(View view){Rect rect=new Rect(0,0,view.getWidth(),view.getHeight());root.offsetDescendantRectToMyCoords(view,rect);return rect;}
    void visible(String field,int bottom){View view=ReflectionHelpers.getField(activity,field);Rect rect=bounds(view);assertEquals(field,View.VISIBLE,view.getVisibility());assertTrue(field+" is clipped: "+rect,rect.top>=root.getPaddingTop()&&rect.bottom<=bottom&&rect.left>=0&&rect.right<=root.getWidth());assertTrue(field+" has no height",rect.height()>=48);}
    void capture(String name)throws Exception{Bitmap bitmap=Bitmap.createBitmap(root.getWidth(),root.getHeight(),Bitmap.Config.ARGB_8888);root.draw(new Canvas(bitmap));File folder=new File("build/reports/screenshots");folder.mkdirs();try(OutputStream out=new FileOutputStream(new File(folder,name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}bitmap.recycle();}
    @Test public void portraitComposerAndChatsStayVisibleWithKeyboardAndLongDraft()throws Exception{
        insets(0);layout(411,891);visible("composer",867);visible("send",867);visible("voiceButton",867);visible("webButton",867);visible("navigation",867);
        Button chats=ReflectionHelpers.getField(activity,"chatsButton");assertEquals("top-bar",((View)chats.getParent()).getTag());
        capture("compact-portrait");EditText composer=ReflectionHelpers.getField(activity,"composer");composer.setText("A question that wraps\nwith a second line\nand a third line\nand a fourth line\nand a fifth line");
        insets(360);layout(411,891);visible("composer",531);visible("send",531);assertEquals(View.GONE,((View)ReflectionHelpers.getField(activity,"navigation")).getVisibility());capture("compact-portrait-keyboard");
        assertTrue((composer.getImeOptions()&EditorInfo.IME_FLAG_NO_EXTRACT_UI)!=0);insets(0);layout(411,891);visible("navigation",867);assertTrue(composer.getText().toString().endsWith("fifth line"));
    }
    @Test @Config(qualifiers="w800dp-h360dp-land-mdpi") public void shortLandscapeKeepsInputAboveNavigationAndKeyboard()throws Exception{
        insets(0);layout(800,360);visible("composer",336);visible("send",336);visible("navigation",336);capture("compact-landscape");
        EditText composer=ReflectionHelpers.getField(activity,"composer");composer.setText("First line\nSecond line\nThird line\nFourth line");
        insets(150);layout(800,360);visible("composer",210);visible("send",210);visible("voiceButton",210);assertEquals(1,composer.getMaxLines());capture("compact-landscape-keyboard");
        app.voicePack.downloadId=99;app.voicePack.status="Downloading voice input · 50% of 41 MB";app.error="A recoverable error with a longer explanation";app.changed();layout(800,360);visible("composer",210);visible("send",210);capture("compact-landscape-status-keyboard");app.voicePack.downloadId=-1;
    }
    @Test @Config(sdk=28,qualifiers="w800dp-h360dp-land-mdpi") public void fittedOlderWindowKeepsInputInResizedSpace()throws Exception{
        layout(800,336);visible("composer",336);visible("send",336);visible("navigation",336);
        ReflectionHelpers.setField(activity,"keyboardVisible",true);layout(800,190);visible("composer",190);visible("send",190);assertEquals(View.GONE,((View)ReflectionHelpers.getField(activity,"navigation")).getVisibility());
        ReflectionHelpers.setField(activity,"keyboardVisible",false);layout(800,336);visible("navigation",336);
    }
    @Test public void rotationRebuildPreservesDraftAndCompactControls()throws Exception{
        EditText composer=ReflectionHelpers.getField(activity,"composer");composer.setText("Keep this dictated question");
        RuntimeEnvironment.setQualifiers("w800dp-h360dp-land-mdpi");activity.onConfigurationChanged(activity.getResources().getConfiguration());root=ReflectionHelpers.getField(activity,"root");insets(0);layout(800,360);
        composer=ReflectionHelpers.getField(activity,"composer");assertEquals("Keep this dictated question",composer.getText().toString());visible("composer",336);visible("send",336);
    }
}
