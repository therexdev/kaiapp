package io.koinosai.mobile;
import android.speech.tts.*;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(manifest=Config.NONE)
public class AndroidVoiceTest {
    @Test public void spokenRepliesRequireAnInstalledOfflineEnglishVoice(){
        Voice cloud=new Voice("cloud",Locale.US,Voice.QUALITY_VERY_HIGH,Voice.LATENCY_NORMAL,true,Collections.emptySet());
        Voice missing=new Voice("missing",Locale.US,Voice.QUALITY_VERY_HIGH,Voice.LATENCY_NORMAL,false,Collections.singleton(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
        Voice other=new Voice("other",Locale.FRENCH,Voice.QUALITY_HIGH,Voice.LATENCY_NORMAL,false,Collections.emptySet());
        Set<Voice> voices=new HashSet<>(Arrays.asList(cloud,missing,other));assertNull(AndroidVoice.Speaker.offlineVoice(voices));
        Voice local=new Voice("local",Locale.US,Voice.QUALITY_NORMAL,Voice.LATENCY_NORMAL,false,Collections.emptySet());voices.add(local);assertSame(local,AndroidVoice.Speaker.offlineVoice(voices));
    }
}
