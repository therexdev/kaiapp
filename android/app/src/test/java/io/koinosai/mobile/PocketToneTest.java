package io.koinosai.mobile;

import java.io.*;
import java.nio.*;
import java.util.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(manifest=Config.NONE,sdk=28)
public class PocketToneTest {
    @Test public void matchesDesktopAcrossChunkBoundariesAndAllCharacterChoices()throws Exception{
        JSONObject golden;
        try(InputStream in=getClass().getResourceAsStream("/desktop-pocket-tone.json")){golden=new JSONObject(new String(in.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));}
        float[] input=new float[6013];for(int i=0;i<input.length;i++)input[i]=(float)(((i*179%1009)-504)/700.0*(i%701)/701);
        JSONArray fixtures=golden.getJSONArray("fixtures"),chunks=golden.getJSONArray("chunks");
        for(int f=0;f<fixtures.length();f++){
            JSONObject fixture=fixtures.getJSONObject(f);PocketTone processor=new PocketTone(24000,fixture.getString("tone"),fixture.getInt("pitch"));
            FloatBuffer expected=ByteBuffer.wrap(Base64.getDecoder().decode(fixture.getString("pcm"))).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();int offset=0,total=0;
            for(int c=0;c<=chunks.length();c++){
                int length=c==chunks.length()?0:chunks.getInt(c);float[] actual=processor.push(Arrays.copyOfRange(input,offset,offset+length),c==chunks.length());offset+=length;
                for(float value:actual){assertTrue(expected.hasRemaining());assertEquals("Desktop parity "+fixture.getString("tone")+" sample "+total,expected.get(),value,0.000002f);total++;}
            }
            assertFalse(expected.hasRemaining());assertEquals(fixture.getInt("length"),total);
        }
    }
    @Test public void rejectsAudioBeyondBoundAndReuseAfterEnd(){
        PocketTone tone=new PocketTone(24000,"natural",9);tone.push(new float[]{.1f,.2f},true);
        assertThrows(IllegalStateException.class,()->tone.push(new float[0],true));
        assertThrows(IllegalArgumentException.class,()->new PocketTone(24000,"cute",9).push(new float[24000*120+1],false));
    }
    @Test public void emptyNativeChunksDoNotAddSilence(){
        PocketTone tone=new PocketTone(24000,"cute",9);assertEquals(0,tone.push(new float[0],false).length);
        assertEquals(0,tone.push(new float[0],true).length);
    }
}
