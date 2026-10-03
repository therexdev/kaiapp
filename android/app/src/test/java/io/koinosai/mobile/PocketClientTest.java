package io.koinosai.mobile;

import android.os.*;
import java.io.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,application=android.app.Application.class) @LooperMode(LooperMode.Mode.PAUSED)
public class PocketClientTest {
    PocketClient client;int ready,errors;
    PocketClient.Callback callback=new PocketClient.Callback(){
        public void ready(ParcelFileDescriptor audio,int frames,int rate,long elapsed){ready++;PocketClient.close(audio);}
        public void error(String message){errors++;}
    };
    @Before public void start(){
        Messenger service=new Messenger(new Handler(Looper.getMainLooper(),message->true));
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).setComponentNameAndServiceForBindService(new android.content.ComponentName(RuntimeEnvironment.getApplication(),PocketVoiceService.class),service.getBinder());
        client=new PocketClient(RuntimeEnvironment.getApplication(),new Handler(Looper.getMainLooper()));
    }
    @After public void close(){client.close();}
    Message reply(int id,int frames){Message message=Message.obtain(null,PocketVoiceService.READY,id,0);Bundle data=new Bundle();data.putInt("frames",frames);data.putInt("rate",24000);message.setData(data);return message;}
    @Test public void cancelledAndPreviousJobsCannotCompleteNewRequest(){
        int old=client.request("Hi",true,"cute",9,callback);client.cancel(old);client.received(reply(old,1000));assertEquals(0,ready);
        int next=client.request("Hello",true,"cute",9,callback);client.received(reply(old,1000));assertEquals(0,ready);
        client.received(reply(next,1000));assertEquals(1,ready);client.received(reply(next,1000));assertEquals(1,ready);assertEquals(0,errors);
    }
    @Test public void engineFailureDoesNotFallbackAndCanBeRetried(){
        int id=client.request("Hi",true,"cute",9,callback);client.received(Message.obtain(null,PocketVoiceService.ERROR,id,0));assertEquals(1,errors);assertEquals(0,ready);assertFalse(client.bound);
        int retry=client.request("Hi",true,"cute",9,callback);client.received(reply(retry,1000));assertEquals(1,ready);
    }
    @Test public void invalidAudioMetadataFailsInsteadOfBecomingReady(){int id=client.request("Hi",true,"cute",9,callback);client.received(reply(id,0));assertEquals(1,errors);assertEquals(0,ready);}
    @Test public void loadingTimeoutReleasesServiceAndCloseSuppressesCallback(){
        client.request("Hi",true,"cute",9,callback);Shadows.shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(121));assertEquals(1,errors);assertFalse(client.bound);
        client.request("Hi",true,"cute",9,callback);client.close();Shadows.shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(121));assertEquals(1,errors);
    }
    @Test public void idleVoiceReleasesMemoryAfterOneMinute(){int id=client.request("Hi",true,"cute",9,callback);client.received(reply(id,1000));Shadows.shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(61));assertFalse(client.bound);assertEquals(1,ready);}
    @Test public void voiceServiceAcceptsOnlyBoundedLiteralRequests(){
        assertTrue(PocketVoiceService.valid("Hi, I'm KAI.","cute",9));assertFalse(PocketVoiceService.valid("x".repeat(321),"cute",9));
        assertFalse(PocketVoiceService.valid(" ","cute",9));assertFalse(PocketVoiceService.valid("Hi","arbitrary-engine",9));assertFalse(PocketVoiceService.valid("Hi","cute",50));
    }
}
