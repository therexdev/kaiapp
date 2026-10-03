package io.koinosai.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Pinned desktop Azelma files. Only completed, hash-verified files enter private storage. */
final class PocketPack {
    static final String REVISION="e715955cf50d18d919d37231513c0e914b83661a";
    static final long BYTES=199134336;
    static final String ENGINE="kai.azelma";
    static final class Part {
        final String name,url,sha;final long size;
        Part(JSONObject value){name=value.optString("path");url=value.optString("url");sha=value.optString("sha256");size=value.optLong("sizeBytes");
            if(!name.matches("[a-zA-Z0-9_.-]+")||!url.startsWith("https://huggingface.co/")||!sha.matches("[a-f0-9]{64}")||size<=0||size>BYTES)throw new IllegalArgumentException("Invalid voice catalog");}
    }
    final KaiApp app;final List<Part> parts;
    long downloadId=-1,downloaded;boolean active,verifying,mobile;String status="";int index;volatile int epoch;
    PocketPack(KaiApp app){this.app=app;parts=catalog(app);downloadId=app.prefs.getLong("pocket.download",-1);index=app.prefs.getInt("pocket.index",0);mobile=app.prefs.getBoolean("pocket.mobile",false);active=app.prefs.getBoolean("pocket.active",false);
        if(index<0||index>=parts.size()){index=0;cancel();}}
    static boolean selected(Context context){return !context.getSharedPreferences("kai",Context.MODE_PRIVATE).getString("voice.provider","pocket").equals("android");}
    static File directory(Context context){return new File(context.getNoBackupFilesDir(),"kai-azelma-"+REVISION);}
    File directory(){return directory(app);}
    static List<Part> catalog(Context context){
        try(InputStream in=context.getAssets().open("pocket.json")){
            JSONObject json=new JSONObject(new String(ModelFile.readLimited(in,32768),StandardCharsets.UTF_8));
            if(!REVISION.equals(json.getString("revision")))throw new IOException("Voice revision mismatch");
            List<Part> files=new ArrayList<>();JSONArray values=json.getJSONArray("files");long bytes=0;Set<String> names=new HashSet<>();
            for(int i=0;i<values.length();i++){Part part=new Part(values.getJSONObject(i));if(!names.add(part.name))throw new IOException("Duplicate voice file");files.add(part);bytes+=part.size;}
            if(bytes!=BYTES)throw new IOException("Voice size mismatch");return Collections.unmodifiableList(files);
        }catch(Exception e){throw new IllegalStateException("KAI voice catalog could not be read",e);}
    }
    static boolean ready(Context context){return ready(directory(context),catalog(context));}
    boolean ready(){return ready(directory(),parts);}
    static boolean ready(File dir,List<Part> parts){
        try{if(!REVISION.equals(new String(java.nio.file.Files.readAllBytes(new File(dir,".verified").toPath()),StandardCharsets.US_ASCII)))return false;
            for(Part p:parts)if(new File(dir,p.name).length()!=p.size)return false;return true;
        }catch(Exception e){return false;}
    }
    File partial(){return new File(app.getExternalFilesDir(null),"kai-azelma-"+index+".part");}
    void download(boolean allowMobile){
        if(!app.requireAccount())return;if(!app.networkAllowed()){status="Go online to download KAI's voice. It works offline afterward.";app.changed();return;}
        if(ready()||active)return;
        if(directory().getParentFile().getUsableSpace()<450L*1024*1024){status="Free 450 MB on this device, then retry voice setup.";app.changed();return;}
        mobile=allowMobile;active=true;index=0;epoch++;save();enqueue();
    }
    void save(){app.prefs.edit().putLong("pocket.download",downloadId).putInt("pocket.index",index).putBoolean("pocket.active",active).putBoolean("pocket.mobile",mobile).apply();}
    void enqueue(){
        if(!active||verifying)return;
        try{
            if(!directory().isDirectory()&&!directory().mkdirs())throw new IOException("Storage unavailable");
            while(index<parts.size()&&new File(directory(),parts.get(index).name).length()==parts.get(index).size)index++;
            if(index==parts.size()){verifyAll();return;}
            partial().delete();Part p=parts.get(index);
            DownloadManager.Request request=new DownloadManager.Request(Uri.parse(p.url)).setTitle("KAI's desktop voice · "+(index+1)+" / "+parts.size())
                .setDestinationUri(Uri.fromFile(partial())).setAllowedOverRoaming(false).setAllowedOverMetered(mobile)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            if(!mobile)request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI);
            downloadId=app.downloads.enqueue(request);save();status="Downloading KAI's voice…";app.changed();
        }catch(Exception e){failed("KAI's voice download could not start. Check storage and connection, then retry.");}
    }
    void poll(){
        if(!active||verifying)return;
        if(!app.networkAllowed()){cancel();return;}
        if(downloadId==-1){enqueue();return;}
        try(Cursor cursor=app.downloads.query(new DownloadManager.Query().setFilterById(downloadId))){
            if(cursor==null||!cursor.moveToFirst()){failed("Voice download was interrupted. Tap Retry; completed files are kept.");return;}
            Part p=parts.get(index);long bytes=cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            downloaded=Math.max(0,bytes);for(int i=0;i<index;i++)downloaded+=parts.get(i).size;
            if(bytes>p.size){failed("Voice download size did not match. Tap Retry.");return;}
            int state=cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if(state==DownloadManager.STATUS_FAILED){failed("Voice download failed. Check your connection and tap Retry.");return;}
            status=state==DownloadManager.STATUS_PAUSED?"Voice download paused · waiting for Wi-Fi or connection":"Downloading KAI's voice · "+Math.min(100,downloaded*100/BYTES)+"% of 199 MB";
            if(state==DownloadManager.STATUS_SUCCESSFUL){
                verifying=true;int ticket=epoch;File source=partial(),target=new File(directory(),p.name);long id=downloadId;
                app.disk.execute(()->{
                    String error="";
                    try{verify(source,p);copyVerified(source,target,p,()->ticket!=epoch);}catch(Exception e){error="Voice file could not be verified. Tap Retry to download it again.";}
                    String result=error;app.main.post(()->{
                        if(ticket!=epoch)return;verifying=false;app.downloads.remove(id);downloadId=-1;source.delete();
                        if(!result.isEmpty()){target.delete();failed(result);return;}index++;save();enqueue();
                    });
                });
            }
            app.changed();
        }catch(Exception e){failed("Could not check KAI's voice download. Tap Retry.");}
    }
    interface Cancelled {boolean get();}
    static void copyVerified(File source,File target,Part part,Cancelled cancelled)throws Exception{
        File stage=new File(target.getPath()+".installing");
        try(InputStream in=new FileInputStream(source);OutputStream out=new FileOutputStream(stage)){
            byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){if(cancelled.get())throw new IOException("Cancelled");out.write(buffer,0,n);}
        }catch(Exception e){stage.delete();throw e;}
        try{verify(stage,part);if(cancelled.get())throw new IOException("Cancelled");java.nio.file.Files.move(stage.toPath(),target.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);}
        finally{stage.delete();}
    }
    void verifyAll(){
        verifying=true;status="Checking KAI's voice files…";int ticket=epoch;app.changed();
        app.disk.execute(()->{
            String error="";
            try{for(Part p:parts){if(ticket!=epoch)return;try{verify(new File(directory(),p.name),p);}catch(Exception e){new File(directory(),p.name).delete();throw e;}}
                if(ticket!=epoch)return;
                try(OutputStream out=new FileOutputStream(new File(directory(),".verified"))){out.write(REVISION.getBytes(StandardCharsets.US_ASCII));}
            }catch(Exception e){error="A voice file failed its integrity check. Tap Retry; verified files are kept.";}
            String result=error;app.main.post(()->{if(ticket!=epoch)return;verifying=false;active=false;downloadId=-1;index=0;save();status=result.isEmpty()?"Azelma is installed · ready for a voice test":result;app.changed();});
        });
    }
    static void verify(File file,Part part)throws Exception{
        if(file.length()!=part.size)throw new IOException("Incomplete voice file");MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)digest.update(buffer,0,n);}
        StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));
        if(!part.sha.contentEquals(hex))throw new IOException("Voice integrity check failed");
    }
    void failed(String message){cancel();status=message;app.changed();}
    void cancel(){epoch++;active=false;verifying=false;if(downloadId!=-1)app.downloads.remove(downloadId);downloadId=-1;partial().delete();index=0;downloaded=0;save();status="";app.changed();}
}
