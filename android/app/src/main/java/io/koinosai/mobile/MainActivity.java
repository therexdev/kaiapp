package io.koinosai.mobile;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.*;
import android.net.Uri;
import android.os.*;
import android.text.InputFilter;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

public final class MainActivity extends Activity {
    private static final int BLUE=0xff155eef, NAVY=0xff14284e, MUTED=0xff61728d, BG=0xfff4f7fd, BORDER=0xffdce5f2, GREEN=0xff168469;
    private static final int IMPORT=10, EXPORT=11;
    private KaiApp app;
    private LinearLayout root, body, errorPanel;
    private TextView status, errorText, modelLabel, routeBadge;
    private EditText composer;
    private Button send;
    private ScrollView chatScroll;
    private String tab="Chat", pageKey="", exportText="", accountSection="nodes";
    private final Map<String,String> drafts=new HashMap<>();
    private String renderedChatId="";
    private final Map<KaiApp.ChatMessage,TextView> bubbles=new IdentityHashMap<>();
    private final Map<KaiApp.Model,TextView> downloadLabels=new IdentityHashMap<>();
    private final Map<KaiApp.Model,ProgressBar> downloadBars=new IdentityHashMap<>();
    private final List<Button> tabs=new ArrayList<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); app=(KaiApp)getApplication();
        if(state!=null)tab=state.getString("tab","Chat");
        buildShell();
        if(state!=null&&composer!=null)composer.setText(state.getString("draft",""));
    }
    @Override protected void onStart() { super.onStart(); app.listener=this::render; app.account.setForeground(true);render(); }
    @Override protected void onStop() {
        app.listener=null;app.account.setForeground(false);
        if(!isChangingConfigurations() && app.generating) app.stop();
        super.onStop();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("tab",tab); if(composer!=null)state.putString("draft",composer.getText().toString()); super.onSaveInstanceState(state);
    }
    @Override public void onConfigurationChanged(Configuration config) {super.onConfigurationChanged(config);if(composer!=null)drafts.put(renderedChatId,composer.getText().toString());tabs.clear();buildShell();}
    private int dp(float n) {return Math.round(n*getResources().getDisplayMetrics().density);}
    private GradientDrawable bg(int color,int radius) {
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;
    }
    private GradientDrawable outline(int fill,int stroke) {
        GradientDrawable d=bg(fill,18);d.setStroke(dp(1),stroke);return d;
    }
    private TextView text(String value,int size,int color,boolean bold) {
        TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setLineSpacing(dp(2),1);
        if(bold)v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return v;
    }
    private LinearLayout column() {LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    private LinearLayout row() {LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.HORIZONTAL);l.setGravity(Gravity.CENTER_VERTICAL);return l;}
    private void space(LinearLayout l,int n) {Space s=new Space(this);l.addView(s,new LinearLayout.LayoutParams(1,dp(n)));}
    private void add(LinearLayout l,View v) {l.addView(v,new LinearLayout.LayoutParams(-1,-2));}
    private Button button(String label,boolean primary,Runnable action) {
        Button b=new Button(this);b.setText(label);b.setTextSize(14);b.setAllCaps(false);b.setMinHeight(dp(46));b.setMinimumHeight(dp(46));
        b.setTextColor(primary?Color.WHITE:BLUE);b.setPadding(dp(14),dp(6),dp(14),dp(6));
        StateListDrawable states=new StateListDrawable();
        states.addState(new int[]{-android.R.attr.state_enabled},outline(0xffe8edf5,BORDER));
        states.addState(new int[]{android.R.attr.state_focused},outline(primary?0xff1048be:0xffdce9ff,0xff093283));
        states.addState(new int[]{android.R.attr.state_pressed},outline(primary?0xff1048be:0xffdce9ff,BLUE));
        states.addState(new int[]{},outline(primary?BLUE:Color.WHITE,primary?BLUE:BORDER));
        b.setBackground(states);b.setStateListAnimator(null);b.setOnClickListener(v->action.run());return b;
    }
    private void weighted(LinearLayout l,View v) {LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);p.setMargins(dp(3),0,dp(3),0);l.addView(v,p);}
    private LinearLayout card(LinearLayout parent) {
        LinearLayout c=column();c.setPadding(dp(18),dp(16),dp(18),dp(16));c.setBackground(outline(Color.WHITE,0xffe7edf7));c.setElevation(dp(1));
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(16);parent.addView(c,p);return c;
    }
    private LinearLayout scrollBody() {
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);body.addView(scroll,new LinearLayout.LayoutParams(-1,-1));
        LinearLayout content=column();content.setPadding(dp(18),dp(18),dp(18),dp(10));scroll.addView(content);return content;
    }
    private void buildShell() {
        root=column();root.setBackgroundColor(BG);
        FrameLayout canvas=new FrameLayout(this);canvas.setBackgroundColor(BG);
        int available=getResources().getDisplayMetrics().widthPixels;
        FrameLayout.LayoutParams frame=new FrameLayout.LayoutParams(Math.min(available,dp(840)),-1,Gravity.CENTER_HORIZONTAL);canvas.addView(root,frame);setContentView(canvas);
        root.setOnApplyWindowInsetsListener((v,insets)-> {root.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
        LinearLayout heading=row();heading.setPadding(dp(18),dp(10),dp(18),dp(10));
        ImageView icon=new ImageView(this);icon.setImageResource(R.drawable.ic_kai);icon.setContentDescription("KAI robot");heading.addView(icon,new LinearLayout.LayoutParams(dp(48),dp(42)));
        LinearLayout brand=column();brand.setPadding(dp(12),0,0,0);
        add(brand,text("KAI",22,NAVY,true));add(brand,text("KOINOS AI",12,MUTED,false));heading.addView(brand,new LinearLayout.LayoutParams(0,-2,1));
        routeBadge=text("LOCAL ONLY",10,BLUE,true);routeBadge.setPadding(dp(10),dp(8),dp(10),dp(8));routeBadge.setBackground(bg(0xffe7efff,20));routeBadge.setMinHeight(dp(48));routeBadge.setGravity(Gravity.CENTER);routeBadge.setFocusable(true);routeBadge.setOnClickListener(v->go("Network"));heading.addView(routeBadge);add(root,heading);
        status=text(app.status,12,MUTED,false);status.setPadding(dp(18),0,dp(18),dp(10));add(root,status);
        errorPanel=row();errorPanel.setPadding(dp(16),dp(6),dp(10),dp(6));errorPanel.setBackgroundColor(0xffffeded);
        errorText=text("",13,0xff9b2636,false);errorPanel.addView(errorText,new LinearLayout.LayoutParams(0,-2,1));
        Button dismiss=button("Dismiss",false,()->app.clearError());errorPanel.addView(dismiss);add(root,errorPanel);
        body=column();root.addView(body,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout nav=row();nav.setPadding(dp(12),dp(8),dp(12),dp(8));nav.setBackgroundColor(Color.WHITE);
        for(String name:new String[]{"Chat","Models","Network","Accounts","Settings"}) {
            Button b=button(name,false,()->go(name));b.setTag(name);b.setTextSize(10);b.setPadding(dp(2),dp(7),dp(2),dp(7));
            int id=name.equals("Chat")?R.drawable.ic_chat:name.equals("Models")?R.drawable.ic_models:name.equals("Network")?R.drawable.ic_network:name.equals("Accounts")?R.drawable.ic_account:R.drawable.ic_settings;
            Drawable iconNav=getDrawable(id).mutate();iconNav.setBounds(0,0,dp(21),dp(21));b.setCompoundDrawables(null,iconNav,null,null);b.setCompoundDrawablePadding(dp(4));b.setContentDescription(name);tabs.add(b);weighted(nav,b);
        }
        add(root,nav);pageKey="";render();
    }
    private void go(String name){hideKeyboard();tab=name;pageKey="";render();}
    private String key() {
        String auth=app.account.signedIn()+app.account.owner()+app.route;
        if(tab.equals("Accounts")||tab.equals("Network"))return tab+auth+app.account.revision+app.grantId+app.busy+accountSection;
        if(tab.equals("Chat")&&!app.account.signedIn())return "gate"+auth+app.account.restoring;

        if(tab.equals("Chat"))return tab+auth+app.current.id+app.current.messages.size()+app.generating+(app.active==null?"":app.active.id);
        if(tab.equals("Settings"))return tab;
        StringBuilder k=new StringBuilder(tab+auth).append(app.busy).append(app.importing).append(app.transferStatus).append(app.active==null?"":app.active.id);
        for(KaiApp.Model m:app.models)k.append(m.id).append(m.installed).append(m.downloadId).append(m.downloadStatus).append(m.issue).append(app.verifying.contains(m.id));
        return k.toString();
    }
    private void render() {
        routeBadge.setText(app.routeLabel().toUpperCase(Locale.ROOT));
        status.setVisibility(tab.equals("Chat")?View.VISIBLE:View.GONE);
        status.setText(app.account.signedIn()?app.status:"Sign in to your KAI account to get started");errorText.setText(app.error);errorPanel.setVisibility(app.error.isEmpty()?View.GONE:View.VISIBLE);
        for(Button b:tabs) {boolean selected=b.getText().toString().equals(tab);b.setTextColor(selected?BLUE:MUTED);b.setTypeface(Typeface.DEFAULT,selected?Typeface.BOLD:Typeface.NORMAL);b.setBackground(bg(selected?0xffeaf1ff:Color.WHITE,16));Drawable icon=b.getCompoundDrawables()[1];if(icon!=null)icon.setTint(selected?BLUE:MUTED);}
        String key=key();
        if(!key.equals(pageKey)) {
            if(composer!=null)drafts.put(renderedChatId,composer.getText().toString());
            String draft=drafts.getOrDefault(app.current.id,"");
            int oldScroll=body.getChildCount()>0&&body.getChildAt(0) instanceof ScrollView?body.getChildAt(0).getScrollY():0;
            body.removeAllViews();composer=null;send=null;modelLabel=null;bubbles.clear();downloadBars.clear();downloadLabels.clear();pageKey=key;
            if(tab.equals("Chat")){if(app.account.signedIn())buildChat(draft);else buildWelcome();}
            else if(tab.equals("Models"))buildModels();else if(tab.equals("Network"))buildNetwork();else if(tab.equals("Accounts"))buildAccounts();else buildSettings();
            if(body.getChildCount()>0&&body.getChildAt(0) instanceof ScrollView){ScrollView scroll=(ScrollView)body.getChildAt(0);scroll.post(()->scroll.scrollTo(0,oldScroll));}
        }
        if(tab.equals("Chat")&&composer!=null) {
            if(modelLabel!=null)modelLabel.setText(app.networkAllowed()?(app.route.equals("own")?"Your desktop node · encrypted connection":"Koinos network · account spending grant"):(app.active==null?"Local only · choose a model in Models":app.active.name+" · on this device"));
            for(Map.Entry<KaiApp.ChatMessage,TextView> entry:bubbles.entrySet()) {
                String value=entry.getKey().text;
                if(value.isEmpty())value=app.generating?"Thinking…":"No response saved.";
                TextView t=entry.getValue();
                if(!t.getText().toString().equals(value)) {
                    boolean atBottom=chatScroll.getChildAt(0).getHeight()-chatScroll.getHeight()-chatScroll.getScrollY()<dp(100);
                    t.setText(value);if(atBottom)chatScroll.post(()->chatScroll.fullScroll(View.FOCUS_DOWN));
                }
            }
            send.setText(app.busy?"Stop":"Send");send.setEnabled(app.busy||(app.account.signedIn()&&(app.networkAllowed()||app.active!=null)));
            composer.setEnabled(!app.busy);
        }
        if(tab.equals("Models"))for(KaiApp.Model m:downloadLabels.keySet()) {
            String label;
            if(app.verifying.contains(m.id))label="Verifying download…";
            else if(m.downloadStatus==DownloadManager.STATUS_PAUSED)label="Waiting for network / Wi-Fi…";
            else if(m.downloadStatus==DownloadManager.STATUS_PENDING)label="Queued for download…";
            else label=String.format(Locale.US,"%.0f%% · %s of %s",Math.min(100,100.0*m.downloaded/Math.max(1,m.bytes)),KaiApp.size(m.downloaded),KaiApp.size(m.bytes));
            downloadLabels.get(m).setText(label);
            ProgressBar p=downloadBars.get(m);p.setIndeterminate(app.verifying.contains(m.id));p.setProgress((int)Math.min(100,100.0*m.downloaded/Math.max(1,m.bytes)));
        }
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if(app.busy)getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private void buildChat(String draft) {
        renderedChatId=app.current.id;
        LinearLayout toolbar=row();toolbar.setPadding(dp(18),dp(6),dp(18),dp(8));
        TextView title=text(app.current.title,16,NAVY,true);title.setMaxLines(1);title.setEllipsize(android.text.TextUtils.TruncateAt.END);toolbar.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        toolbar.addView(button("Chats",false,this::history));add(body,toolbar);
        modelLabel=text("",12,MUTED,false);modelLabel.setPadding(dp(18),0,dp(18),dp(8));add(body,modelLabel);
        chatScroll=new ScrollView(this);chatScroll.setFillViewport(true);body.addView(chatScroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout messages=column();messages.setPadding(dp(18),dp(8),dp(18),dp(12));chatScroll.addView(messages);
        if(app.current.messages.isEmpty()) {
            LinearLayout welcome=card(messages);hero(welcome,"Hey, I'm KAI.","A little AI. A lot of possibility.");space(welcome,12);
            add(welcome,text(app.networkAllowed()?"A bigger world of ideas, powered by your KAI network.":"A space to think, create, and ask anything. Right here on your device.",15,MUTED,false));space(welcome,18);
            if(!app.networkAllowed()&&app.active==null)add(welcome,button("Choose a local model",true,()->go("Models")));
            else {
                add(welcome,button("Help me plan my day",false,()->submit("Help me plan my day. Ask me what I need to get done first.")));space(welcome,8);
                add(welcome,button("Explain something simply",false,()->submit("Ask me what topic I would like you to explain simply.")));
            }
        }
        for(KaiApp.ChatMessage message:app.current.messages) {
            LinearLayout c=card(messages);boolean user=message.role.equals("user");if(user)c.setBackground(outline(0xffeaf1ff,0xffd4e3ff));
            add(c,text(user?"YOU":message.incomplete&&!app.generating?"KAI · PARTIAL REPLY":"KAI",11,user?BLUE:GREEN,true));space(c,6);
            TextView content=text(message.text,16,NAVY,false);content.setTextIsSelectable(true);add(c,content);bubbles.put(message,content);
        }
        LinearLayout input=row();input.setPadding(dp(14),dp(8),dp(14),dp(8));input.setBackgroundColor(Color.WHITE);
        composer=new EditText(this);composer.setTextColor(NAVY);composer.setHintTextColor(MUTED);composer.setTextSize(16);composer.setHint("Message KAI…");
        composer.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE|android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setMinLines(1);composer.setMaxLines(4);composer.setFilters(new InputFilter[]{new InputFilter.LengthFilter(12000)});composer.setText(draft);
        composer.setPadding(dp(12),dp(8),dp(12),dp(8));composer.setBackground(outline(BG,BORDER));
        LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(0,-2,1);cp.rightMargin=dp(8);input.addView(composer,cp);
        send=button("Send",true,()-> {
            if(app.busy) {app.stop();return;}
            String prompt=composer.getText().toString();if(prompt.trim().isEmpty())return;
            submit(prompt);
        });input.addView(send,new LinearLayout.LayoutParams(-2,dp(48)));add(body,input);
        chatScroll.post(()->chatScroll.fullScroll(View.FOCUS_DOWN));
    }
    private void buildModels() {
        LinearLayout content=scrollBody();add(content,text("Your model library",28,NAVY,true));space(content,6);
        add(content,text("Download once. Chat offline.",16,MUTED,false));space(content,18);
        if(!app.account.signedIn()){signInCard(content);}
        LinearLayout device=card(content);add(device,text(Build.MODEL,16,NAVY,true));space(device,5);
        add(device,text(KaiApp.size(app.totalRam())+" RAM · "+KaiApp.size(app.modelDir().getUsableSpace())+" storage free",13,MUTED,false));space(device,6);
        add(device,text("Start with Koinos Fast for a lighter experience. Close demanding games before loading a model.",13,MUTED,false));
        if(app.busy) {LinearLayout c=card(content);add(c,text(app.status,15,BLUE,true));space(c,10);add(c,button("Stop",false,()->app.stop()));}
        for(KaiApp.Model m:app.models) {
            LinearLayout c=card(content);boolean loaded=app.active==m;
            TextView badge=text(loaded?"●  LOADED":m.installed?"✓  ON DEVICE":m.id.equals("koinos-fast")?"RECOMMENDED":"LOCAL MODEL",11,loaded||m.installed?GREEN:BLUE,true);add(c,badge);space(c,7);
            add(c,text(m.name,21,NAVY,true));space(c,4);add(c,text(m.model,12,MUTED,false));space(c,10);
            add(c,text(m.description,14,MUTED,false));space(c,10);
            add(c,text(KaiApp.size(m.bytes)+(m.imported?" · imported":" · "+m.minRam+" GB RAM recommended"),13,NAVY,true));
            if(!m.issue.isEmpty()){space(c,10);add(c,text(m.issue,13,0xffa62f3f,false));}
            if(m.downloadId!=-1||app.verifying.contains(m.id)) {
                space(c,12);ProgressBar progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(100);add(c,progress);downloadBars.put(m,progress);
                TextView label=text("",12,MUTED,false);add(c,label);downloadLabels.put(m,label);space(c,12);
                if(!app.verifying.contains(m.id))add(c,button(m.downloadStatus==DownloadManager.STATUS_FAILED?"Retry download":"Cancel download",false,()-> {
                    boolean retry=m.downloadStatus==DownloadManager.STATUS_FAILED;app.cancelDownload(m);if(retry)confirmDownload(m);
                }));
            } else {
                space(c,14);LinearLayout actions=row();
                Button primary=button(loaded?"Unload":m.installed?"Load model":"Download",true,()->{if(loaded)app.unload();else if(m.installed)app.loadModel(m);else confirmDownload(m);});
                primary.setEnabled(!app.busy&&!app.importing);weighted(actions,primary);
                if(m.installed) {Button delete=button("Delete",false,()->confirm("Delete "+m.name+"?","This removes its model file. Your saved conversations remain.","Delete",()->app.deleteModel(m)));delete.setEnabled(!app.busy&&!loaded);weighted(actions,delete);}
                add(c,actions);
            }
            if(!m.imported) {space(c,7);Button license=button("Model license · "+m.license,false,()->openUrl(m.licenseUrl));add(c,license);}
        }
        LinearLayout custom=card(content);add(custom,text("Bring your own model",19,NAVY,true));space(custom,8);
        add(custom,text("Import a single text GGUF file from device storage or an SD card. KAI keeps its own copy; support depends on the model architecture and chat template.",14,MUTED,false));space(custom,14);
        if(app.importing){add(custom,text(app.transferStatus,14,BLUE,true));space(custom,8);add(custom,button("Cancel import",false,()->app.fileCancelled.set(true)));}
        else {Button b=button("Import GGUF",false,()-> {
            Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(i,IMPORT);
        });b.setEnabled(!app.busy);add(custom,b);}
    }
    private void confirmDownload(KaiApp.Model m) {
        if(!app.account.signedIn()){go("Accounts");return;}
        if(!app.networkAllowed()){confirm("Connect to download?","Enable network access for model downloads. After downloading, choose Local only to disconnect again.","Enable network",()->{app.setRoute("network");confirmDownload(m);});return;}
        confirm("Download "+m.name+"?",KaiApp.size(m.bytes)+" will be downloaded from Hugging Face.\n\n"+m.creator+"\nLicense: "+m.license+" (available on the model card).\n\n"+(app.prefs.getBoolean("wifi",true)?"Wi-Fi downloads only.":"Mobile data downloads are allowed.")+" Chat stays offline after setup.","Download",()->app.download(m));
    }
    private void buildSettings() {
        LinearLayout content=scrollBody();add(content,text("Make KAI yours",28,NAVY,true));space(content,18);
        LinearLayout engine=card(content);add(engine,text("Local performance",20,NAVY,true));space(engine,10);
        add(engine,text("Changes to context and CPU threads apply the next time you load a model.",13,MUTED,false));space(engine,12);
        add(engine,text("Conversation context",14,NAVY,true));spinner(engine,new String[]{"1,024 tokens · light","2,048 tokens · balanced","4,096 tokens · more memory"},new int[]{1024,2048,4096},app.contextSize(),v->app.prefs.edit().putInt("context",v).apply());
        space(engine,10);add(engine,text("CPU threads",14,NAVY,true));spinner(engine,new String[]{"2 · lower load","4 · recommended","6 · higher load"},new int[]{2,4,6},app.threads(),v->app.prefs.edit().putInt("threads",v).apply());
        space(engine,10);add(engine,text("Maximum reply length",14,NAVY,true));spinner(engine,new String[]{"128 tokens · short","384 tokens · standard","768 tokens · long"},new int[]{128,384,768},app.prefs.getInt("tokens",384),v->app.prefs.edit().putInt("tokens",v).apply());
        space(engine,10);add(engine,text("Response style",14,NAVY,true));spinner(engine,new String[]{"Focused","Balanced","Creative"},new int[]{20,70,100},Math.round(app.prefs.getFloat("temperature",.7f)*100),v->app.prefs.edit().putFloat("temperature",v/100f).apply());
        space(engine,10);add(engine,button("Reload active model",false,()->{if(app.active!=null&&!app.busy)app.loadModel(app.active);else app.fail("Load a model from Models first.");}));
        LinearLayout personality=card(content);add(personality,text("KAI's instructions",20,NAVY,true));space(personality,8);
        EditText system=new EditText(this);system.setText(app.prefs.getString("system",KaiApp.SYSTEM));system.setTextSize(14);system.setTextColor(NAVY);system.setMinLines(3);system.setGravity(Gravity.TOP);system.setFilters(new InputFilter[]{new InputFilter.LengthFilter(2000)});add(personality,system);space(personality,8);
        add(personality,button("Save instructions",true,()-> {app.prefs.edit().putString("system",system.getText().toString()).apply();hideKeyboard();Toast.makeText(this,"Saved for your next message",Toast.LENGTH_SHORT).show();}));
        LinearLayout downloads=card(content);add(downloads,text("Downloads & privacy",20,NAVY,true));space(downloads,10);
        Switch wifi=new Switch(this);wifi.setText("Download on Wi-Fi only");wifi.setTextSize(15);wifi.setTextColor(NAVY);wifi.setChecked(app.prefs.getBoolean("wifi",true));wifi.setPadding(0,dp(8),0,dp(8));wifi.setOnCheckedChangeListener((b,v)->app.prefs.edit().putBoolean("wifi",v).apply());add(downloads,wifi);space(downloads,10);
        add(downloads,text("This applies to new downloads. Android manages downloads in the background. Model files are checked before use.\n\nChats stay in this app's storage and are excluded from Android backup. Generation stops when you leave the app. Local only blocks account refresh, downloads, and network chat. Your saved sign-in unlocks offline chat for up to 30 days after verification.",14,MUTED,false));
        LinearLayout about=card(content);add(about,text("KAI Mobile",19,NAVY,true));space(about,8);
        add(about,text("Version 0.2.0 · Android 9+ · ARM64\nMade for a little more possibility.\n\nLocal AI powered by llama.cpp. Connect to your KAI account, chat over the network, and check your nodes. Mining happens on your existing nodes, not on this handheld.",14,MUTED,false));space(about,12);
        add(about,button("Open-source notices",false,()-> {
            try(InputStream input=getAssets().open("third-party-notices.txt")) {
                new AlertDialog.Builder(this).setTitle("Open-source notices").setMessage(new String(ModelFile.readLimited(input,128*1024),StandardCharsets.UTF_8)).setPositiveButton("Close",null).show();
            } catch(IOException e) {app.fail("Could not open the notices.");}
        }));
    }
    private void hero(LinearLayout parent,String title,String subtitle){
        LinearLayout hero=row();LinearLayout words=column();add(words,text(title,28,NAVY,true));space(words,8);add(words,text(subtitle,14,MUTED,false));
        hero.addView(words,new LinearLayout.LayoutParams(0,-2,1));
        ImageView robot=new ImageView(this);robot.setImageResource(R.drawable.kai_mascot);robot.setContentDescription("KAI, your robot companion");robot.setScaleType(ImageView.ScaleType.FIT_CENTER);
        hero.addView(robot,new LinearLayout.LayoutParams(dp(102),dp(140)));add(parent,hero);
    }
    private void signInCard(LinearLayout parent){
        LinearLayout c=card(parent);add(c,text("One account. All your KAI.",20,NAVY,true));space(c,8);
        add(c,text("Sign in to unlock local models, network chat, and your connected nodes.",15,MUTED,false));space(c,16);
        add(c,button("Sign in to KAI",true,()->go("Accounts")));
    }
    private void buildWelcome(){
        LinearLayout content=scrollBody(),welcome=card(content);hero(welcome,"Meet your\nlittle AI.","Ideas. Answers. A little company.");space(welcome,16);
        add(welcome,text("Your AI, wherever you go.",21,NAVY,true));space(welcome,8);
        add(welcome,text("Run a model on your handheld or connect to the Koinos AI network. One familiar companion, wherever inspiration finds you.",15,MUTED,false));space(welcome,20);
        Button sign=button(app.account.restoring?"Opening your account…":"Get started · Sign in",true,()->go("Accounts"));sign.setEnabled(!app.account.restoring);add(welcome,sign);
        LinearLayout note=card(content);add(note,text("PRIVATE BY CHOICE",11,BLUE,true));space(note,8);add(note,text("Local only keeps your conversations on this device. Sign in once, then take your downloaded models offline.",14,MUTED,false));
    }
    private void submit(String prompt){
        if(!app.account.signedIn()){go("Accounts");return;}
        Runnable sendPrompt=()->{if(composer!=null)composer.setText("");hideKeyboard();app.send(prompt);};
        if(!app.networkAllowed()){sendPrompt.run();return;}
        JSONObject grant=app.account.grant(app.grantId);
        if(grant==null){accountSection="access";go("Accounts");app.fail("Choose a spending grant for network chat.");return;}
        String destination=app.route.equals("own")?"your own desktop node through the Koinos scheduler":"the Koinos AI network";
        confirm("Send to "+app.routeLabel()+"?","This message and this conversation's history will be sent to "+destination+".\n\nModel: "+app.networkModel+".\nGrant remaining: "+money(grant.optDouble("remainingUsd"))+". The server enforces its cap and expiry. "+(app.route.equals("own")?"If your node is unavailable, the request fails without switching to other providers.":"Network usage may spend from this grant.")+"\n\nYou can stop the response at any time; work already completed may still be charged.","Send message",sendPrompt);
    }
    private void chooseRoute(String route){
        if(app.busy){app.fail("Stop the current task before switching modes.");return;}
        if(route.equals(app.route))return;
        String message=route.equals("local")?"Disconnect account updates and network chat. In-progress model downloads will be cancelled. Downloaded models remain available offline with your saved sign-in.":"Allow connections to koinosai.com. Messages are sent only when you choose Send and confirm. Switching modes starts a fresh conversation.";
        confirm(route.equals("local")?"Go local only?":"Enable network access?",message,route.equals("local")?"Go local":"Connect",()->{app.setRoute(route);if(app.account.hasSavedSession()&&app.networkAllowed())app.account.refresh();});
    }
    private void modeCard(LinearLayout parent,String route,String name,String description,int icon){
        LinearLayout c=card(parent);boolean selected=app.route.equals(route);if(selected)c.setBackground(outline(0xffedf4ff,0xff8db6ff));
        LinearLayout heading=row();ImageView image=new ImageView(this);image.setImageResource(icon);heading.addView(image,new LinearLayout.LayoutParams(dp(26),dp(26)));
        TextView label=text(name,20,NAVY,true);label.setPadding(dp(12),0,0,0);heading.addView(label,new LinearLayout.LayoutParams(0,-2,1));if(selected)heading.addView(text("ACTIVE",10,BLUE,true));add(c,heading);space(c,12);
        add(c,text(description,14,MUTED,false));space(c,14);Button use=button(selected?"Selected":"Use "+name,!selected,()->chooseRoute(route));use.setEnabled(!app.busy&&!selected);add(c,use);
    }
    private void buildNetwork(){
        LinearLayout content=scrollBody();add(content,text("Choose your connection",27,NAVY,true));space(content,8);add(content,text("Same KAI. Your choice of where it thinks.",15,MUTED,false));space(content,22);
        modeCard(content,"local","Local only","Your model runs on this device. No account refresh, model downloads, or network requests. Your saved sign-in allows offline use for up to 30 days.",R.drawable.ic_shield);
        modeCard(content,"network","Network","Use the Koinos AI network with your account's existing spending grant. Review each send and see its reported cost when the reply finishes.",R.drawable.ic_network);
        modeCard(content,"own","My node","Route chat to your own desktop node using the grant linked to its wallet. The node must be online and serving models. KAI never falls back to other providers.",R.drawable.ic_models);
        if(app.networkAllowed()){
            LinearLayout account=card(content);add(account,text("Your network access",20,NAVY,true));space(account,8);
            JSONObject grant=app.account.grant(app.grantId);add(account,text(!app.account.signedIn()?"Sign in to connect.":grant==null?"Select an active spending grant in Accounts.":"Selected grant · "+money(grant.optDouble("remainingUsd"))+" remaining",14,MUTED,false));space(account,12);
            add(account,button("Open Accounts",false,()->{accountSection="access";go("Accounts");}));
            if(app.account.signedIn()){
                LinearLayout picker=card(content);add(picker,text("Network model",20,NAVY,true));space(picker,8);
                add(picker,text("Prices are per million tokens, reported by the network. The server checks availability and your grant on every request.",13,MUTED,false));space(picker,10);
                List<String> ids=new ArrayList<>(),labels=new ArrayList<>();ids.add("auto");labels.add("Best available · automatic");
                for(int i=0;i<app.account.networkModels.length();i++){JSONObject m=app.account.networkModels.optJSONObject(i);if(m==null)continue;ids.add(m.optString("model"));labels.add(m.optString("model")+" · "+money(m.optDouble("inUsdPerM"))+" in / "+money(m.optDouble("outUsdPerM"))+" out");}
                Spinner model=new Spinner(this);ArrayAdapter<String> adapter=new ArrayAdapter<>(this,android.R.layout.simple_spinner_item,labels);adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);model.setAdapter(adapter);model.setMinimumHeight(dp(48));model.setSelection(Math.max(0,ids.indexOf(app.networkModel)));
                model.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> p){}public void onItemSelected(AdapterView<?> p,View v,int i,long id){app.networkModel=ids.get(i);}});add(picker,model);
                add(picker,button("Refresh available models",false,()->app.account.refresh()));
            }
        }
    }
    private String money(double value){return Double.isFinite(value)?String.format(Locale.US,"$%.2f",value):"Unavailable";}
    private String address(String value){return value.length()>20?value.substring(0,10)+"…"+value.substring(value.length()-8):value;}
    private String timestamp(long value){return value>0?android.text.format.DateFormat.format("MMM d, h:mm a",new Date(value)).toString():"Not refreshed yet";}
    private String timestamp(String iso){try{return timestamp(java.time.Instant.parse(iso).toEpochMilli());}catch(Exception e){return "Time unavailable";}}
    private void detail(LinearLayout parent,String name,String value){
        LinearLayout r=row();r.setPadding(0,dp(6),0,dp(6));r.addView(text(name,13,MUTED,false),new LinearLayout.LayoutParams(0,-2,1));TextView v=text(value,13,NAVY,true);v.setGravity(Gravity.END);r.addView(v,new LinearLayout.LayoutParams(0,-2,1));add(parent,r);
    }
    private void beginSignIn(){
        Runnable start=()->{if(!app.networkAllowed())app.setRoute("network");app.account.start();};
        if(!app.networkAllowed())confirm("Sign in with KAI","Enable network access to sign in through koinosai.com in your browser. Your password and passkeys stay with the website. You can choose Local only after signing in.","Continue",start);else start.run();
    }
    private void buildAccounts(){
        AccountState a=app.account;LinearLayout content=scrollBody();add(content,text("Your KAI account",28,NAVY,true));space(content,8);
        add(content,text("One home for your connected world.",15,MUTED,false));space(content,22);
        if(!a.error.isEmpty()){LinearLayout issue=card(content);add(issue,text(a.error,14,0xffa62f3f,false));}
        if(!a.signedIn()){
            LinearLayout login=card(content);hero(login,"Welcome\nback.","Use your existing website account.");space(login,12);
            if(a.restoring){add(login,text("Opening saved sign-in…",15,MUTED,false));return;}
            if(!a.code.isEmpty()){
                add(login,text("YOUR SIGN-IN CODE",11,BLUE,true));space(login,8);TextView code=text(a.code,30,NAVY,true);code.setTypeface(Typeface.MONOSPACE,Typeface.BOLD);code.setTextIsSelectable(true);add(login,code);space(login,8);
                add(login,text("Open the website, sign in, and approve this code. Return here to finish. Expires "+timestamp(a.codeExpires)+".",14,MUTED,false));space(login,16);
                add(login,button("Open koinosai.com/link",true,()->openUrl(NetworkApi.ORIGIN+"/link")));space(login,8);
                Button check=button(a.working?"Checking…":"I've approved it · Check",false,()->a.poll());check.setEnabled(!a.working);add(login,check);space(login,8);
                add(login,button("Cancel sign-in",false,()->a.cancelRequests()));
            }else{
                add(login,text(a.hasSavedSession()?"Your session needs to be verified. Reconnect to refresh it or sign in again.":"Sign in securely in your browser with the same email, Google account, or passkey you use on the website.",14,MUTED,false));space(login,16);
                Button sign=button(a.working?"Connecting…":"Sign in with KAI",true,this::beginSignIn);sign.setEnabled(!a.working&&!app.busy);add(login,sign);
                if(a.hasSavedSession()){space(login,8);add(login,button("Retry saved sign-in",false,()->{if(!app.networkAllowed())chooseRoute("network");else a.refresh();}));space(login,8);add(login,button("Forget saved sign-in",false,()->a.signOut()));}
            }
            return;
        }
        LinearLayout profile=card(content);LinearLayout heading=row();ImageView face=new ImageView(this);face.setImageResource(R.drawable.ic_kai);heading.addView(face,new LinearLayout.LayoutParams(dp(52),dp(48)));
        LinearLayout name=column();name.setPadding(dp(12),0,0,0);add(name,text("CONNECTED TO KAI",10,BLUE,true));space(name,4);TextView email=text(a.account.optString("email","KAI account"),17,NAVY,true);email.setMaxLines(2);add(name,email);heading.addView(name,new LinearLayout.LayoutParams(0,-2,1));add(profile,heading);space(profile,14);
        add(profile,text(app.networkAllowed()?"Refresh to see the latest status from your nodes.":"Local only is on. This is your saved sign-in; account updates are paused.",13,MUTED,false));space(profile,12);
        LinearLayout actions=row();Button refresh=button(a.working?"Refreshing…":"Refresh",true,()->{if(app.networkAllowed())a.refresh();else chooseRoute("network");});refresh.setEnabled(!a.working);weighted(actions,refresh);
        weighted(actions,button("Website",false,()->openUrl(NetworkApi.ORIGIN+"/account")));add(profile,actions);space(profile,8);
        add(profile,button("Sign out",false,()->confirm("Sign out of KAI?","Local chat and network chat will lock. Saved conversations remain on this device for this account. "+(app.networkAllowed()?"KAI will also try to revoke this device's session.":"With Local only on, this removes the saved session here. You can revoke it on the website."),"Sign out",()->a.signOut())));
        LinearLayout sections=row();
        String[] values={"nodes","mining","access"}, names={"AI nodes","Mining","Access"};
        for(int i=0;i<values.length;i++){String value=values[i];weighted(sections,button(names[i],accountSection.equals(value),()->{accountSection=value;pageKey="";render();}));}add(content,sections);space(content,18);
        if(accountSection.equals("access")){buildGrants(content);return;}
        int online=0,producers=0;for(int i=0;i<a.nodes.length();i++){JSONObject n=a.nodes.optJSONObject(i);if(n==null)continue;if(n.optBoolean("online"))online++;if(n.optJSONObject("producer")!=null)producers++;}
        LinearLayout summary=card(content);add(summary,text("Your connected nodes",21,NAVY,true));space(summary,10);
        if(a.nodesAt==0)add(summary,text("Refresh your account to load node status.",14,MUTED,false));
        else{detail(summary,"AI nodes online",online+" / "+a.nodes.length());detail(summary,"Mining nodes reported",Integer.toString(producers));space(summary,8);add(summary,text("Snapshot · "+timestamp(a.nodesAt)+(app.networkAllowed()?"":" · updates paused"),12,MUTED,false));}
        if(a.nodesAt>0&&a.nodes.length()==0){add(summary,text("No linked nodes yet. Link your desktop wallet to this account from the desktop app to see it here.",14,MUTED,false));}
        boolean mining=accountSection.equals("mining");
        if(mining&&a.nodesAt>0&&producers==0){LinearLayout empty=card(content);add(empty,text("No mining snapshots yet",19,NAVY,true));space(empty,8);add(empty,text("Your linked desktop nodes report block production here. This handheld monitors those nodes; it does not mine.",14,MUTED,false));}
        for(int i=0;i<a.nodes.length();i++){JSONObject node=a.nodes.optJSONObject(i);if(node!=null&&(!mining||node.optJSONObject("producer")!=null))buildNode(content,node,mining);}
    }
    private void buildGrants(LinearLayout content){
        LinearLayout c=card(content);add(c,text("Network spending",20,NAVY,true));space(c,8);add(c,text("Choose an existing account grant. Create or change grants from your desktop wallet.",13,MUTED,false));space(c,10);
        JSONArray grants=app.account.account.optJSONArray("grants");int live=0;
        if(grants!=null)for(int i=0;i<grants.length();i++){JSONObject g=grants.optJSONObject(i);if(g==null||app.account.grant(g.optString("id"))==null)continue;live++;
            boolean selected=app.grantId.equals(g.optString("id"));
            add(c,text(address(g.optString("address")),14,NAVY,true));detail(c,"Remaining",money(g.optDouble("remainingUsd")));detail(c,"Expires",timestamp(g.optLong("expiresAt")));
            add(c,button(selected?"Selected grant":"Use this grant",!selected,()->{app.grantId=g.optString("id");pageKey="";render();}));space(c,14);
        }
        if(live==0)add(c,text("No active spending grant. Local chat is available after loading a model. To use network chat, authorize a capped grant in the desktop app, then refresh here.",14,MUTED,false));
    }
    private void buildNode(LinearLayout content,JSONObject node,boolean mining){
        LinearLayout c=card(content);
        if(!mining){add(c,text("AI COMPUTE",10,BLUE,true));space(c,6);
        add(c,text(node.optBoolean("online")?(node.optBoolean("busy")?"Working now":"Online & ready"):"Offline",21,NAVY,true));space(c,6);
        TextView address=text(node.optString("address"),12,MUTED,false);address.setTextIsSelectable(true);add(c,address);space(c,12);
        JSONArray models=node.optJSONArray("models");if(models!=null&&models.length()>0){List<String> names=new ArrayList<>();for(int j=0;j<models.length();j++)names.add(models.optString(j));add(c,text(String.join(" · ",names),14,BLUE,true));space(c,8);}else add(c,text("No AI models reported",13,MUTED,false));
        if(!node.isNull("ramGb"))detail(c,"Memory",node.optString("ramGb")+" GB"+(node.optBoolean("accelerated")?" · accelerated":""));
        if(node.optBoolean("online"))detail(c,"Jobs this epoch",node.optString("jobsThisEpoch","0"));
        JSONObject perf=node.optJSONObject("perf");if(perf!=null&&!perf.isNull("srvTokPerSec"))detail(c,"Measured speed",String.format(Locale.US,"%.1f tokens/s",perf.optDouble("srvTokPerSec")));
        if(node.optLong("lastSeenAt")>0)detail(c,"Last seen",timestamp(node.optLong("lastSeenAt")));
        return;}
        JSONObject p=node.optJSONObject("producer");if(p==null)return;
        TextView wallet=text(node.optString("address"),12,MUTED,false);wallet.setTextIsSelectable(true);add(c,wallet);space(c,12);add(c,text("MINING · KOINOS BLOCK PRODUCTION",10,BLUE,true));space(c,8);
        add(c,text(p.optDouble("producingVhp",0)>0?"Reporting block production":"Not producing",18,NAVY,true));
        if(!p.isNull("koinSats"))detail(c,"KOIN",String.format(Locale.US,"%,.4f",p.optDouble("koinSats")/1e8));
        if(!p.isNull("producingVhp"))detail(c,"VHP producing",String.format(Locale.US,"%,.2f",p.optDouble("producingVhp")));
        if(!p.isNull("vhpSats"))detail(c,"VHP in wallet",String.format(Locale.US,"%,.2f",p.optDouble("vhpSats")/1e8));
        if(!p.isNull("sharePct"))detail(c,"Network share",String.format(Locale.US,"%.5f%%",p.optDouble("sharePct")));
        if(!p.isNull("blocksPerDay"))detail(c,"Expected blocks/day",String.format(Locale.US,"%.2f",p.optDouble("blocksPerDay")));
        if(!p.isNull("nodeValueUsd"))detail(c,"Reported node value",money(p.optDouble("nodeValueUsd")));
        if(p.optString("basis").equals("measured")&&!p.isNull("dailyUsd"))detail(c,"Est. daily rewards",money(p.optDouble("dailyUsd")));
        if(p.optBoolean("stakeBehind")){space(c,8);add(c,text("The node reports less producing VHP than the wallet holds. Check the node in your desktop app.",13,0xffa65c15,false));}
        space(c,8);add(c,text("Node snapshot · "+timestamp(p.optString("reportedAt"))+". Expected production is an average, not a guaranteed reward."+(p.optBoolean("priceStale")?" Price data is stale.":""),12,MUTED,false));
    }
    private void spinner(LinearLayout parent,String[] labels,int[] values,int selected,java.util.function.IntConsumer consumer) {
        Spinner spinner=new Spinner(this);ArrayAdapter<String> adapter=new ArrayAdapter<>(this,android.R.layout.simple_spinner_item,labels);adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);spinner.setAdapter(adapter);
        for(int i=0;i<values.length;i++)if(values[i]==selected)spinner.setSelection(i);
        spinner.setMinimumHeight(dp(48));spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> p,View v,int position,long id){consumer.accept(values[position]);}
            public void onNothingSelected(AdapterView<?> p){}
        });add(parent,spinner);
    }
    private void history() {
        if(app.busy){app.fail("Stop the current task before changing conversations.");return;}
        if(!app.account.signedIn())return;
        List<KaiApp.Conversation> visible=app.visibleChats();
        List<String> labels=new ArrayList<>();labels.add("＋ New conversation");for(KaiApp.Conversation c:visible)labels.add(c.title+" · "+(c.route.equals("local")?"Local":c.route.equals("own")?"My node":"Network"));
        new AlertDialog.Builder(this).setTitle("Saved conversations").setItems(labels.toArray(new String[0]),(d,i)->{
            if(i==0)app.newChat();else app.selectChat(visible.get(i-1));
        }).setNeutralButton("Export current",(d,i)->{
            exportText=app.exportChat();Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("text/plain").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"KAI-conversation.txt");startActivityForResult(intent,EXPORT);
        }).setNegativeButton("Delete current",(d,i)->confirm("Delete conversation?","This deletes the conversation from this device.","Delete",()->app.deleteChat(app.current))).setPositiveButton("Close",null).show();
    }
    private void confirm(String title,String message,String action,Runnable work) {new AlertDialog.Builder(this).setTitle(title).setMessage(message).setNegativeButton("Cancel",null).setPositiveButton(action,(d,i)->work.run()).show();}
    private void openUrl(String url) {try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));}catch(ActivityNotFoundException e){app.fail("No browser is available to open this link.");}}
    private void hideKeyboard(){View v=getCurrentFocus();if(v!=null)getSystemService(InputMethodManager.class).hideSoftInputFromWindow(v.getWindowToken(),0);}
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);if(result!=RESULT_OK||data==null||data.getData()==null)return;
        Uri uri=data.getData();
        if(request==IMPORT) {
            try{getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(SecurityException ignored){}
            app.importModel(uri);
        }
        if(request==EXPORT) {
            String saved=exportText;
            app.disk.execute(()->{try(OutputStream out=getContentResolver().openOutputStream(uri)) {
                if(out==null)throw new IOException("Could not open the selected file.");out.write(saved.getBytes(StandardCharsets.UTF_8));
                app.main.post(()->Toast.makeText(this,"Conversation exported",Toast.LENGTH_SHORT).show());
            }catch(Exception e){app.main.post(()->app.fail("Could not export conversation: "+KaiApp.safe(e)));}});
        }
    }
}
