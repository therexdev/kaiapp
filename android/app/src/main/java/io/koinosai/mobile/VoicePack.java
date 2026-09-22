package io.koinosai.mobile;

import android.app.DownloadManager;
import android.database.Cursor;
import android.net.Uri;
import java.io.*;
import java.security.MessageDigest;
import java.util.zip.*;

/** Explicitly downloaded, pinned English offline recognizer. Never stores microphone audio. */
final class VoicePack {
    static final String NAME="vosk-model-small-en-us-0.15";
    static final String URL="https://alphacephei.com/vosk/models/"+NAME+".zip";
    static final long BYTES=41205931;
    static final String SHA256="30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498";
    final KaiApp app;long downloadId,downloaded;boolean installing;String status="";
    VoicePack(KaiApp app){this.app=app;downloadId=app.prefs.getLong("voice.download",-1);}
    File directory(){return new File(app.getNoBackupFilesDir(),NAME);}
    File archive(){return new File(app.getExternalFilesDir(null),NAME+".zip");}
    boolean ready(){return new File(directory(),".verified").isFile()&&new File(directory(),"am/final.mdl").isFile();}
    void download(){
        if(!app.requireAccount())return;if(!app.networkAllowed()){app.fail("Go online to download the voice pack. Recognition works offline after setup.");return;}
        if(ready()||downloadId!=-1||installing)return;
        if(app.getNoBackupFilesDir().getUsableSpace()<160*1024*1024L){app.fail("Free 160 MB to set up offline voice input.");return;}
        try{archive().delete();DownloadManager.Request r=new DownloadManager.Request(Uri.parse(URL)).setTitle("KAI offline voice input · English").setDestinationUri(Uri.fromFile(archive())).setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED).setAllowedOverRoaming(false).setAllowedOverMetered(!app.prefs.getBoolean("wifi",true));
            if(app.prefs.getBoolean("wifi",true))r.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI);
            downloaded=0;downloadId=app.downloads.enqueue(r);app.prefs.edit().putLong("voice.download",downloadId).apply();status="Downloading voice input · 0% of 41 MB";app.changed();
        }catch(Exception e){app.fail("Voice download could not start. Check storage and connection.");}
    }
    void cancel(){if(installing)return;if(downloadId!=-1)app.downloads.remove(downloadId);downloadId=-1;downloaded=0;app.prefs.edit().remove("voice.download").apply();archive().delete();status="";app.changed();}
    void poll(){
        if(downloadId==-1||installing)return;
        try(Cursor c=app.downloads.query(new DownloadManager.Query().setFilterById(downloadId))){
            if(c==null||!c.moveToFirst()){downloadId=-1;app.prefs.edit().remove("voice.download").apply();status="Voice download was removed. Tap Download to retry.";app.changed();return;}
            long bytes=c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));downloaded=Math.max(0,bytes);int state=c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if(bytes>BYTES+1024){cancel();app.fail("Unexpected voice pack size. Download stopped.");return;}
            if(state==DownloadManager.STATUS_FAILED){cancel();status="Voice download failed. Check your connection and retry.";app.changed();return;}
            status=state==DownloadManager.STATUS_PAUSED?"Voice download paused · check Wi-Fi / connection":"Downloading voice input · "+Math.min(100,downloaded*100/BYTES)+"% of 41 MB";
            if(state==DownloadManager.STATUS_SUCCESSFUL){installing=true;status="Verifying and installing voice pack…";app.disk.execute(()->{String error="";try{install(archive(),directory());}catch(Exception e){error="Voice pack could not be installed: "+KaiApp.safe(e);}String result=error;app.main.post(()->{installing=false;cancel();status=result.isEmpty()?"English voice input ready · works offline":result;app.changed();});});}
            app.changed();
        }catch(Exception e){status="Could not check voice download. Try again.";app.changed();}
    }
    static void install(File zip,File destination) throws Exception {
        if(zip.length()!=BYTES)throw new IOException("Incomplete download");MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new FileInputStream(zip)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}
        StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format("%02x",b&255));if(!SHA256.equals(hex.toString()))throw new IOException("Integrity check failed");
        File stage=new File(destination.getParentFile(),NAME+"-installing");remove(stage);if(!stage.mkdirs())throw new IOException("Storage unavailable");
        try{extract(zip,stage);if(!new File(stage,"am/final.mdl").isFile()||!new File(stage,"conf/model.conf").isFile())throw new IOException("Missing speech files");
            try(FileOutputStream out=new FileOutputStream(new File(stage,".verified"))){out.write(SHA256.getBytes(java.nio.charset.StandardCharsets.US_ASCII));}
            remove(destination);if(!stage.renameTo(destination))throw new IOException("Could not save speech files");
        }finally{remove(stage);}
    }
    static void extract(File zip,File stage) throws IOException {
        long total=0;int entries=0;String prefix=stage.getCanonicalPath()+File.separator;
        try(ZipInputStream in=new ZipInputStream(new FileInputStream(zip))){ZipEntry e;byte[] b=new byte[65536];
            while((e=in.getNextEntry())!=null){if(++entries>100)throw new IOException("Too many speech files");String name=e.getName();if(!name.startsWith(NAME+"/")||name.contains("\\"))throw new IOException("Invalid speech archive");
                File target=new File(stage,name.substring(NAME.length()+1));if(!target.getCanonicalPath().equals(stage.getCanonicalPath())&&!target.getCanonicalPath().startsWith(prefix))throw new IOException("Invalid speech path");
                if(e.isDirectory()){target.mkdirs();continue;}File parent=target.getParentFile();if(!parent.isDirectory()&&!parent.mkdirs())throw new IOException("Storage unavailable");
                try(OutputStream out=new FileOutputStream(target)){int n;while((n=in.read(b))!=-1){total+=n;if(total>100*1024*1024L)throw new IOException("Speech archive too large");out.write(b,0,n);}}
            }
        }
    }
    static void remove(File file){File[] children=file.listFiles();if(children!=null)for(File c:children)remove(c);file.delete();}
}
