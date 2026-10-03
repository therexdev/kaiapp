package io.koinosai.mobile;

import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.speech.tts.*;
import java.util.*;

/** Shared by setup and playback: only explicitly offline English voices are eligible. */
final class OfflineSpeech {
    interface Engine {
        Set<Voice> voices();
        Voice current();
        Voice defaultVoice();
        int use(Voice voice);
        int language(Locale locale);
    }
    static Engine access(TextToSpeech tts) {
        return new Engine() {
            public Set<Voice> voices(){return tts.getVoices();}
            public Voice current(){return tts.getVoice();}
            public Voice defaultVoice(){return tts.getDefaultVoice();}
            public int use(Voice voice){return tts.setVoice(voice);}
            public int language(Locale locale){return tts.setLanguage(locale);}
        };
    }
    static boolean english(Locale locale) {
        if(locale==null)return false;
        // Some OEM engines expose ISO-639-2 "eng", not Java's usual "en".
        String language=locale.getLanguage().toLowerCase(Locale.ROOT).split("[-_]",2)[0];
        return language.equals("en")||language.equals("eng");
    }
    static boolean offline(Voice voice) {
        return voice!=null&&english(voice.getLocale())&&!voice.isNetworkConnectionRequired()
            &&(voice.getFeatures()==null||!voice.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
    }
    static List<Voice> candidates(Engine engine,String preferred) {
        LinkedHashMap<String,Voice> found=new LinkedHashMap<>();
        try {Voice v=engine.current();if(offline(v))found.put(v.getName(),v);}catch(Exception ignored){}
        try {Voice v=engine.defaultVoice();if(offline(v))found.putIfAbsent(v.getName(),v);}catch(Exception ignored){}
        List<Voice> list=new ArrayList<>();
        try {Set<Voice> values=engine.voices();if(values!=null)for(Voice v:values)if(offline(v))list.add(v);}catch(Exception ignored){}
        list.sort(Comparator.comparingInt(Voice::getQuality).reversed().thenComparing(Voice::getName));
        for(Voice v:list)found.putIfAbsent(v.getName(),v);
        List<Voice> result=new ArrayList<>(found.values());
        if(preferred!=null&&!preferred.isEmpty())result.sort(Comparator.comparingInt(v->v.getName().equals(preferred)?0:1));
        return result;
    }
    static Voice select(Engine engine,String preferred,Set<String> rejected) {
        Set<String> previouslyRejected=new HashSet<>(rejected);
        for(Voice voice:candidates(engine,preferred)){
            if(rejected.contains(voice.getName()))continue;
            try {if(engine.use(voice)==TextToSpeech.SUCCESS)return voice;}catch(Exception ignored){}
            rejected.add(voice.getName());
        }
        // OEM default voices can appear only after a language has been selected.
        for(Locale locale:new Locale[]{Locale.US,Locale.UK,Locale.ENGLISH}) {
            try {
                if(engine.language(locale)<TextToSpeech.LANG_AVAILABLE)continue;
                Voice voice=engine.current();
                if(offline(voice)&&!previouslyRejected.contains(voice.getName())){rejected.remove(voice.getName());return voice;}
            }catch(Exception ignored){}
        }
        return null;
    }
    static String preferredVoice(KaiApp app,String engine) {
        return app.prefs.getString("voice.selected."+engine,"");
    }
    static String requestedEngine(KaiApp app) {return app.prefs.getString("voice.engine","");}
    static TextToSpeech create(KaiApp app,TextToSpeech.OnInitListener listener) {
        String engine=requestedEngine(app);
        return engine.isEmpty()?new TextToSpeech(app,listener):new TextToSpeech(app,listener,engine);
    }
    static String engineName(KaiApp app,TextToSpeech tts) {
        String requested=requestedEngine(app);if(!requested.isEmpty())return requested;
        if(tts!=null)try{String value=tts.getDefaultEngine();if(value!=null&&!value.isEmpty())return value;}catch(Exception ignored){}
        String preferred=android.provider.Settings.Secure.getString(app.getContentResolver(),"tts_default_synth");
        Map<String,String> engines=engines(app);
        return engines.containsKey(preferred)?preferred:engines.keySet().stream().findFirst().orElse("");
    }
    static Map<String,String> engines(KaiApp app) {
        Map<String,String> result=new LinkedHashMap<>();
        for(ResolveInfo info:app.getPackageManager().queryIntentServices(new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE),0)){
            if(info.serviceInfo==null||!info.serviceInfo.enabled)continue;
            CharSequence name=info.loadLabel(app.getPackageManager());
            result.put(info.serviceInfo.packageName,name==null?info.serviceInfo.packageName:name.toString());
        }
        return result;
    }
    static String describe(Engine engine) {
        int all=0,english=0,offline=0;
        try{Set<Voice> voices=engine.voices();if(voices!=null)for(Voice v:voices){if(v==null)continue;all++;if(english(v.getLocale()))english++;if(offline(v))offline++;}}catch(Exception ignored){}
        return "Reported voices: "+all+"; English: "+english+"; installed offline English: "+offline+".";
    }
}
