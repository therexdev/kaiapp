package io.koinosai.mobile;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

/** Provision the hash-pinned catalog files in externalFiles/pocket-test-models before running. */
@RunWith(AndroidJUnit4.class)
public class PocketDeviceTest {
    @Test public void realAndroidServiceGeneratesPlaysAndStopsAzelma()throws Exception{
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();KaiApp app=(KaiApp)instrumentation.getTargetContext().getApplicationContext();
        MainActivity activity=(MainActivity)instrumentation.startActivitySync(new Intent(app,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        File source=new File(app.getExternalFilesDir(null),"pocket-test-models"),dir=app.pocketPack.directory();dir.mkdirs();
        for(PocketPack.Part part:app.pocketPack.parts){File input=new File(source,part.name);assertTrue("Provision "+input,input.isFile());PocketPack.verify(input,part);Files.copy(input.toPath(),new File(dir,part.name).toPath(),StandardCopyOption.REPLACE_EXISTING);}
        Files.write(new File(dir,".verified").toPath(),PocketPack.REVISION.getBytes(java.nio.charset.StandardCharsets.US_ASCII));assertTrue(app.pocketPack.ready());
        AtomicReference<String> failure=new AtomicReference<>();AtomicInteger samples=new AtomicInteger();CountDownLatch synthesized=new CountDownLatch(1);
        instrumentation.runOnMainSync(()->app.pocketClient.request("Hi, I'm KAI.",false,"cute",9,new PocketClient.Callback(){
            public void ready(ParcelFileDescriptor audio,int frames,int rate,long elapsed){
                try(InputStream input=new ParcelFileDescriptor.AutoCloseInputStream(audio)){
                    ByteArrayOutputStream received=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;
                    while((count=input.read(buffer))!=-1)received.write(buffer,0,count);
                    assertEquals(frames*2,received.size());assertEquals(24000,rate);samples.set(frames);
                }
                catch(Throwable e){failure.set(e.toString());}finally{synthesized.countDown();}
            }
            public void error(String message){failure.set(message);synthesized.countDown();}
        }));
        assertTrue("Native Android synthesis timed out",synthesized.await(130,TimeUnit.SECONDS));assertNull(failure.get());assertTrue(samples.get()>240);
        CountDownLatch played=new CountDownLatch(1);AtomicInteger audible=new AtomicInteger();PocketSpeaker speaker=new PocketSpeaker(app);
        instrumentation.runOnMainSync(()->{speaker.onAudible(value->{if(value)audible.incrementAndGet();});speaker.say("Hi.",played::countDown,message->{failure.set(message);played.countDown();});});
        assertTrue("Android AudioTrack playback timed out",played.await(130,TimeUnit.SECONDS));assertNull(failure.get());assertTrue(audible.get()>0);
        AtomicInteger late=new AtomicInteger();
        instrumentation.runOnMainSync(()->{speaker.say("This reply should stop immediately when you press Stop.",late::incrementAndGet,message->late.incrementAndGet());speaker.stop();speaker.close();app.pocketClient.close();activity.finish();});
        instrumentation.waitForIdleSync();assertEquals(0,late.get());assertFalse(app.pocketClient.bound);
    }
}
