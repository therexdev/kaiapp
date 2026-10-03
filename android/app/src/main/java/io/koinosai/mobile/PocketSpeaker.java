package io.koinosai.mobile;

import android.content.Context;
import android.media.*;
import android.os.*;
import java.io.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Complete-sentence playback, matching desktop's tone without underruns on slower phones. */
final class PocketSpeaker implements VoiceController.Speaker {
    final KaiApp app;final AudioManager manager;final ExecutorService player=Executors.newSingleThreadExecutor();final Object lock=new Object();
    volatile int epoch;volatile boolean closed;AudioTrack track;AudioFocusRequest focus;int job;Consumer<Boolean> audible=value->{};
    PocketSpeaker(KaiApp app){this.app=app;manager=app.getSystemService(AudioManager.class);}
    @Override public void onAudible(Consumer<Boolean> listener){audible=listener;}
    @Override public void say(String text,Runnable done,Consumer<String> error){
        stop();if(closed)return;int ticket=epoch;
        if(!app.pocketPack.ready()){error.accept("Download KAI's desktop voice in Voice setup, then try again.");return;}
        job=app.pocketClient.request(text,false,tone(app),pitch(app),new PocketClient.Callback(){
            public void ready(ParcelFileDescriptor audio,int frames,int rate,long elapsed){
                if(ticket!=epoch||closed){PocketClient.close(audio);return;}job=0;
                AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
                focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attributes)
                    .setOnAudioFocusChangeListener(change->{if(change<0&&ticket==epoch&&!closed){stop();error.accept("Voice paused because another app needs audio.");}},app.main).build();
                if(manager.requestAudioFocus(focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){PocketClient.close(audio);stop();error.accept("Audio is busy. Try voice again in a moment.");return;}
                player.execute(()->play(audio,frames,rate,attributes,ticket,done,error));
            }
            public void error(String message){if(ticket==epoch&&!closed){job=0;error.accept(message);}}
        });
    }
    static String tone(KaiApp app){String value=app.prefs.getString("pocket.tone","cute");return java.util.Arrays.asList("cute","natural","kai").contains(value)?value:"cute";}
    static int pitch(KaiApp app){return Math.max(5,Math.min(12,app.prefs.getInt("pocket.pitch",9)));}
    void play(ParcelFileDescriptor descriptor,int frames,int rate,AudioAttributes attributes,int ticket,Runnable done,Consumer<String> error){
        AudioTrack output=null;String failure="";
        try(InputStream input=new ParcelFileDescriptor.AutoCloseInputStream(descriptor)){
            synchronized(lock){
                if(ticket!=epoch||closed)return;
                int buffer=Math.max(8192,AudioTrack.getMinBufferSize(rate,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT));
                output=new AudioTrack.Builder().setAudioAttributes(attributes)
                    .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(buffer).build();track=output;
                if(output.getState()!=AudioTrack.STATE_INITIALIZED)throw new IOException("Audio device unavailable");
                output.play();
            }
            app.main.post(()->{if(ticket==epoch&&!closed)audible.accept(true);});
            byte[] buffer=new byte[8192];int n,total=0;
            while(ticket==epoch&&!closed&&(n=input.read(buffer))!=-1){
                int offset=0;while(offset<n&&ticket==epoch&&!closed){int written=output.write(buffer,offset,n-offset,AudioTrack.WRITE_BLOCKING);if(written<=0)throw new IOException("Audio playback interrupted");offset+=written;total+=written;}
            }
            if(ticket!=epoch||closed)return;if(total!=frames*2)throw new IOException("Incomplete speech audio");
            long deadline=SystemClock.elapsedRealtime()+15000;
            while(ticket==epoch&&!closed&&Integer.toUnsignedLong(output.getPlaybackHeadPosition())<frames){
                if(SystemClock.elapsedRealtime()>deadline)throw new IOException("Audio playback stalled");Thread.sleep(20);
            }
        }catch(Exception e){failure="KAI's voice playback stopped. Check media volume or headphones, then try again.";}
        finally{synchronized(lock){if(output!=null){try{output.pause();output.flush();}catch(Exception ignored){}output.release();if(track==output)track=null;}}}
        String message=failure;app.main.post(()->{if(ticket!=epoch||closed)return;abandon();audible.accept(false);if(message.isEmpty())done.run();else error.accept(message);});
    }
    void abandon(){if(focus!=null){manager.abandonAudioFocusRequest(focus);focus=null;}}
    @Override public void stop(){epoch++;app.pocketClient.cancel(job);job=0;synchronized(lock){if(track!=null)try{track.pause();track.flush();}catch(Exception ignored){}}abandon();audible.accept(false);}
    @Override public void close(){closed=true;stop();player.shutdown();}
}
