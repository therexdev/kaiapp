package io.koinosai.mobile;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.*;
import android.os.SystemClock;
import android.view.View;

/** Native, state-driven animation using the original KAI character artwork. */
final class CompanionView extends View {
    final Paint p=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
    final Bitmap mascot;
    Shader background;final Shader visor=new LinearGradient(110,80,400,290,0xff0c1d38,0xff07172c,Shader.TileMode.CLAMP);
    final Path smile=new Path();
    String state="idle";boolean active=true,reduceMotion;
    final long started=SystemClock.uptimeMillis();
    CompanionView(Context context){super(context);mascot=BitmapFactory.decodeResource(getResources(),R.drawable.kai_mascot);smile.moveTo(231,234);smile.quadTo(258,247,285,234);smile.quadTo(258,280,231,234);setContentDescription("Animated KAI companion, ready");setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);}
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);if(w>0&&h>0)background=new RadialGradient(w*.5f,h*.47f,Math.max(w,h)*.68f,new int[]{0xff123959,0xff081626,0xff06111f},null,Shader.TileMode.CLAMP);}
    void state(String value){if(!state.equals(value)){state=value;setContentDescription("KAI · "+value);invalidate();}}
    void active(boolean value){active=value;if(value)invalidate();}
    @Override protected void onDraw(Canvas c){
        super.onDraw(c);float w=getWidth(),h=getHeight();if(w==0||h==0)return;
        boolean animate=active&&!reduceMotion&&ValueAnimator.areAnimatorsEnabled();float t=animate?(SystemClock.uptimeMillis()-started)/1000f:0;
        int glow=state.equals("listening")?0xff35dec2:state.equals("review")?0xffffc571:0xff49bdff;
        p.setShader(background);c.drawRoundRect(0,0,w,h,30,30,p);p.setShader(null);
        p.setColor(0x6677c4ea);for(int i=0;i<26;i++){float x=(i*79+23)%997/997f*w,y=(i*131+47)%991/991f*h;p.setAlpha(50+(int)(35*(1+Math.sin(t*.5+i))));c.drawCircle(x,y,i%3==0?1.6f:1,p);}p.setAlpha(255);
        float ground=h*.86f;
        p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(1.3f);for(int i=0;i<3;i++){p.setColor(glow);p.setAlpha(60-i*14);float rx=w*(.28f+i*.08f);c.drawOval(w/2-rx,ground-12-i*8,w/2+rx,ground+12+i*8,p);}p.setAlpha(255);p.setStyle(Paint.Style.FILL);
        float size=Math.min(h*.83f,w*.9f*mascot.getHeight()/mascot.getWidth()),scale=size/mascot.getHeight();float mw=mascot.getWidth()*scale;
        float bob=animate?(float)Math.sin(t*1.7)*4:0;float left=(w-mw)/2,top=ground-size+bob;
        c.save();c.translate(left,top);c.scale(scale,scale);
        c.drawBitmap(mascot,0,0,p);
        // Visor expressions are vector overlays; all character textures stay local.
        p.setShader(visor);c.drawRoundRect(115,99,409,275,66,66,p);p.setShader(null);
        p.setColor(glow);p.setStrokeCap(Paint.Cap.ROUND);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(12);
        boolean blink=animate&&t%5.4f>5.18f;
        if(blink){c.drawLine(146,193,203,193,p);c.drawLine(307,193,365,193,p);}
        else if(state.equals("thinking")||state.equals("review")){c.drawLine(146,188,200,178,p);c.drawLine(313,178,366,188,p);}
        else if(state.equals("listening")){c.drawOval(149,165,191,208,p);c.drawOval(324,165,366,208,p);}
        else{c.drawArc(144,159,203,240,192,155,false,p);c.drawArc(312,159,371,240,192,155,false,p);}
        p.setStyle(Paint.Style.FILL);
        if(state.equals("speaking")){float mouth=animate?8+12*(float)Math.abs(Math.sin(t*12)):13;c.drawRoundRect(234,235-mouth/2,281,244+mouth/2,14,14,p);}
        else if(state.equals("thinking")){c.drawRoundRect(240,238,278,245,5,5,p);}
        else{c.drawPath(smile,p);}
        c.restore();
        if(state.equals("listening")||state.equals("speaking")){float middle=w/2;for(int i=-12;i<=12;i++){float amp=animate?4+18*(float)Math.abs(Math.sin(t*5+i*.53)):7;p.setColor(glow);p.setAlpha(90+(12-Math.abs(i))*12);c.drawRoundRect(middle+i*7-2,h-24-amp/2,middle+i*7+2,h-24+amp/2,2,2,p);}p.setAlpha(255);}
        if(animate&&isShown())postInvalidateDelayed(33);
    }
}
