package io.koinosai.mobile;

import java.util.function.Consumer;

/** Explicit engine choice. A failed Azelma request never silently changes the voice. */
final class KaiSpeaker implements VoiceController.Speaker {
    final KaiApp app;VoiceController.Speaker current;boolean pocket,closed;Consumer<Boolean> audible=value->{};
    KaiSpeaker(KaiApp app){this.app=app;}
    @Override public void onAudible(Consumer<Boolean> listener){audible=listener;if(current!=null)current.onAudible(listener);}
    @Override public void say(String text,Runnable done,Consumer<String> error){
        if(closed)return;boolean selected=PocketPack.selected(app);
        if(current==null||selected!=pocket){if(current!=null)current.close();pocket=selected;current=pocket?new PocketSpeaker(app):new AndroidVoice.Speaker(app);current.onAudible(audible);}
        current.say(text,done,error);
    }
    @Override public void stop(){if(current!=null)current.stop();}
    @Override public void close(){closed=true;if(current!=null){current.close();current=null;}}
}
