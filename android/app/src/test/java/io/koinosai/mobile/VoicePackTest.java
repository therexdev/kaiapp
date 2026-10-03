package io.koinosai.mobile;
import java.io.*;
import java.nio.file.*;
import java.util.zip.*;
import org.junit.*;
import static org.junit.Assert.*;
public class VoicePackTest {
    File dir;
    @Before public void setup()throws Exception{dir=Files.createTempDirectory("kai-voice-test").toFile();}
    @After public void close(){VoicePack.remove(dir);}
    File zip(String name)throws Exception{File zip=new File(dir,"pack.zip");try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(zip))){out.putNextEntry(new ZipEntry(name));out.write(new byte[]{1,2,3});out.closeEntry();}return zip;}
    @Test public void archiveCannotEscapeInstallDirectory()throws Exception{File stage=new File(dir,"stage");stage.mkdir();try{VoicePack.extract(zip(VoicePack.NAME+"/../../outside"),stage);fail();}catch(IOException expected){}assertFalse(new File(dir,"outside").exists());}
    @Test public void hashAndSizeAreRequiredBeforeExtraction()throws Exception{File destination=new File(dir,"model");try{VoicePack.install(zip(VoicePack.NAME+"/am/final.mdl"),destination);fail();}catch(IOException expected){}assertFalse(destination.exists());}
    @Test public void sameSizeWrongHashCannotReplaceInstalledPack()throws Exception{
        File archive=new File(dir,"wrong.zip"),destination=new File(dir,"model");destination.mkdir();File sentinel=new File(destination,"keep");sentinel.createNewFile();
        try(RandomAccessFile file=new RandomAccessFile(archive,"rw")){file.setLength(VoicePack.BYTES);}
        try{VoicePack.install(archive,destination);fail();}catch(IOException expected){assertEquals("Integrity check failed",expected.getMessage());}assertTrue(sentinel.exists());
    }
    @Test public void normalArchiveKeepsItsLayout()throws Exception{File stage=new File(dir,"stage");stage.mkdir();VoicePack.extract(zip(VoicePack.NAME+"/conf/model.conf"),stage);assertEquals(3,new File(stage,"conf/model.conf").length());}
}
