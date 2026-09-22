package io.koinosai.mobile;

import android.content.Context;
import android.media.*;
import android.os.*;
import android.speech.tts.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;


final class AndroidVoice {
    static final class Input implements VoiceController.Input {
        final KaiApp app;final ExecutorService worker=Executors.newSingleThreadExecutor();final Object audioLock=new Object();
        Model model;AudioRecord recorder;volatile int generation;volatile boolean closed,finish;
        Input(KaiApp app){this.app=app;}
        @Override public void listen(Runnable ready,Consumer<String> partial,Consumer<String> result,Runnable timeout,Consumer<String> error){
            stop();if(closed)return;int token=generation;finish=false;
            worker.execute(()->{
                Recognizer recognizer=null;AudioRecord capture=null;
                try{
                    if(model==null)model=new Model(app.voicePack.directory().getAbsolutePath());if(token!=generation||closed)return;
                    recognizer=new Recognizer(model,16000f);
                    int size=Math.max(6400,AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT));
                    synchronized(audioLock){
                        if(token!=generation||closed)return;
                        if(app.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=android.content.pm.PackageManager.PERMISSION_GRANTED)throw new SecurityException("Microphone permission");
                        capture=new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,size);recorder=capture;
                        if(capture.getState()!=AudioRecord.STATE_INITIALIZED)throw new IllegalStateException("Microphone unavailable");capture.startRecording();
                    }
                    if(capture.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IllegalStateException("Microphone busy");
                    app.main.post(()->{if(token==generation&&!closed)ready.run();});
                    short[] pcm=new short[3200];long until=SystemClock.elapsedRealtime()+60000;String previous="",text="";
                    while(token==generation&&!closed&&!finish&&SystemClock.elapsedRealtime()<until){
                        int count=capture.read(pcm,0,pcm.length);if(count<0){if(finish||token!=generation)break;throw new IllegalStateException("Microphone interrupted");}if(count==0)continue;
                        if(recognizer.acceptWaveForm(pcm,count)){text=value(recognizer.getResult(),"text");if(!text.isEmpty())break;}
                        else {String current=value(recognizer.getPartialResult(),"partial");if(!current.equals(previous)){previous=current;app.main.post(()->{if(token==generation&&!closed)partial.accept(current);});}}
                    }
                    if(finish&&text.isEmpty())text=value(recognizer.getFinalResult(),"text");String words=text;
                    app.main.post(()->{if(token!=generation||closed)return;if(!words.isEmpty()||finish)result.accept(words);else timeout.run();});
                }catch(Exception|LinkageError e){app.main.post(()->{if(token==generation&&!closed)error.accept("Offline microphone unavailable. Check its permission and microphone connection, then restart KAI.");});}
                finally{synchronized(audioLock){if(capture!=null){try{capture.stop();}catch(Exception ignored){}capture.release();if(recorder==capture)recorder=null;}}if(recognizer!=null)recognizer.close();}
            });
        }
        static String value(String json,String key){try{return new JSONObject(json).optString(key,"");}catch(Exception e){return "";}}
        @Override public void finish(){finish=true;haltRecording();}
        private void haltRecording(){synchronized(audioLock){if(recorder!=null)try{recorder.stop();}catch(Exception ignored){}}}
        @Override public void stop(){generation++;haltRecording();}
        @Override public void close(){if(closed)return;closed=true;stop();worker.execute(()->{if(model!=null){model.close();model=null;}});worker.shutdown();}
    }
    static final class Speaker implements VoiceController.Speaker {
        final KaiApp app;final AudioManager audio;TextToSpeech tts;boolean ready,closed;int generation;Runnable pending,done;Consumer<String> failure;String utterance="";AudioFocusRequest focus;
        Speaker(KaiApp app){this.app=app;audio=(AudioManager)app.getSystemService(Context.AUDIO_SERVICE);}
        @Override public void say(String text,Runnable complete,Consumer<String> error){
            if(closed)return;int token=++generation;done=complete;failure=error;
            Runnable speak=()->{
                if(token!=generation||closed)return;
                try{android.speech.tts.Voice voice=offlineVoice(tts.getVoices());
                    if(voice==null||tts.setVoice(voice)!=TextToSpeech.SUCCESS){report("Install an English offline voice in Android voice settings to hear KAI.");return;}
                    tts.setSpeechRate(.96f);tts.setPitch(app.prefs.getFloat("voicePitch",1.15f));
                    AudioAttributes attrs=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();tts.setAudioAttributes(attrs);
                    focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).setOnAudioFocusChangeListener(change->{if(change<0)app.main.post(()->{if(token==generation&&!closed)report("Voice paused because another app needs audio.");});},app.main).build();
                    if(audio.requestAudioFocus(focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){report("Audio is busy. Try voice again in a moment.");return;}
                    utterance="kai-"+token;
                    if(tts.speak(text,TextToSpeech.QUEUE_FLUSH,null,utterance)!=TextToSpeech.SUCCESS)report("Android could not play this voice. Check Android voice settings.");
                }catch(Exception e){report("Android voice is unavailable. Check Android voice settings.");}
            };
            if(ready){speak.run();return;}pending=speak;
            if(tts==null)tts=new TextToSpeech(app,status->app.main.post(()->{
                if(closed)return;if(status!=TextToSpeech.SUCCESS){if(tts!=null)tts.shutdown();tts=null;report("Set up an offline text-to-speech engine in Android voice settings.");return;}
                ready=true;tts.setOnUtteranceProgressListener(new UtteranceProgressListener(){
                    public void onStart(String id){}
                    public void onDone(String id){app.main.post(()->{if(id.equals(utterance)&&!closed){abandon();Runnable callback=done;done=null;if(callback!=null)callback.run();}});}
                    public void onError(String id){app.main.post(()->{if(id.equals(utterance)&&!closed)report("Speech playback stopped. Check Android voice settings.");});}
                });Runnable run=pending;pending=null;if(run!=null)run.run();
            }));
        }
        static android.speech.tts.Voice offlineVoice(Set<android.speech.tts.Voice> voices){
            if(voices==null)return null;
            return voices.stream().filter(v->v.getLocale().getLanguage().equals("en")&&!v.isNetworkConnectionRequired()&&(v.getFeatures()==null||!v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)))
                .sorted(Comparator.comparingInt(android.speech.tts.Voice::getQuality).reversed().thenComparing(android.speech.tts.Voice::getName)).findFirst().orElse(null);
        }
        void report(String message){Consumer<String> callback=failure;stop();if(callback!=null)callback.accept(message);}
        void abandon(){if(focus!=null){audio.abandonAudioFocusRequest(focus);focus=null;}}
        @Override public void stop(){generation++;utterance="";done=null;failure=null;pending=null;if(tts!=null)tts.stop();abandon();}
        @Override public void close(){closed=true;stop();if(tts!=null){tts.shutdown();tts=null;}}
    }
}
