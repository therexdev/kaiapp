package io.koinosai.mobile;

import android.content.*;
import android.os.*;

/** One foreground owner; epochs and descriptor ownership reject late native responses. */
final class PocketClient {
    interface Callback {void ready(ParcelFileDescriptor audio,int frames,int rate,long elapsed);void error(String message);}
    final Context context;final Handler main;Messenger remote;ServiceConnection connection;boolean bound;int epoch,active;Message pending;Callback callback;
    Runnable timeout;final Runnable idle=this::disconnect;
    final Messenger inbox;
    PocketClient(Context context,Handler main){this.context=context;this.main=main;inbox=new Messenger(new Handler(main.getLooper(),message->{received(message);return true;}));}
    int request(String text,boolean check,String tone,int pitch,Callback result){
        if(active!=0)cancel(active);main.removeCallbacks(idle);int id=++epoch;active=id;callback=result;
        Message message=Message.obtain(null,check?PocketVoiceService.CHECK:PocketVoiceService.SAY,id,0);message.replyTo=inbox;
        Bundle data=new Bundle();data.putString("text",text);data.putString("tone",tone);data.putInt("pitch",pitch);message.setData(data);pending=message;
        timeout=()->{if(active==id)fail("KAI's voice took too long on this device. Tap Retry, or choose Android voice in Voice settings.");};main.postDelayed(timeout,120000);
        if(remote!=null)send();else if(!bound){
            ServiceConnection connecting=new ServiceConnection(){
                public void onServiceConnected(ComponentName name,IBinder service){if(connection!=this)return;remote=new Messenger(service);send();}
                public void onServiceDisconnected(ComponentName name){if(connection==this)fail("KAI's voice engine stopped. Tap Retry to reopen it.");}
                public void onBindingDied(ComponentName name){if(connection==this)fail("KAI's voice engine needs to restart. Tap Retry.");}
                public void onNullBinding(ComponentName name){if(connection==this)fail("KAI's voice engine could not start. Tap Retry.");}
            };connection=connecting;
            try{bound=context.bindService(new Intent(context,PocketVoiceService.class),connecting,Context.BIND_AUTO_CREATE);if(!bound)main.post(()->{if(active==id)fail("KAI's voice engine could not open. Tap Retry.");});}
            catch(Exception e){main.post(()->{if(active==id)fail("KAI's voice engine could not open. Tap Retry.");});}
        }
        return id;
    }
    void send(){if(pending==null||remote==null)return;try{remote.send(pending);pending=null;}catch(RemoteException e){fail("KAI's voice engine disconnected. Tap Retry.");}}
    void received(Message message){
        Bundle data=message.getData();data.setClassLoader(ParcelFileDescriptor.class.getClassLoader());
        ParcelFileDescriptor audio=data.getParcelable("audio");
        if(message.arg1!=active||callback==null){close(audio);return;}
        if(message.what!=PocketVoiceService.AUDIO&&message.what!=PocketVoiceService.READY){close(audio);fail("KAI's Azelma voice could not generate speech. Tap Check again, or choose Android voice in Voice settings.");return;}
        int frames=data.getInt("frames"),rate=data.getInt("rate");
        if(rate!=24000||frames<240||frames>24000*120||message.what==PocketVoiceService.AUDIO&&audio==null){close(audio);fail("KAI returned incomplete voice audio. Tap Retry.");return;}
        Callback result=callback;callback=null;active=0;pending=null;main.removeCallbacks(timeout);main.postDelayed(idle,60000);
        result.ready(audio,frames,rate,data.getLong("elapsed"));
    }
    void fail(String message){Callback result=callback;active=0;callback=null;disconnect();if(result!=null)result.error(message);}
    void cancel(int id){if(id!=active||id==0)return;active=0;callback=null;disconnect();}
    void disconnect(){
        main.removeCallbacks(idle);if(timeout!=null)main.removeCallbacks(timeout);pending=null;
        Messenger previous=remote;remote=null;ServiceConnection previousConnection=connection;connection=null;
        if(previous!=null)try{previous.send(Message.obtain(null,PocketVoiceService.RELEASE));}catch(RemoteException ignored){}
        if(bound&&previousConnection!=null)try{context.unbindService(previousConnection);}catch(Exception ignored){}bound=false;
    }
    void close(){epoch++;active=0;callback=null;disconnect();}
    static void close(ParcelFileDescriptor audio){if(audio!=null)try{audio.close();}catch(java.io.IOException ignored){}}
}
