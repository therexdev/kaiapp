package io.koinosai.mobile;
import android.graphics.*;
import android.os.Looper;
import android.view.*;
import android.widget.*;
import java.io.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,qualifiers="w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE) @LooperMode(LooperMode.Mode.PAUSED)
public class VisualPreviewTest {
    ActivityController<MainActivity> controller;MainActivity activity;KaiApp app;
    @Before public void start() throws Exception {controller=Robolectric.buildActivity(MainActivity.class).setup();activity=controller.get();app=(KaiApp)activity.getApplication();app.account.worker.submit(()->{}).get();Shadows.shadowOf(Looper.getMainLooper()).idle();app.error="";app.changed();}
    @After public void close(){controller.pause().stop().destroy();app.main.removeCallbacksAndMessages(null);app.account.worker.shutdownNow();app.network.shutdownNow();app.inference.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();}
    TextView find(View v,String s){if(v instanceof TextView&&((TextView)v).getText().toString().equals(s))return (TextView)v;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){TextView r=find(((ViewGroup)v).getChildAt(i),s);if(r!=null)return r;}return null;}
    void tab(String label){TextView v=find(activity.getWindow().getDecorView(),label);assertNotNull(v);v.performClick();}
    void capture(String name) throws Exception {
        Shadows.shadowOf(Looper.getMainLooper()).idle();View view=activity.getWindow().getDecorView();
        int w=activity.getResources().getDisplayMetrics().widthPixels,h=activity.getResources().getDisplayMetrics().heightPixels;
        view.measure(View.MeasureSpec.makeMeasureSpec(w,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(h,View.MeasureSpec.EXACTLY));view.layout(0,0,w,h);
        Bitmap bitmap=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);view.draw(new Canvas(bitmap));
        File folder=new File("build/reports/screenshots");folder.mkdirs();try(OutputStream out=new FileOutputStream(new File(folder,name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}bitmap.recycle();
    }
    @Test public void portraitScreens() throws Exception {
        capture("welcome");
        android.graphics.drawable.Drawable icon=activity.getDrawable(R.mipmap.ic_launcher);Bitmap badge=Bitmap.createBitmap(192,192,Bitmap.Config.ARGB_8888);icon.setBounds(0,0,192,192);icon.draw(new Canvas(badge));try(OutputStream out=new FileOutputStream("build/reports/screenshots/launcher.png")){badge.compress(Bitmap.CompressFormat.PNG,100,out);}badge.recycle();
        tab("Accounts");capture("sign-in");
        app.account.token="preview-fixture";app.account.validUntil=System.currentTimeMillis()+60000;app.account.account=new JSONObject().put("id","fixture").put("email","you@koinos.example");app.accountChanged();app.setNetworkEnabled(true);
        app.account.nodesAt=System.currentTimeMillis();app.account.nodes=new JSONArray().put(new JSONObject().put("address","1KAIExampleNodeForVisualReview").put("online",true).put("ramGb",32).put("models",new JSONArray().put("koinos-fast")).put("producer",new JSONObject().put("producingVhp",125000).put("vhpSats","12500000000000").put("koinSats","140000000").put("reportedAt","2026-09-22T18:50:00Z").put("sharePct",0.0032).put("blocksPerDay",0.65)));app.account.changed();capture("account-fixture");tab("Mining");capture("mining-fixture");
        tab("Chat");capture("chat");app.active=app.models.get(0);
        app.searching=true;app.generating=true;app.busy=true;app.searchQuestion="What processor does the Retroid Pocket 5 use?";app.searchProvider="DuckDuckGo";app.changed();capture("web-search-fixture");app.searching=false;
        KaiApp.ChatMessage question=new KaiApp.ChatMessage("user","What processor does the Retroid Pocket 5 use?");
        KaiApp.ChatMessage answer=new KaiApp.ChatMessage("assistant","");answer.incomplete=true;
        answer.research=new WebSearch.Result("Preview fixture","Retroid Pocket 5",System.currentTimeMillis(),java.util.Arrays.asList(new WebSearch.Source("Retroid Pocket 5 · specifications","https://www.goretroid.com/","Snapdragon 865 processor.")));
        app.current.messages.add(question);app.current.messages.add(answer);app.prefs.edit().putBoolean("webSearch",true).apply();app.changed();capture("web-thinking-fixture");
        answer.text="The Retroid Pocket 5 uses the Snapdragon 865. [1]";answer.incomplete=false;app.generating=false;app.busy=false;app.changed();capture("web-answer-fixture");tab("Sources · 1 ▾");capture("web-sources-expanded-fixture");tab("Sources · 1 ▴");
        app.voicePack.downloadId=99;app.voicePack.downloaded=VoicePack.BYTES/2;app.voicePack.status="Downloading voice input · 50% of 41 MB";app.changed();capture("voice-download-fixture");app.voicePack.downloadId=-1;app.voicePack.status="";
        app.current.messages.clear();app.active=null;app.changed();EditText composer=org.robolectric.util.ReflectionHelpers.getField(activity,"composer");composer.setText("What's the best starter in Pokémon Red and Blue?");capture("voice-draft-fixture");
        tab("Models");capture("models");tab("Network");capture("network");tab("Settings");capture("settings");app.setNetworkEnabled(false);tab("Network");capture("offline-modes");
    }
    @Test @Config(qualifiers="w960dp-h540dp-land-mdpi") public void handheldLandscape() throws Exception {capture("handheld-welcome");tab("Accounts");capture("handheld-account");}
}
