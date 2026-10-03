package io.koinosai.mobile;

import android.os.ParcelFileDescriptor;
import java.util.function.Consumer;

final class KaiSpeechSetup implements VoiceSetup.Speech {
    final KaiApp app;final VoiceSetup.AndroidSpeech android;PocketSpeaker sample;int epoch,job;
    KaiSpeechSetup(KaiApp app){this.app=app;android=new VoiceSetup.AndroidSpeech(app);}
    @Override public void check(Consumer<VoiceSetup.Result> callback){
        close();int ticket=epoch;
        if(!PocketPack.selected(app)){android.check(callback);return;}
        if(!app.pocketPack.ready()){callback.accept(new VoiceSetup.Result(VoiceSetup.State.MISSING_VOICE,PocketPack.ENGINE,"KAI's desktop Azelma voice needs its one-time download."));return;}
        if(app.pocketChecked){callback.accept(new VoiceSetup.Result(VoiceSetup.State.READY,PocketPack.ENGINE,"Azelma generated valid speech in this app session."));return;}
        job=app.pocketClient.request("Hi, I'm KAI.",true,PocketSpeaker.tone(app),PocketSpeaker.pitch(app),new PocketClient.Callback(){
            public void ready(ParcelFileDescriptor audio,int frames,int rate,long elapsed){
                PocketClient.close(audio);if(ticket!=epoch)return;job=0;app.pocketChecked=true;
                callback.accept(new VoiceSetup.Result(VoiceSetup.State.READY,PocketPack.ENGINE,"Verified Azelma speech: "+frames+" samples at "+rate+" Hz. Check took "+elapsed+" ms."));
            }
            public void error(String message){if(ticket!=epoch)return;job=0;app.pocketChecked=false;callback.accept(new VoiceSetup.Result(VoiceSetup.State.ERROR,PocketPack.ENGINE,message));}
        });
    }
    @Override public void preview(Runnable done,Consumer<String> error){
        if(!PocketPack.selected(app)){android.preview(done,error);return;}
        if(sample!=null)sample.close();sample=new PocketSpeaker(app);sample.say("Hey, I'm KAI. Your little robot friend, ready to help.",done,error);
    }
    @Override public void close(){epoch++;app.pocketClient.cancel(job);job=0;android.close();if(sample!=null){sample.close();sample=null;}}
}
