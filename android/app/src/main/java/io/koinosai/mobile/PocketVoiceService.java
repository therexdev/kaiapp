package io.koinosai.mobile;

import android.app.Service;
import android.content.Intent;
import android.os.*;
import java.io.*;
import java.util.concurrent.*;

/** Non-exported, separately killable CPU engine. No account, chat, tools, or network initialization. */
public final class PocketVoiceService extends Service {
    static final int SAY=1,CHECK=2,RELEASE=3,AUDIO=4,READY=5,ERROR=6;
    final ExecutorService worker=Executors.newSingleThreadExecutor();
    final Handler main=new Handler(Looper.getMainLooper());PocketSynthesis engine;volatile boolean busy;
    final Messenger inbox=new Messenger(new Handler(Looper.getMainLooper(),message->{
        if(message.sendingUid!=android.os.Process.myUid())return true;
        if(message.what==RELEASE){terminate();return true;}
        if(message.what!=SAY&&message.what!=CHECK||message.replyTo==null)return true;
        Bundle args=message.getData();String text=args.getString("text","");String tone=args.getString("tone","cute");int pitch=args.getInt("pitch",9),id=message.arg1;
        if(!valid(text,tone,pitch)||busy){reply(message.replyTo,ERROR,id,null);return true;}
        busy=true;Messenger destination=message.replyTo;boolean check=message.what==CHECK;
        worker.execute(()->synthesize(destination,id,text,tone,pitch,check));return true;
    }));
    static boolean valid(String text,String tone,int pitch){return !text.trim().isEmpty()&&text.length()<=320&&java.util.Arrays.asList("cute","natural","kai").contains(tone)&&pitch>=5&&pitch<=12;}
    @Override public IBinder onBind(Intent intent){return inbox.getBinder();}
    @Override public void onCreate(){super.onCreate();File[] stale=getCacheDir().listFiles((dir,name)->name.startsWith("kai-spoken-")&&name.endsWith(".pcm"));if(stale!=null)for(File file:stale)file.delete();}
    void synthesize(Messenger destination,int id,String text,String tone,int pitch,boolean check){
        File file=null;long start=SystemClock.elapsedRealtime();
        try{
            if(engine==null){
                if(!PocketPack.ready(this))throw new IOException("Voice not installed");
                File dir=PocketPack.directory(this);for(PocketPack.Part part:PocketPack.catalog(this))PocketPack.verify(new File(dir,part.name),part);
                engine=new PocketSynthesis(dir);
            }
            // Unlinked after descriptor hand-off: generated replies are never kept as recordings.
            file=File.createTempFile("kai-spoken-",".pcm",getCacheDir());long[] frames={0};double[] energy={0};
            try(OutputStream out=new BufferedOutputStream(new FileOutputStream(file))){
                engine.generate(text,tone,pitch,pcm->{
                    byte[] bytes=new byte[pcm.length*2];for(int i=0;i<pcm.length;i++){
                        energy[0]+=(double)pcm[i]*pcm[i];int sample=Math.round(Math.max(-1,Math.min(1,pcm[i]))*32767);
                        bytes[i*2]=(byte)sample;bytes[i*2+1]=(byte)(sample>>8);
                    }frames[0]+=pcm.length;out.write(bytes);
                });
            }
            if(frames[0]<240||energy[0]<.0001)throw new IOException("Empty speech");
            Bundle result=new Bundle();result.putInt("frames",(int)frames[0]);result.putInt("rate",24000);result.putLong("elapsed",SystemClock.elapsedRealtime()-start);
            busy=false;
            if(check)reply(destination,READY,id,result);
            else try(ParcelFileDescriptor audio=ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY)){
                result.putParcelable("audio",audio);reply(destination,AUDIO,id,result);
            }
        }catch(Exception|LinkageError e){busy=false;reply(destination,ERROR,id,null);}
        finally{if(file!=null)file.delete();}
    }
    static void reply(Messenger destination,int what,int id,Bundle data){
        try{Message message=Message.obtain(null,what,id,0);if(data!=null)message.setData(data);destination.send(message);}catch(RemoteException ignored){}
    }
    void terminate(){android.os.Process.killProcess(android.os.Process.myPid());}
    @Override public boolean onUnbind(Intent intent){terminate();return false;}
    @Override public void onDestroy(){worker.shutdownNow();super.onDestroy();}
}
