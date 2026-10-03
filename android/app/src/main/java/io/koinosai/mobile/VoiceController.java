package io.koinosai.mobile;

import java.util.*;
import java.util.function.Consumer;

/** Foreground, half-duplex voice conversation. Epochs discard callbacks after Stop. */
final class VoiceController {
    interface Input {
        void listen(Runnable ready,Consumer<String> partial,Consumer<String> result,Runnable timeout,Consumer<String> error);
        void finish();void stop();void close();
    }
    interface Speaker {void say(String text,Runnable done,Consumer<String> error);void stop();void close();}
    interface Host {boolean allowed();void transcript(String text,boolean automatic);void changed();void error(String text);}
    final Input input;final Speaker speaker;final Host host;
    boolean session,listening,preparing,waiting,speaking;String status="";int epoch,consumed;boolean replyFinished;
    private final Deque<String> queue=new ArrayDeque<>();
    VoiceController(Input input,Speaker speaker,Host host){this.input=input;this.speaker=speaker;this.host=host;}
    boolean active(){return session||listening||preparing||waiting||speaking;}
    void start(boolean automatic){stop();session=automatic;listen();}
    private void listen(){
        if(!host.allowed()){stop();return;}int token=++epoch;preparing=true;status="Opening offline microphone…";host.changed();
        input.listen(()->{if(!valid(token))return;preparing=false;listening=true;status="Listening · speak now";host.changed();},
            text->{if(valid(token)){status=text.isEmpty()?"Listening · speak now":"Listening · "+WebSearch.limit(text,110);host.changed();}},
            text->{if(!valid(token))return;input.stop();listening=false;preparing=false;++epoch;
                text=text.trim();if(text.isEmpty()){stop();return;}waiting=session;status=session?"Thinking…":"Voice input ready · review and send";host.changed();host.transcript(WebSearch.limit(text,12000),session);},
            ()->{if(valid(token)){stop();status="Voice paused after 60 seconds. Tap the microphone to continue.";host.changed();}},
            message->{if(valid(token))fail(message);});
    }
    boolean valid(int token){if(token!=epoch)return false;if(!host.allowed()){stop();return false;}return true;}
    void finishInput(){if(listening)input.finish();else if(preparing)stop();}
    void beginReply(){input.stop();speaker.stop();++epoch;listening=false;preparing=false;speaking=false;waiting=true;queue.clear();consumed=0;replyFinished=false;status="Thinking…";host.changed();}
    void updateReply(String text,boolean complete){
        if(!waiting&&!speaking)return;
        while(consumed<text.length()){
            int end=chunkEnd(text,consumed,complete);if(end<=consumed)break;
            String part=spoken(text.substring(consumed,end));consumed=end;if(!part.isEmpty())queue.addLast(part);
        }
        replyFinished=complete;pump();
    }
    private void pump(){
        if(speaking)return;
        if(!host.allowed()){stop();return;}
        if(queue.isEmpty()){
            if(replyFinished){waiting=false;if(session)listen();else{status="";host.changed();}}return;
        }
        String next=queue.removeFirst();speaking=true;waiting=true;status="KAI is speaking · microphone paused";host.changed();int token=epoch;
        speaker.say(next,()->{if(!valid(token))return;speaking=false;pump();host.changed();},message->{if(valid(token))fail(message);});
    }
    void fail(String message){stop();host.error(message);}
    void stop(){++epoch;session=false;listening=false;preparing=false;waiting=false;speaking=false;replyFinished=false;queue.clear();consumed=0;status="";input.stop();speaker.stop();host.changed();}
    void close(){stop();input.close();speaker.close();}
    static int chunkEnd(String text,int start,boolean complete){
        int max=Math.min(text.length(),start+320);
        for(int i=start;i<max;i++){char c=text.charAt(i);if((c=='.'||c=='!'||c=='?'||c=='\n')&&(i+1==text.length()?complete:Character.isWhitespace(text.charAt(i+1))))return i+1;}
        if(max-start==320){int space=text.lastIndexOf(' ',max);return space>start?space+1:max;}
        return complete?text.length():start;
    }
    static String spoken(String text){return text.replaceAll("(?s)```.*?```"," Code omitted. ").replaceAll("\\[([^]\\n]+)\\]\\(https?://[^)]+\\)","$1").replaceAll("https?://\\S+","").replaceAll("\\[\\d+\\]","").replaceAll("[*#`_]","").replaceAll("\\s+"," ").trim();}
}
