package io.koinosai.mobile;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import static org.junit.Assert.*;

public class ModelFileTest {
    @Rule public TemporaryFolder temp=new TemporaryFolder();
    private byte[] gguf() {byte[] b=new byte[1024];b[0]='G';b[1]='G';b[2]='U';b[3]='F';return b;}
    private File model(byte[] bytes) throws Exception {File f=temp.newFile();Files.write(f.toPath(),bytes);return f;}
    @Test public void verifiesExactDownloadAndRejectsCorruption() throws Exception {
        byte[] data=gguf();StringBuilder hash=new StringBuilder();
        for(byte b:MessageDigest.getInstance("SHA-256").digest(data))hash.append(String.format("%02x",b&255));
        File f=model(data);assertEquals(hash.toString(),ModelFile.verify(f,1024,hash.toString(),()->false));
        data[33]=1;Files.write(f.toPath(),data);
        assertThrows(IOException.class,()->ModelFile.verify(f,1024,hash.toString(),()->false));
    }
    @Test public void rejectsTruncatedAndNonModelResponses() throws Exception {
        File f=model(gguf());assertThrows(IOException.class,()->ModelFile.verify(f,2048,null,()->false));
        File html=model("<html>This is a login or CDN error page</html>".getBytes());
        assertThrows(IOException.class,()->ModelFile.verify(html,0,null,()->false));
    }
    @Test public void cancelsVerification() throws Exception {
        File f=model(gguf());assertThrows(IOException.class,()->ModelFile.verify(f,1024,null,()->true));
    }
    @Test public void importLimitAndCancellationRemovePartialFiles() throws Exception {
        File f=temp.newFile();assertThrows(IOException.class,()->ModelFile.copy(new ByteArrayInputStream(gguf()),f,100,()->false));assertFalse(f.exists());
        File cancelled=temp.newFile();assertThrows(IOException.class,()->ModelFile.copy(new ByteArrayInputStream(gguf()),cancelled,2000,()->true));assertFalse(cancelled.exists());
    }
    @Test public void importsExactBytes() throws Exception {
        File f=temp.newFile();assertEquals(1024,ModelFile.copy(new ByteArrayInputStream(gguf()),f,2000,()->false));assertArrayEquals(gguf(),Files.readAllBytes(f.toPath()));
    }
    @Test public void persistedFileReadIsBounded() throws Exception {
        assertThrows(IOException.class,()->ModelFile.readLimited(new ByteArrayInputStream(new byte[1000]),100));
    }
}
