package io.koinosai.mobile;

import com.k2fsa.sherpa.onnx.*;
import java.io.*;
import java.util.*;

/** Literal-text-only native adapter; instantiated only in the private voice process. */
final class PocketSynthesis implements AutoCloseable {
    final OfflineTts engine;final WaveData reference;
    PocketSynthesis(File dir){
        OfflineTtsPocketModelConfig pocket=new OfflineTtsPocketModelConfig();
        pocket.setLmFlow(file(dir,"lm_flow.int8.onnx"));pocket.setLmMain(file(dir,"lm_main.int8.onnx"));
        pocket.setEncoder(file(dir,"encoder.onnx"));pocket.setDecoder(file(dir,"decoder.int8.onnx"));
        pocket.setTextConditioner(file(dir,"text_conditioner.onnx"));pocket.setVocabJson(file(dir,"vocab.json"));
        pocket.setTokenScoresJson(file(dir,"token_scores.json"));pocket.setVoiceEmbeddingCacheCapacity(1);
        OfflineTtsModelConfig model=new OfflineTtsModelConfig();model.setPocket(pocket);model.setNumThreads(2);model.setProvider("cpu");model.setDebug(false);
        OfflineTtsConfig config=new OfflineTtsConfig();config.setModel(model);config.setMaxNumSentences(1);
        engine=new OfflineTts(null,config);
        reference=WaveReader.Companion.readWave(file(dir,"azelma.wav"));
        if(engine.sampleRate()!=24000||reference.getSamples().length==0)throw new IllegalStateException("Invalid Azelma audio");
    }
    static String file(File dir,String name){return new File(dir,name).getAbsolutePath();}
    interface Sink {void accept(float[] samples)throws IOException;}
    void generate(String text,String tone,int pitch,Sink sink)throws IOException{
        GenerationConfig config=new GenerationConfig();config.setSpeed(1f);config.setReferenceAudio(reference.getSamples());config.setReferenceSampleRate(reference.getSampleRate());config.setNumSteps(5);
        Map<String,String> extra=new HashMap<>();extra.put("max_reference_audio_len","10");extra.put("seed","42");extra.put("chunk_size","3");config.setExtra(extra);
        PocketTone effect=new PocketTone(24000,tone,pitch);IOException[] failure={null};int[] samples={0};
        // JNI looks up invoke(float[]): Integer explicitly. A Java lambda only
        // exposes erased invoke(Object), so use a typed implementation here.
        engine.generateWithConfigAndCallback(text,config,new kotlin.jvm.functions.Function1<float[],Integer>(){public Integer invoke(float[] pcm){
            try{samples[0]+=pcm.length;if(samples[0]>24000*120)throw new IOException("Speech exceeded its limit");
                for(float value:pcm)if(!Float.isFinite(value))throw new IOException("Invalid speech sample");
                sink.accept(effect.push(pcm,false));return 1;
            }catch(IOException|RuntimeException e){failure[0]=new IOException("Speech generation stopped",e);return 0;}
        }});
        if(failure[0]!=null)throw failure[0];if(samples[0]<240)throw new IOException("The voice returned no audio");
        sink.accept(effect.push(new float[0],true));
    }
    @Override public void close(){engine.release();}
}
