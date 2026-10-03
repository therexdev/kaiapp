package io.koinosai.mobile;

import java.io.*;
import java.nio.*;
import java.nio.file.*;

/** Runs the production adapter with the matching upstream Linux JNI build; no mocked synthesis. */
public final class PocketNativeSmoke {
    public static void main(String[] args)throws Exception{
        File output=new File(args[1]);output.mkdirs();long start=System.nanoTime();
        try(PocketSynthesis voice=new PocketSynthesis(new File(args[0]))){
            long loaded=System.nanoTime();
            for(String tone:new String[]{"cute","natural","kai"}){
                ByteArrayOutputStream raw=new ByteArrayOutputStream();long before=System.nanoTime();
                voice.generate("Hey, I'm KAI. Your little robot friend, ready to help.",tone,9,samples->{
                    for(float sample:samples){if(!Float.isFinite(sample))throw new IOException("Non-finite sample");int pcm=Math.round(Math.max(-1,Math.min(1,sample))*32767);raw.write(pcm&255);raw.write((pcm>>8)&255);}
                });
                byte[] pcm=raw.toByteArray();if(pcm.length<4800||pcm.length>24000*120*2)throw new AssertionError("Invalid audio length");
                double energy=0;ByteBuffer values=ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);while(values.hasRemaining()){double value=values.getShort()/32768.0;energy+=value*value;}
                if(energy<1)throw new AssertionError("Silent voice");
                ByteBuffer wave=ByteBuffer.allocate(44+pcm.length).order(ByteOrder.LITTLE_ENDIAN);
                wave.put("RIFF".getBytes()).putInt(36+pcm.length).put("WAVEfmt ".getBytes()).putInt(16).putShort((short)1).putShort((short)1).putInt(24000).putInt(48000).putShort((short)2).putShort((short)16).put("data".getBytes()).putInt(pcm.length).put(pcm);
                Files.write(new File(output,"azelma-"+tone+".wav").toPath(),wave.array());
                System.out.printf("PASS %s: %.2f seconds audio; %.2f seconds synthesis; energy %.2f%n",tone,pcm.length/48000.0,(System.nanoTime()-before)/1e9,energy);
            }
            System.out.printf("Native load %.2f seconds%n",(loaded-start)/1e9);
        }
    }
}
