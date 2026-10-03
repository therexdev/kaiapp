package io.koinosai.mobile;

import java.util.Arrays;

/** Desktop ui/mascot-pocket.js Tone, including continuous WSOLA and resampling phase. */
final class PocketTone {
    final int rate,hop,frame,search;final String tone;final double ratio,tempo,stretch;
    float[] input,output;int count,outAt,read;boolean done;
    PocketTone(int rate,String tone,int pitch){
        this.rate=rate;this.tone=tone;ratio=tone.equals("cute")?Math.pow(2,Math.max(5,Math.min(12,pitch))/12.0):tone.equals("kai")?.9:1;
        tempo=tone.equals("cute")?1.08:ratio;stretch=ratio/tempo;hop=(int)Math.round(rate*.02);frame=hop*2;search=(int)Math.round(rate*.008);
        input=new float[rate];output=new float[rate*2];
    }
    float[] push(float[] samples,boolean last){
        if(done)throw new IllegalStateException("Voice stream has ended");
        if(count+samples.length>rate*120)throw new IllegalArgumentException("Voice audio is too long");
        input=grow(input,count+samples.length+frame);System.arraycopy(samples,0,input,count,samples.length);count+=samples.length;int stable=count;
        if(tone.equals("cute")){
            int end=(int)Math.ceil(count*stretch);output=grow(output,end+frame);
            if(outAt==0&&(count>=frame||last)){System.arraycopy(input,0,output,0,frame);outAt=hop;}
            while(outAt!=0&&outAt<end){
                int expected=(int)Math.round(outAt/stretch);if(!last&&expected+search+frame>count)break;
                int best=Math.min(count-1,expected);double score=Double.NEGATIVE_INFINITY;
                for(int c=Math.max(0,expected-search);c<=Math.min(count-frame,expected+search);c+=4){
                    double dot=0,energy=0;for(int j=0;j<hop;j+=4){double v=input[c+j];dot+=(double)output[outAt+j]*v;energy+=v*v;}
                    double similarity=dot/Math.sqrt(energy+1e-9);if(similarity>score){best=c;score=similarity;}
                }
                for(int j=0;j<frame;j++){double blend=j<hop?.5-.5*Math.cos(Math.PI*j/hop):1;int position=best+j;
                    output[outAt+j]=(float)(output[outAt+j]*(1-blend)+(position>=0&&position<input.length?input[position]:0)*blend);}
                outAt+=hop;
            }
            stable=last?end:Math.max(0,outAt-1);
        }
        float[] source=tone.equals("cute")?output:input;int length=last?(int)Math.ceil(count/tempo):Math.max(read,(int)Math.floor((stable-1)/ratio));
        float[] result=new float[Math.max(0,length-read)];
        for(int i=read;i<length;i++){
            double pos=Math.min(stable-1,i*ratio);int low=Math.max(0,(int)Math.floor(pos)),high=Math.max(0,Math.min(stable-1,low+1));
            double v=source[low]+((double)source[high]-source[low])*(pos-low);
            if(tone.equals("kai"))v*=.9+.1*Math.cos(2*Math.PI*55*i/rate);
            result[i-read]=(float)Math.max(-1,Math.min(1,v));
        }
        read=length;done=last;return result;
    }
    static float[] grow(float[] current,int size){return size>current.length?Arrays.copyOf(current,Math.max(size,current.length*2)):current;}
}
