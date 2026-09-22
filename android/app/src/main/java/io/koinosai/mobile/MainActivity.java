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

public final class MainActivity extends Activity {
    private static final int BLUE=0xff155eef, NAVY=0xff14284e, MUTED=0xff61728d, BG=0xfff4f7fd, BORDER=0xffdce5f2, GREEN=0xff168469;
    private static final int IMPORT=10, EXPORT=11;
    private KaiApp app;
    private LinearLayout root, body, errorPanel;
    private TextView status, errorText, modelLabel;
    private EditText composer;
    private Button send;
    private ScrollView chatScroll;
    private String tab="Chat", pageKey="", exportText="";
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
    @Override protected void onStart() { super.onStart(); app.listener=this::render; render(); }
    @Override protected void onStop() {
        app.listener=null;
        if(!isChangingConfigurations() && app.generating) app.stop();
        super.onStop();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("tab",tab); if(composer!=null)state.putString("draft",composer.getText().toString()); super.onSaveInstanceState(state);
    }
    @Override public void onConfigurationChanged(Configuration config) {super.onConfigurationChanged(config);}
    private int dp(float n) {return Math.round(n*getResources().getDisplayMetrics().density);}
    private GradientDrawable bg(int color,int radius) {
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;
    }
    private GradientDrawable outline(int fill,int stroke) {
        GradientDrawable d=bg(fill,12);d.setStroke(dp(1),stroke);return d;
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
        b.setBackground(states);b.setOnClickListener(v->action.run());return b;
    }
    private void weighted(LinearLayout l,View v) {LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);p.setMargins(dp(3),0,dp(3),0);l.addView(v,p);}
    private LinearLayout card(LinearLayout parent) {
        LinearLayout c=column();c.setPadding(dp(18),dp(16),dp(18),dp(16));c.setBackground(outline(Color.WHITE,BORDER));
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(12);parent.addView(c,p);return c;
    }
    private LinearLayout scrollBody() {
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);body.addView(scroll,new LinearLayout.LayoutParams(-1,-1));
        LinearLayout content=column();content.setPadding(dp(18),dp(18),dp(18),dp(10));scroll.addView(content);return content;
    }
    private void buildShell() {
        root=column();root.setBackgroundColor(BG);setContentView(root);
        root.setOnApplyWindowInsetsListener((v,insets)-> {root.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
        LinearLayout heading=row();heading.setPadding(dp(18),dp(10),dp(18),dp(10));
        ImageView icon=new ImageView(this);icon.setImageResource(io.koinosai.mobile.R.drawable.ic_kai);heading.addView(icon,new LinearLayout.LayoutParams(dp(38),dp(38)));
        LinearLayout brand=column();brand.setPadding(dp(12),0,0,0);
        add(brand,text("KAI",22,NAVY,true));add(brand,text("Your AI, on your device",12,MUTED,false));heading.addView(brand,new LinearLayout.LayoutParams(0,-2,1));
        TextView local=text("●  LOCAL",11,GREEN,true);heading.addView(local);add(root,heading);
        status=text(app.status,12,MUTED,false);status.setPadding(dp(18),0,dp(18),dp(10));add(root,status);
        errorPanel=row();errorPanel.setPadding(dp(16),dp(6),dp(10),dp(6));errorPanel.setBackgroundColor(0xffffeded);
        errorText=text("",13,0xff9b2636,false);errorPanel.addView(errorText,new LinearLayout.LayoutParams(0,-2,1));
        Button dismiss=button("Dismiss",false,()->app.clearError());errorPanel.addView(dismiss);add(root,errorPanel);
        body=column();root.addView(body,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout nav=row();nav.setPadding(dp(12),dp(8),dp(12),dp(8));nav.setBackgroundColor(Color.WHITE);
        for(String name:new String[]{"Chat","Models","Settings"}) {
            Button b=button(name,false,()-> {hideKeyboard();tab=name;pageKey="";render();});tabs.add(b);weighted(nav,b);
        }
        add(root,nav);pageKey="";render();
    }
    private String key() {
        if(tab.equals("Chat"))return tab+app.current.id+app.current.messages.size()+app.generating+(app.active==null?"":app.active.id);
        if(tab.equals("Settings"))return tab;
        StringBuilder k=new StringBuilder(tab).append(app.busy).append(app.importing).append(app.transferStatus).append(app.active==null?"":app.active.id);
        for(KaiApp.Model m:app.models)k.append(m.id).append(m.installed).append(m.downloadId).append(m.downloadStatus).append(m.issue).append(app.verifying.contains(m.id));
        return k.toString();
    }
    private void render() {
        status.setText(app.status);errorText.setText(app.error);errorPanel.setVisibility(app.error.isEmpty()?View.GONE:View.VISIBLE);
        for(Button b:tabs) {boolean selected=b.getText().toString().equals(tab);b.setTextColor(selected?BLUE:MUTED);b.setTypeface(Typeface.DEFAULT,selected?Typeface.BOLD:Typeface.NORMAL);}
        String key=key();
        if(!key.equals(pageKey)) {
            if(composer!=null)drafts.put(renderedChatId,composer.getText().toString());
            String draft=drafts.getOrDefault(app.current.id,"");
            body.removeAllViews();composer=null;send=null;modelLabel=null;bubbles.clear();downloadBars.clear();downloadLabels.clear();pageKey=key;
            if(tab.equals("Chat"))buildChat(draft);else if(tab.equals("Models"))buildModels();else buildSettings();
        }
        if(tab.equals("Chat")) {
            if(modelLabel!=null)modelLabel.setText(app.active==null?"No model loaded · choose one in Models":app.active.name+" · runs on this device");
            for(Map.Entry<KaiApp.ChatMessage,TextView> entry:bubbles.entrySet()) {
                String value=entry.getKey().text;
                if(value.isEmpty())value=app.generating?"Thinking…":"No response saved.";
                TextView t=entry.getValue();
                if(!t.getText().toString().equals(value)) {
                    boolean atBottom=chatScroll.getChildAt(0).getHeight()-chatScroll.getHeight()-chatScroll.getScrollY()<dp(100);
                    t.setText(value);if(atBottom)chatScroll.post(()->chatScroll.fullScroll(View.FOCUS_DOWN));
                }
            }
            send.setText(app.busy?"Stop":"Send");send.setEnabled(app.busy||app.active!=null);
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
            LinearLayout welcome=card(messages);add(welcome,text("A little AI.\nA lot of possibility.",28,NAVY,true));space(welcome,12);
            add(welcome,text("Chat, write, and think things through. Your model and conversations stay on this device.",16,MUTED,false));space(welcome,18);
            if(app.active==null)add(welcome,button("Choose a local model",true,()->{tab="Models";pageKey="";render();}));
            else {
                add(welcome,button("Help me plan my day",false,()->app.send("Help me plan my day. Ask me what I need to get done first.")));space(welcome,8);
                add(welcome,button("Explain something simply",false,()->app.send("Ask me what topic I would like you to explain simply.")));
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
            if(app.active==null){app.fail("Load a model first.");return;}
            composer.setText("");hideKeyboard();app.send(prompt);
        });input.addView(send,new LinearLayout.LayoutParams(-2,dp(48)));add(body,input);
        chatScroll.post(()->chatScroll.fullScroll(View.FOCUS_DOWN));
    }
    private void buildModels() {
        LinearLayout content=scrollBody();add(content,text("Your models",28,NAVY,true));space(content,6);
        add(content,text("Download once. Chat offline.",16,MUTED,false));space(content,18);
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
        add(downloads,text("This applies to new downloads. Android manages downloads in the background. Model files are checked before use.\n\nChats stay in this app's storage and are excluded from Android backup. Generation stops when you leave the app. No account is needed.",14,MUTED,false));
        LinearLayout about=card(content);add(about,text("KAI Mobile Preview",19,NAVY,true));space(about,8);
        add(about,text("Version 0.1.0 · Android 9+ · ARM64\nLocal text chat powered by llama.cpp.\n\nThis preview focuses on local models and conversations. Desktop tools, voice, wallet, and network earning are not included.",14,MUTED,false));space(about,12);
        add(about,button("Open-source notices",false,()-> {
            try(InputStream input=getAssets().open("third-party-notices.txt")) {
                new AlertDialog.Builder(this).setTitle("Open-source notices").setMessage(new String(ModelFile.readLimited(input,128*1024),StandardCharsets.UTF_8)).setPositiveButton("Close",null).show();
            } catch(IOException e) {app.fail("Could not open the notices.");}
        }));
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
        List<String> labels=new ArrayList<>();labels.add("＋ New conversation");for(KaiApp.Conversation c:app.chats)labels.add(c.title);
        new AlertDialog.Builder(this).setTitle("Saved conversations").setItems(labels.toArray(new String[0]),(d,i)->{
            if(i==0)app.newChat();else app.selectChat(app.chats.get(i-1));
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
