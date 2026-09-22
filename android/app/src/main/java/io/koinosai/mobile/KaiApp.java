package io.koinosai.mobile;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public final class KaiApp extends Application {
    static final long GB = 1024L * 1024 * 1024;
    static final String SYSTEM = "You are KAI, a helpful local AI companion. Be clear, friendly, and concise. You cannot browse the web or operate apps. Never claim to have performed an action you cannot perform.";
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService inference = Executors.newSingleThreadExecutor();
    final ExecutorService disk = Executors.newSingleThreadExecutor();
    final ExecutorService persistence = Executors.newSingleThreadExecutor();
    final List<Model> models = new ArrayList<>();
    final List<Conversation> chats = new ArrayList<>();
    final AtomicBoolean fileCancelled = new AtomicBoolean();
    final Set<String> verifying = new HashSet<>();
    SharedPreferences prefs;
    DownloadManager downloads;
    Runnable listener;
    Conversation current;
    Model active;
    String status = "Choose a model to get started", error = "", transferStatus = "";
    boolean busy, generating, importing;
    int generatedTokens;
    long generationStarted;
    private long checkpoint;
    private final Runnable downloadPoll = new Runnable() {
        @Override public void run() { pollDownloads(); main.postDelayed(this, 1200); }
    };

    static final class Model {
        String id, name, description, model, filename, url, hash, license, creator, licenseUrl;
        long bytes, downloadId = -1, downloaded;
        int minRam, downloadStatus;
        boolean imported, installed;
        String issue = "";
        Model(JSONObject o) {
            id=o.optString("id"); name=o.optString("name"); description=o.optString("description");
            model=o.optString("model"); filename=o.optString("filename"); url=o.optString("url");
            hash=o.optString("sha256"); bytes=o.optLong("sizeBytes"); minRam=o.optInt("minRamGb",4);
            license=o.optString("license"); creator=o.optString("creator"); licenseUrl=o.optString("licenseUrl"); imported=o.optBoolean("imported");
        }
        JSONObject json() {
            JSONObject o = new JSONObject();
            try { o.put("id",id).put("name",name).put("description",description).put("model",model).put("filename",filename)
                .put("url",url).put("sha256",hash).put("sizeBytes",bytes).put("minRamGb",minRam)
                .put("license",license).put("creator",creator).put("licenseUrl",licenseUrl).put("imported",imported); }
            catch(JSONException ignored) {} return o;
        }
    }
    static final class ChatMessage {
        String role, text; boolean incomplete;
        ChatMessage(String role, String text) { this.role=role; this.text=text; }
        JSONObject json() {
            JSONObject o=new JSONObject(); try { o.put("role",role).put("text",text).put("incomplete",incomplete); }
            catch(JSONException ignored){} return o;
        }
    }
    static final class Conversation {
        String id=UUID.randomUUID().toString(), title="New conversation", modelName="";
        final List<ChatMessage> messages=new ArrayList<>();
        JSONObject json() {
            JSONObject o=new JSONObject(); JSONArray a=new JSONArray();
            for(ChatMessage m:messages) a.put(m.json());
            try { o.put("id",id).put("title",title).put("modelName",modelName).put("messages",a); } catch(JSONException ignored){}
            return o;
        }
    }

    @Override public void onCreate() {
        super.onCreate(); prefs=getSharedPreferences("kai",MODE_PRIVATE); downloads=getSystemService(DownloadManager.class);
        try (InputStream input=getAssets().open("models.json")) {
            JSONArray a=new JSONArray(new String(ModelFile.readLimited(input,256*1024),StandardCharsets.UTF_8));
            for(int i=0;i<a.length();i++) models.add(new Model(a.getJSONObject(i)));
            JSONArray custom=new JSONArray(prefs.getString("imports","[]"));
            for(int i=0;i<custom.length();i++) {
                Model m=new Model(custom.getJSONObject(i));
                if(m.id.matches("import-[a-f0-9-]+") && m.filename.matches("import-[a-f0-9-]+\\.gguf")) models.add(m);
            }
            for(Model m:models) {
                m.downloadId=prefs.getLong("download."+m.id,-1);
                m.installed=prefs.getBoolean("installed."+m.id,false) && file(m).isFile();
            }
        } catch(Exception e) { error="Could not read the model catalog: "+safe(e); }
        loadChats(); if(current==null) newChat();
        if(NativeEngine.unavailable!=null) error=NativeEngine.unavailable;
        main.post(downloadPoll);
    }
    File modelDir() {
        File external=getExternalFilesDir("models");
        File result=external==null ? new File(getFilesDir(),"models") : external;
        if(!result.exists()) result.mkdirs(); return result;
    }
    File file(Model m) { return new File(modelDir(),m.filename); }
    long totalRam() { ActivityManager.MemoryInfo m=new ActivityManager.MemoryInfo(); getSystemService(ActivityManager.class).getMemoryInfo(m); return m.totalMem; }
    long availableRam() { ActivityManager.MemoryInfo m=new ActivityManager.MemoryInfo(); getSystemService(ActivityManager.class).getMemoryInfo(m); return m.availMem; }
    int contextSize() { int n=prefs.getInt("context",2048); return n==1024||n==2048||n==4096?n:2048; }
    int threads() { return Math.max(1,Math.min(8,prefs.getInt("threads",Math.min(4,Runtime.getRuntime().availableProcessors())))); }
    void changed() { if(listener!=null) listener.run(); }
    void fail(String message) { error=message; changed(); }
    void clearError() { error=""; changed(); }
    static String safe(Exception e) { String s=e.getMessage(); return s==null?e.getClass().getSimpleName():s; }
    static String size(long bytes) { return String.format(Locale.US,"%.1f GB",bytes/(double)GB); }

    void download(Model m) {
        if(m.downloadId!=-1 || m.installed || m.imported) return;
        if(file(m).getParentFile().getUsableSpace()<m.bytes+256*1024*1024L) { fail("Free up storage before downloading this model."); return; }
        try {
            if(file(m).exists() && !file(m).delete()) throw new IOException("Could not remove the previous incomplete file.");
            DownloadManager.Request request=new DownloadManager.Request(Uri.parse(m.url));
            request.setTitle(m.name+" for KAI").setDescription("Downloading an offline AI model")
                .setDestinationUri(Uri.fromFile(file(m)))
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverRoaming(false).setAllowedOverMetered(!prefs.getBoolean("wifi",true));
            if(prefs.getBoolean("wifi",true)) request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI);
            m.downloadId=downloads.enqueue(request); m.issue=""; error="";
            prefs.edit().putLong("download."+m.id,m.downloadId).apply(); pollDownloads();
        } catch(Exception e) { fail("Could not start the download: "+safe(e)); }
    }
    void cancelDownload(Model m) {
        if(verifying.contains(m.id)) return;
        if(m.downloadId!=-1) downloads.remove(m.downloadId);
        m.downloadId=-1; m.downloaded=0; m.downloadStatus=0; m.issue="";
        prefs.edit().remove("download."+m.id).apply(); file(m).delete(); changed();
    }
    void pollDownloads() {
        boolean pending=false;
        for(Model m:models) {
            if(m.downloadId==-1 || verifying.contains(m.id)) continue;
            pending=true;
            try(Cursor c=downloads.query(new DownloadManager.Query().setFilterById(m.downloadId))) {
                if(c==null || !c.moveToFirst()) {
                    m.downloadId=-1; prefs.edit().remove("download."+m.id).apply(); m.issue="Download was removed. Try again."; continue;
                }
                m.downloadStatus=c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                m.downloaded=c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                if(m.downloadStatus==DownloadManager.STATUS_SUCCESSFUL) verifyDownload(m);
                if(m.downloadStatus==DownloadManager.STATUS_FAILED) {
                    int reason=c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    m.issue="Download failed ("+reason+"). Check storage and connection, then retry.";
                }
            } catch(Exception e) { m.issue="Could not check the download: "+safe(e); }
        }
        if(pending) changed();
    }
    private void verifyDownload(Model m) {
        verifying.add(m.id); changed();
        disk.execute(()-> {
            String issue="";
            try { ModelFile.verify(file(m),m.bytes,m.hash,()->false); }
            catch(Exception e) { issue=safe(e); }
            String result=issue;
            main.post(()-> {
                verifying.remove(m.id); m.issue=result; m.installed=result.isEmpty();
                // Retain the system download entry; removing it also deletes its destination.
                m.downloadId=-1;
                prefs.edit().remove("download."+m.id).putBoolean("installed."+m.id,m.installed).apply();
                changed();
            });
        });
    }
    void importModel(Uri uri) {
        if(importing || busy) return;
        importing=true; fileCancelled.set(false); transferStatus="Importing model…"; changed();
        String id="import-"+UUID.randomUUID();
        disk.execute(()-> {
            File part=new File(modelDir(),id+".part"), target=new File(modelDir(),id+".gguf");
            try {
                String name="Imported model";
                try(Cursor c=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)) {
                    if(c!=null && c.moveToFirst()) name=c.getString(0);
                }
                long limit=Math.min(8*GB,Math.min(totalRam()-GB,modelDir().getUsableSpace()-256*1024*1024L));
                if(limit<24) throw new IOException("Not enough free storage to import a model.");
                long count;
                try(InputStream input=getContentResolver().openInputStream(uri)) {
                    if(input==null) throw new IOException("Could not open this file.");
                    count=ModelFile.copy(input,part,limit,fileCancelled::get);
                }
                main.post(()-> { transferStatus="Checking imported model…"; changed(); });
                String hash=ModelFile.verify(part,count,null,fileCancelled::get);
                if(fileCancelled.get()) throw new IOException("Stopped.");
                if(!part.renameTo(target)) throw new IOException("Could not save the imported model.");
                JSONObject o=new JSONObject().put("id",id).put("name",name.length()>100?name.substring(0,100):name)
                    .put("description","Imported GGUF · compatibility checked when loaded")
                    .put("model","Custom text model").put("filename",id+".gguf").put("sha256",hash)
                    .put("sizeBytes",count).put("imported",true).put("license","User supplied");
                Model model=new Model(o); model.installed=true;
                main.post(()-> { models.add(model); saveImports(); prefs.edit().putBoolean("installed."+model.id,true).apply(); importing=false; transferStatus=""; changed(); });
            } catch(Exception e) {
                part.delete(); target.delete();
                main.post(()-> { importing=false; transferStatus=""; fail(safe(e)); });
            }
        });
    }
    void saveImports() { JSONArray a=new JSONArray(); for(Model m:models) if(m.imported) a.put(m.json()); prefs.edit().putString("imports",a.toString()).apply(); }
    void deleteModel(Model m) {
        if(busy||active==m||verifying.contains(m.id)) { fail("Unload this model before deleting it."); return; }
        if(m.downloadId!=-1) cancelDownload(m);
        if(file(m).exists() && !file(m).delete()) { fail("The model could not be deleted."); return; }
        m.installed=false; m.issue=""; prefs.edit().remove("installed."+m.id).apply();
        if(m.imported) { models.remove(m); saveImports(); } changed();
    }
    void loadModel(Model m) {
        if(busy||importing) return;
        if(NativeEngine.unavailable!=null) { fail(NativeEngine.unavailable); return; }
        if(!m.installed||!file(m).isFile()) { m.installed=false; fail("Download or import this model first."); return; }
        if(m.bytes+768*1024*1024L>totalRam()-GB) { fail("This model leaves too little memory for Android. Choose a smaller model."); return; }
        busy=true; active=null; error=""; status="Checking "+m.name+"…";
        fileCancelled.set(false); NativeEngine.resetCancel(); changed();
        final int context=contextSize(), cpu=threads();
        inference.execute(()-> {
            try {
                NativeEngine.unload();
                ModelFile.verify(file(m),m.bytes,m.hash,fileCancelled::get);
                if(fileCancelled.get()) throw new IOException("Loading stopped.");
                main.post(()-> { status="Loading "+m.name+"…"; changed(); });
                NativeEngine.load(file(m).getAbsolutePath().getBytes(StandardCharsets.UTF_8),context,cpu);
                if(fileCancelled.get()) { NativeEngine.unload(); throw new IOException("Loading stopped."); }
                main.post(()-> { active=m; busy=false; status=m.name+" is ready · offline"; changed(); });
            } catch(Exception e) {
                NativeEngine.unload();
                main.post(()-> { active=null; busy=false; status="No model loaded"; fail(safe(e)); });
            }
        });
    }
    void unload() {
        if(busy||NativeEngine.unavailable!=null) return;
        busy=true; status="Unloading model…"; changed();
        inference.execute(()-> { NativeEngine.unload(); main.post(()-> {active=null; busy=false; status="Model unloaded · memory released"; changed();}); });
    }
    void stop() { fileCancelled.set(true); if(NativeEngine.unavailable==null) NativeEngine.cancel(); if(busy) status="Stopping…"; changed(); }
    void send(String prompt) {
        prompt=prompt.trim();
        if(busy||prompt.isEmpty()) return;
        if(active==null) { fail("Load a model in Models to start chatting."); return; }
        if(prompt.length()>12000) { fail("Please keep each message below 12,000 characters."); return; }
        if(current.messages.size()>=100) { fail("This conversation is full. Start a new chat; this one stays saved."); return; }
        error="";
        if(current.messages.isEmpty()) current.title=prompt.substring(0,Math.min(44,prompt.length()));
        // An interrupted empty assistant turn is omitted from the next prompt.
        current.messages.add(new ChatMessage("user",prompt)); current.modelName=active.name;
        List<ChatMessage> context=new ArrayList<>();
        String system=prefs.getString("system",SYSTEM);
        if(system.length()>2000) system=system.substring(0,2000);
        context.add(new ChatMessage("system",system));
        for(ChatMessage m:current.messages) if(!m.text.isEmpty()) context.add(m);
        byte[][] roles=new byte[context.size()][],contents=new byte[context.size()][];
        for(int i=0;i<context.size();i++) { roles[i]=context.get(i).role.getBytes(StandardCharsets.UTF_8); contents[i]=context.get(i).text.getBytes(StandardCharsets.UTF_8); }
        ChatMessage answer=new ChatMessage("assistant",""); answer.incomplete=true;
        Conversation conversation=current; conversation.messages.add(answer);
        busy=true; generating=true; generatedTokens=0; generationStarted=SystemClock.elapsedRealtime(); checkpoint=generationStarted;
        status="Reading your message…"; NativeEngine.resetCancel(); saveChats(); changed();
        int max=Math.max(64,Math.min(1024,prefs.getInt("tokens",384)));
        float temperature=Math.max(0,Math.min(2,prefs.getFloat("temperature",0.7f)));
        inference.execute(()-> {
            try {
                int[] result=NativeEngine.generate(roles,contents,max,temperature,(text,tokens,dropped)-> {
                    String decoded=new String(text,StandardCharsets.UTF_8);
                    main.post(()-> {
                        answer.text=decoded; generatedTokens=tokens;
                        status="Writing locally"+(dropped>0?" · older turns left out of context":"")+"…";
                        if(SystemClock.elapsedRealtime()-checkpoint>1500) { saveChats(); checkpoint=SystemClock.elapsedRealtime(); }
                        changed();
                    });
                });
                main.post(()-> {
                    answer.incomplete=result[2]==1||result[3]==1;
                    busy=false; generating=false;
                    double seconds=(SystemClock.elapsedRealtime()-generationStarted)/1000.0;
                    status=String.format(Locale.US,"%s · %d tokens · %.1fs",result[2]==1?"Stopped":result[3]==1?"Reply length reached":"Complete",result[0],seconds);
                    if(result[1]>0) status+=" · older turns excluded";
                    saveChats(); changed();
                });
            } catch(Exception e) {
                main.post(()-> {busy=false; generating=false; status="Reply interrupted"; saveChats(); fail(safe(e));});
            }
        });
    }
    void newChat() {
        if(busy) return;
        if(chats.size()>=30) { fail("You have 30 saved chats. Delete a chat before starting another."); return; }
        current=new Conversation(); chats.add(0,current); saveChats(); changed();
    }
    void selectChat(Conversation c) { if(busy)return; current=c; saveChats(); changed(); }
    void deleteChat(Conversation c) {
        if(busy)return; chats.remove(c);
        if(current==c) current=chats.isEmpty()?null:chats.get(0);
        if(current==null) newChat(); else {saveChats(); changed();}
    }
    String exportChat() {
        StringBuilder s=new StringBuilder("KAI · "+current.title+"\nModel: "+current.modelName+"\n\n");
        for(ChatMessage m:current.messages) s.append(m.role.equals("user")?"You":"KAI").append(m.incomplete?" (partial)":"").append(":\n").append(m.text).append("\n\n");
        return s.toString();
    }
    private void loadChats() {
        File path=new File(getFilesDir(),"chats.json"); if(!path.exists())return;
        try(InputStream in=new AtomicFile(path).openRead()) {
            JSONObject root=new JSONObject(new String(ModelFile.readLimited(in,16*1024*1024),StandardCharsets.UTF_8));
            JSONArray a=root.getJSONArray("chats");
            for(int i=0;i<Math.min(30,a.length());i++) {
                JSONObject o=a.getJSONObject(i); Conversation c=new Conversation();
                c.id=o.getString("id"); c.title=o.getString("title"); c.modelName=o.optString("modelName");
                JSONArray messages=o.getJSONArray("messages");
                for(int n=0;n<Math.min(102,messages.length());n++) {
                    JSONObject m=messages.getJSONObject(n); String role=m.getString("role"), text=m.getString("text");
                    if((!role.equals("user")&&!role.equals("assistant"))||text.length()>64000)continue;
                    ChatMessage msg=new ChatMessage(role,text); msg.incomplete=m.optBoolean("incomplete"); c.messages.add(msg);
                }
                chats.add(c); if(c.id.equals(root.optString("current")))current=c;
            }
            if(current==null&&!chats.isEmpty())current=chats.get(0);
        }catch(Exception e) { error="Saved conversations could not be opened."; }
    }
    void saveChats() {
        JSONArray a=new JSONArray(); for(Conversation c:chats)a.put(c.json());
        JSONObject root=new JSONObject(); try {root.put("chats",a).put("current",current==null?"":current.id);}catch(JSONException ignored){}
        byte[] data=root.toString().getBytes(StandardCharsets.UTF_8);
        persistence.execute(()-> {
            AtomicFile f=new AtomicFile(new File(getFilesDir(),"chats.json")); FileOutputStream out=null;
            try {out=f.startWrite();out.write(data);f.finishWrite(out);}
            catch(Exception e) {if(out!=null)f.failWrite(out); main.post(()->fail("Could not save this conversation. Check free storage."));}
        });
    }
    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if(level>=ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL && level<ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN && !busy && active!=null) unload();
    }
}
