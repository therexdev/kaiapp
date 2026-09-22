package io.koinosai.mobile;
import java.util.*;
import java.util.function.Consumer;
import org.junit.*;
import static org.junit.Assert.*;

public class VoiceControllerTest {
    static class Mic implements VoiceController.Input {
        int starts,stops;Consumer<String> result;Runnable timeout;
        public void listen(Runnable ready,Consumer<String> partial,Consumer<String> result,Runnable timeout,Consumer<String> error){starts++;this.result=result;this.timeout=timeout;ready.run();}
        public void finish(){result.accept("finished dictation");}public void stop(){stops++;}public void close(){}
    }
    static class Speaker implements VoiceController.Speaker {
        List<String> said=new ArrayList<>();Runnable complete;Consumer<String> error;int stops;
        public void say(String text,Runnable done,Consumer<String> error){said.add(text);complete=done;this.error=error;}
        public void stop(){stops++;}public void close(){}
    }
    static class Host implements VoiceController.Host {
        boolean allowed=true,automatic;String transcript="",error="";
        public boolean allowed(){return allowed;}public void changed(){}public void transcript(String text,boolean automatic){this.transcript=text;this.automatic=automatic;}public void error(String text){error=text;}
    }
    Mic mic;Speaker speaker;Host host;VoiceController voice;
    @Before public void setup(){mic=new Mic();speaker=new Speaker();host=new Host();voice=new VoiceController(mic,speaker,host);}
    @Test public void dictationFinishesWithoutSendingOrSpeaking(){voice.start(false);voice.finishInput();assertEquals("finished dictation",host.transcript);assertFalse(host.automatic);assertFalse(voice.active());assertTrue(speaker.said.isEmpty());}
    @Test public void conversationPausesMicStreamsSentencesAndResumesAfterLastAudio(){
        voice.start(true);mic.result.accept("What is Koinos?");assertTrue(host.automatic);assertFalse(voice.listening);int stops=mic.stops;
        voice.beginReply();assertTrue(mic.stops>stops);voice.updateReply("First sentence. More",false);assertEquals(Arrays.asList("First sentence."),speaker.said);assertEquals(1,mic.starts);
        speaker.complete.run();assertEquals(1,mic.starts);voice.updateReply("First sentence. More details.",true);assertEquals(2,speaker.said.size());assertEquals(1,mic.starts);
        speaker.complete.run();assertEquals(2,mic.starts);assertTrue(voice.listening);
    }
    @Test public void stopDiscardsLateMicrophoneAndSpeechCallbacks(){
        voice.start(true);Consumer<String> late=mic.result;voice.stop();late.accept("Do not submit");assertEquals("",host.transcript);
        voice.start(true);mic.result.accept("Question");voice.beginReply();voice.updateReply("Answer.",true);Runnable done=speaker.complete;int starts=mic.starts;
        voice.stop();done.run();assertEquals(starts,mic.starts);assertFalse(voice.active());
    }
    @Test public void permissionOrForegroundLossStopsFollowup(){voice.start(true);host.allowed=false;mic.result.accept("Hidden app");assertFalse(voice.active());assertEquals("",host.transcript);}
    @Test public void timeoutEndsConversationAndNeverRestartsIt(){voice.start(true);mic.timeout.run();assertFalse(voice.session);assertFalse(voice.active());assertEquals(1,mic.starts);}
    @Test public void speakerFailureEndsVoiceInsteadOfOpeningMic(){voice.start(true);mic.result.accept("Question");voice.beginReply();voice.updateReply("Answer.",true);speaker.error.accept("No offline voice");assertFalse(voice.active());assertEquals(1,mic.starts);assertEquals("No offline voice",host.error);}
    @Test public void readAloudDoesNotEnableAutomaticMicrophone(){voice.beginReply();voice.updateReply("A typed reply.",true);speaker.complete.run();assertEquals(0,mic.starts);assertFalse(voice.active());}
    @Test public void speechTextRemovesLinksAndCitations(){assertEquals("Read source for details.",VoiceController.spoken("Read [source](https://example.com) [1] for **details**."));assertEquals(0,VoiceController.chunkEnd("unfinished",0,false));assertTrue(VoiceController.chunkEnd(String.join("",Collections.nCopies(400,"x")),0,false)<=320);}
}
