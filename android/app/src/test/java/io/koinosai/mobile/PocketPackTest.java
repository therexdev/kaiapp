package io.koinosai.mobile;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,application=android.app.Application.class)
public class PocketPackTest {
    Context context;File directory;
    @Before public void start(){context=RuntimeEnvironment.getApplication();directory=new File(context.getCacheDir(),"voice-integrity");directory.mkdirs();}
    @After public void close(){VoicePack.remove(directory);}
    PocketPack.Part part(byte[] data)throws Exception{
        StringBuilder hash=new StringBuilder();for(byte value:MessageDigest.getInstance("SHA-256").digest(data))hash.append(String.format("%02x",value&255));
        return new PocketPack.Part(new JSONObject().put("path","voice.onnx").put("url","https://huggingface.co/pinned").put("sizeBytes",data.length).put("sha256",hash.toString()));
    }
    @Test public void catalogMatchesDesktopAzelmaPins(){
        List<PocketPack.Part> parts=PocketPack.catalog(context);assertEquals(9,parts.size());assertEquals(PocketPack.BYTES,parts.stream().mapToLong(p->p.size).sum());
        PocketPack.Part voice=parts.stream().filter(p->p.name.equals("azelma.wav")).findFirst().get();assertEquals("60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026",voice.sha);
        assertTrue(parts.stream().filter(p->p.name.endsWith("onnx")).allMatch(p->p.url.contains(PocketPack.REVISION)));
    }
    @Test public void rejectsSameSizeCorruptionAndIncompleteFiles()throws Exception{
        byte[] data={1,2,3,4};PocketPack.Part part=part(data);File file=new File(directory,part.name);java.nio.file.Files.write(file.toPath(),data);PocketPack.verify(file,part);
        java.nio.file.Files.write(file.toPath(),new byte[]{1,2,3,5});assertThrows(IOException.class,()->PocketPack.verify(file,part));
        java.nio.file.Files.write(file.toPath(),new byte[]{1});assertThrows(IOException.class,()->PocketPack.verify(file,part));
    }
    @Test public void cancelledInstallationNeverPublishesPartialModel()throws Exception{
        byte[] bytes={4,5,6};PocketPack.Part part=part(bytes);File source=new File(directory,"source"),target=new File(directory,part.name);java.nio.file.Files.write(source.toPath(),bytes);
        assertThrows(IOException.class,()->PocketPack.copyVerified(source,target,part,()->true));assertFalse(target.exists());assertFalse(new File(target.getPath()+".installing").exists());
        PocketPack.copyVerified(source,target,part,()->false);PocketPack.verify(target,part);
    }
    @Test public void readinessRequiresMarkerAndEveryModelFile()throws Exception{
        PocketPack.Part part=part(new byte[]{1,2,3});assertFalse(PocketPack.ready(directory,List.of(part)));
        java.nio.file.Files.write(new File(directory,".verified").toPath(),PocketPack.REVISION.getBytes(StandardCharsets.US_ASCII));assertFalse(PocketPack.ready(directory,List.of(part)));
        java.nio.file.Files.write(new File(directory,part.name).toPath(),new byte[]{1,2,3});assertTrue(PocketPack.ready(directory,List.of(part)));
        java.nio.file.Files.write(new File(directory,".verified").toPath(),"old".getBytes(StandardCharsets.US_ASCII));assertFalse(PocketPack.ready(directory,List.of(part)));
    }
    @Test public void desktopVoiceIsDefaultAndAndroidChoicePersists(){
        assertTrue(PocketPack.selected(context));context.getSharedPreferences("kai",0).edit().putString("voice.provider","android").apply();assertFalse(PocketPack.selected(context));
    }
    @Test public void catalogRejectsPathsAndUnpinnedTransport()throws Exception{
        JSONObject bad=new JSONObject().put("path","../voice").put("url","http://example.com").put("sizeBytes",1).put("sha256","0".repeat(64));
        assertThrows(IllegalArgumentException.class,()->new PocketPack.Part(bad));
    }
}
