package io.koinosai.mobile;
import android.speech.tts.*;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(manifest=Config.NONE)
public class OfflineSpeechTest {
    static Voice voice(String name,Locale locale,int quality){return new Voice(name,locale,quality,Voice.LATENCY_NORMAL,false,Collections.emptySet());}
    static class Engine implements OfflineSpeech.Engine {
        Set<Voice> reported=new LinkedHashSet<>();Voice current,defaultVoice,fallback;
        Set<String> reject=new HashSet<>(),throwsOn=new HashSet<>();List<String> attempts=new ArrayList<>();boolean enumerationThrows;int languageResult=TextToSpeech.LANG_COUNTRY_AVAILABLE;
        public Set<Voice> voices(){if(enumerationThrows)throw new IllegalStateException();return reported;}
        public Voice current(){return current;}
        public Voice defaultVoice(){return defaultVoice;}
        public int use(Voice v){attempts.add(v.getName());if(throwsOn.contains(v.getName()))throw new IllegalArgumentException();if(reject.contains(v.getName()))return TextToSpeech.ERROR;current=v;return TextToSpeech.SUCCESS;}
        public int language(Locale l){current=fallback;return languageResult;}
    }
    @Test public void englishIncludesIso2AndIso3OemLocales(){
        assertTrue(OfflineSpeech.english(Locale.US));assertTrue(OfflineSpeech.english(new Locale("eng","USA")));
        assertTrue(OfflineSpeech.english(new Locale("eng","GBR")));assertTrue(OfflineSpeech.english(new Locale("en_US")));
        assertFalse(OfflineSpeech.english(Locale.FRENCH));assertFalse(OfflineSpeech.english(null));
    }
    @Test public void rejectedHighestQualityDoesNotHideWorkingVoice(){
        Engine e=new Engine();Voice high=voice("premium",Locale.US,Voice.QUALITY_VERY_HIGH),working=voice("installed",new Locale("eng","USA"),Voice.QUALITY_NORMAL);
        e.reported.add(high);e.reported.add(working);e.reject.add("premium");
        assertSame(working,OfflineSpeech.select(e,"",new HashSet<>()));assertEquals(Arrays.asList("premium","installed"),e.attempts);
    }
    @Test public void currentWorkingVoiceIsPreferredOverUnloadedHighQuality(){
        Engine e=new Engine();e.current=voice("current",new Locale("eng","USA"),Voice.QUALITY_NORMAL);e.reported.add(voice("premium",Locale.US,Voice.QUALITY_VERY_HIGH));
        assertSame(e.current,OfflineSpeech.select(e,"",new HashSet<>()));assertEquals(Collections.singletonList("current"),e.attempts);
    }
    @Test public void verifiedVoiceIsUsedByNextPlaybackSelection(){
        Engine e=new Engine();Voice verified=voice("verified",Locale.UK,Voice.QUALITY_NORMAL);e.reported.add(verified);e.current=voice("other",Locale.US,Voice.QUALITY_VERY_HIGH);
        assertSame(verified,OfflineSpeech.select(e,"verified",new HashSet<>()));
    }
    @Test public void defaultCanWorkWhenOemVoiceEnumerationFails(){
        Engine e=new Engine();e.enumerationThrows=true;e.defaultVoice=voice("default",new Locale("eng","USA"),Voice.QUALITY_NORMAL);
        assertSame(e.defaultVoice,OfflineSpeech.select(e,"",new HashSet<>()));
    }
    @Test public void languageInitializationCanExposePreviouslyHiddenOfflineVoice(){
        Engine e=new Engine();e.fallback=voice("language-default",new Locale("eng","USA"),Voice.QUALITY_NORMAL);
        assertSame(e.fallback,OfflineSpeech.select(e,"",new HashSet<>()));
    }
    @Test public void failedLanguageInitializationIsNotReadiness(){
        Engine e=new Engine();e.fallback=voice("missing",Locale.US,Voice.QUALITY_NORMAL);e.languageResult=TextToSpeech.LANG_MISSING_DATA;
        assertNull(OfflineSpeech.select(e,"",new HashSet<>()));
    }
    @Test public void languageCanActivateVoiceRejectedByDirectSetVoice(){
        Engine e=new Engine();Voice v=voice("legacy-default",new Locale("eng","USA"),Voice.QUALITY_NORMAL);
        e.reported.add(v);e.reject.add(v.getName());e.fallback=v;
        assertSame(v,OfflineSpeech.select(e,"",new HashSet<>()));
    }
    @Test public void networkAndMissingVoicesCannotPassEvenViaDefaultOrLanguageFallback(){
        for(boolean network:new boolean[]{true,false}){
            Engine e=new Engine();Voice blocked=new Voice("blocked",new Locale("eng","USA"),Voice.QUALITY_VERY_HIGH,Voice.LATENCY_NORMAL,network,network?Collections.emptySet():Collections.singleton(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
            e.current=blocked;e.defaultVoice=blocked;e.fallback=blocked;e.reported.add(blocked);
            assertNull(OfflineSpeech.select(e,"blocked",new HashSet<>()));assertTrue(e.attempts.isEmpty());
        }
    }
    @Test public void oemRejectionExceptionFallsThroughToAnotherVoice(){
        Engine e=new Engine();e.reported.add(voice("broken",Locale.US,Voice.QUALITY_VERY_HIGH));Voice working=voice("working",Locale.US,Voice.QUALITY_NORMAL);e.reported.add(working);e.throwsOn.add("broken");
        assertSame(working,OfflineSpeech.select(e,"",new HashSet<>()));
    }
    @Test public void failedSynthesisVoiceIsSkippedOnNextAttempt(){
        Engine e=new Engine();Voice first=voice("first",Locale.US,Voice.QUALITY_VERY_HIGH),second=voice("second",Locale.US,Voice.QUALITY_NORMAL);
        e.reported.add(first);e.reported.add(second);Set<String> failed=new HashSet<>();assertSame(first,OfflineSpeech.select(e,"",failed));failed.add(first.getName());
        assertSame(second,OfflineSpeech.select(e,"",failed));
    }
}
