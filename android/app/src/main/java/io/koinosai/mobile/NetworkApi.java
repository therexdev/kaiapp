package io.koinosai.mobile;

import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

/** Only the existing first-party account and scheduler contracts are reachable. */
class NetworkApi {
    static final String ORIGIN="https://koinosai.com";
    private final Set<HttpsURLConnection> connections=ConcurrentHashMap.newKeySet();
    static final class ApiError extends IOException {
        final int status;
        ApiError(int status,String message){super(message);this.status=status;}
    }
    interface Frames {void frame(JSONObject frame) throws Exception;}
    void cancel(){for(HttpsURLConnection c:connections)c.disconnect();}
    private HttpsURLConnection open(String path,String token,JSONObject body,AtomicBoolean stop) throws Exception {
        if(!Arrays.asList("/auth/device/start","/auth/device/poll","/auth/session","/auth/logout","/account/api/nodes","/scheduler/network/models","/scheduler/consume/chat/completions").contains(path))throw new IOException("Unsupported account operation");
        if(stop.get())throw new IOException("Stopped");
        HttpsURLConnection c=(HttpsURLConnection)new URL(ORIGIN+path).openConnection();
        c.setInstanceFollowRedirects(false);c.setConnectTimeout(20000);c.setReadTimeout(path.endsWith("/chat/completions")?150000:20000);c.setUseCaches(false);
        c.setRequestProperty("Accept","application/json, text/event-stream");c.setRequestProperty("User-Agent","KAI-Mobile/0.3.1");
        if(token!=null&&!token.isEmpty())c.setRequestProperty("Authorization","Bearer "+token);
        connections.add(c);
        try {
            if(stop.get())throw new IOException("Stopped");
            if(body!=null){c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
                byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(bytes.length);
                try(OutputStream out=c.getOutputStream()){out.write(bytes);}}
            return c;
        }catch(Exception e){close(c);throw e;}
    }
    private void close(HttpsURLConnection c){connections.remove(c);c.disconnect();}
    JSONObject json(String path,String token,JSONObject body,AtomicBoolean stop) throws Exception {
        HttpsURLConnection c=open(path,token,body,stop);
        try {int code=c.getResponseCode();String text=read(c,code);JSONObject result;
            try{result=new JSONObject(text);}catch(JSONException e){throw new ApiError(code,"The account service returned an unreadable response. Try again shortly.");}
            if(code<200||code>=300||!result.optBoolean("ok",true))throw new ApiError(code,error(result));
            return result;
        }finally{close(c);}
    }
    void stream(JSONObject body,AtomicBoolean stop,Frames frames) throws Exception {
        HttpsURLConnection c=open("/scheduler/consume/chat/completions",null,body,stop);
        try {
            int code=c.getResponseCode();
            if(code!=200){String text=read(c,code);try{throw new ApiError(code,error(new JSONObject(text)));}catch(JSONException e){throw new ApiError(code,"The network is unavailable ("+code+").");}}
            if(!String.valueOf(c.getContentType()).toLowerCase(Locale.ROOT).startsWith("text/event-stream"))throw new IOException("The network did not return a response stream.");
            try(Reader reader=new InputStreamReader(c.getInputStream(),StandardCharsets.UTF_8)){readEvents(reader,stop,frames);}
        }finally{close(c);}
    }
    private String read(HttpsURLConnection c,int code) throws IOException {
        InputStream in=code>=400?c.getErrorStream():c.getInputStream();if(in==null)return "{}";
        try(InputStream input=in){return new String(ModelFile.readLimited(input,512*1024),StandardCharsets.UTF_8);}
    }
    static String error(JSONObject object){Object e=object.opt("error");String s=e instanceof JSONObject?((JSONObject)e).optString("message","Request failed"):String.valueOf(e==null?"Request failed":e);return s.length()>600?s.substring(0,600):s;}
    /** Bounded SSE parsing: handles arbitrary transport boundaries and multiline data. */
    static void readEvents(Reader input,AtomicBoolean stop,Frames consumer) throws Exception {
        BufferedReader reader=new BufferedReader(input);StringBuilder line=new StringBuilder(),data=new StringBuilder();
        boolean done=false;int count=0,n;
        while(!stop.get()&&(n=reader.read())!=-1){
            if(++count>2*1024*1024)throw new IOException("Network response exceeded the safety limit.");
            if(n=='\r')continue;
            if(n!='\n'){line.append((char)n);if(line.length()>256*1024)throw new IOException("Network frame too large.");continue;}
            if(line.length()==0){
                if(data.length()>0){String value=data.toString().trim();data.setLength(0);
                    if(value.equals("[DONE]")){if(!done)throw new IOException("Network reply ended before completion.");return;}
                    JSONObject frame=new JSONObject(value);if(frame.has("error"))throw new IOException(error(frame));
                    consumer.frame(frame);done|=frame.optBoolean("done");}
            }else if(line.toString().startsWith("data:")){if(data.length()>0)data.append('\n');data.append(line.substring(5).trim());if(data.length()>256*1024)throw new IOException("Network frame too large.");}
            line.setLength(0);
        }
        if(stop.get())throw new IOException("Stopped");
        if(!done)throw new IOException("Connection interrupted before the reply finished. Your partial reply is saved.");
    }
}
