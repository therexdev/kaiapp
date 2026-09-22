package io.koinosai.mobile;

import org.json.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Main-thread state; all transport, encryption and disk work is serialized off the UI. */
final class AccountState {
    static final long SESSION_MS=30L*24*60*60*1000;
    final KaiApp app;
    final ExecutorService worker=Executors.newSingleThreadExecutor();
    final NetworkApi api;
    final SessionVault vault;
    AtomicBoolean cancelled=new AtomicBoolean();
    JSONObject account=new JSONObject();
    JSONArray nodes=new JSONArray(), networkModels=new JSONArray();
    String token="",code="",secret="",notice="",error="";
    long validUntil,codeExpires,nodesAt;
    int epoch,revision;
    boolean working,restoring=true,rejected,foreground;
    private int pollMs=3000;
    AccountState(KaiApp app){this(app,new NetworkApi(),new SessionVault(app));}
    AccountState(KaiApp app,NetworkApi api,SessionVault vault){this.app=app;this.api=api;this.vault=vault;}
    String owner(){return signedIn()?account.optString("id"):"";}
    boolean signedIn(){return !token.isEmpty()&&!account.optString("id").isEmpty()&&!rejected&&System.currentTimeMillis()<validUntil;}
    boolean hasSavedSession(){return !token.isEmpty();}
    void changed(){revision++;app.changed();}
    void restore(){
        int generation=epoch;
        worker.execute(()->{
            JSONObject saved=null;String issue="";
            try{saved=vault.read();}catch(Exception e){issue="Your saved sign-in could not be opened. Please sign in again.";}
            JSONObject result=saved;String message=issue;
            app.main.post(()->{if(generation!=epoch)return;restoring=false;
                if(result!=null){token=result.optString("token");account=result.optJSONObject("account");if(account==null)account=new JSONObject();validUntil=result.optLong("validUntil");rejected=result.optBoolean("rejected");}
                error=message;if(signedIn())app.accountChanged();changed();if(hasSavedSession()&&app.networkAllowed())refresh();});
        });
    }
    private boolean connect(){
        if(!app.networkAllowed()){error="Offline mode is on. Go online to refresh your account; your sign-in stays saved.";changed();return false;}
        if(working)return false;
        working=true;cancelled=new AtomicBoolean();error="";changed();return true;
    }
    private JSONObject session(String value,JSONObject profile,long expires,boolean reject) throws JSONException {
        return new JSONObject().put("token",value).put("account",profile).put("validUntil",expires).put("rejected",reject);
    }
    void start(){
        if(restoring||!connect())return;int generation=epoch;AtomicBoolean stop=cancelled;code="";secret="";
        worker.execute(()->{
            try{JSONObject r=api.json("/auth/device/start",null,new JSONObject(),stop);
                String c=r.getString("userCode"),s=r.getString("deviceSecret");
                if(c.length()>32||s.length()>512||!c.matches("[A-Za-z0-9-]+"))throw new IllegalStateException("Invalid sign-in code");
                long expires=System.currentTimeMillis()+Math.max(30,Math.min(900,r.optInt("expiresInSec",600)))*1000L;
                app.main.post(()->{if(generation!=epoch)return;working=false;code=c;secret=s;codeExpires=expires;pollMs=Math.max(3000,Math.min(15000,r.optInt("pollSec",3)*1000));notice="Approve this code at koinosai.com/link, then return here.";changed();schedulePoll();});
            }catch(Exception e){failure(generation,e);}
        });
    }
    void setForeground(boolean value){foreground=value;if(value)schedulePoll();else app.main.removeCallbacks(poll);}
    private final Runnable poll=this::poll;
    private void schedulePoll(){app.main.removeCallbacks(poll);if(foreground&&!code.isEmpty()&&app.networkAllowed())app.main.postDelayed(poll,pollMs);}
    void poll(){
        if(code.isEmpty())return;
        if(System.currentTimeMillis()>codeExpires){code="";secret="";error="Sign-in code expired. Start again.";changed();return;}
        if(!connect())return;int generation=epoch;AtomicBoolean stop=cancelled;String c=code,s=secret;
        worker.execute(()->{
            try{
                JSONObject body=new JSONObject().put("userCode",c).put("deviceSecret",s);
                JSONObject r=api.json("/auth/device/poll",null,body,stop);
                if(r.optBoolean("pending")){app.main.post(()->{if(generation!=epoch)return;working=false;changed();schedulePoll();});return;}
                String value=r.getString("token");JSONObject profile=r.getJSONObject("account");
                if(value.isEmpty()||value.length()>4096||profile.optString("id").isEmpty())throw new IllegalStateException("Invalid account response");
                long expires=System.currentTimeMillis()+SESSION_MS;
                if(stop.get())throw new java.io.IOException("Stopped");
                vault.write(session(value,profile,expires,false));
                app.main.post(()->{if(generation!=epoch)return;token=value;account=profile;validUntil=expires;rejected=false;code="";secret="";working=false;notice="Signed in securely on this device.";app.accountChanged();changed();refresh();});
            }catch(Exception e){failure(generation,e);}
        });
    }
    void refresh(){
        if(token.isEmpty()||!connect())return;int generation=epoch;AtomicBoolean stop=cancelled;String credential=token;
        worker.execute(()->{
            try{
                JSONObject r=api.json("/auth/session",credential,null,stop);JSONObject profile=r.getJSONObject("account");
                if(profile.optString("id").isEmpty())throw new IllegalStateException("Invalid account response");
                long expires=System.currentTimeMillis()+SESSION_MS;
                if(stop.get())throw new java.io.IOException("Stopped");
                vault.write(session(credential,profile,expires,false));
                JSONArray list=null;String issue="";
                try{list=api.json("/account/api/nodes",credential,null,stop).getJSONArray("nodes");}catch(Exception e){if(e instanceof NetworkApi.ApiError&&((NetworkApi.ApiError)e).status==401)throw e;issue="Account connected. Node status could not be refreshed.";}
                JSONArray catalog=null;
                try{catalog=api.json("/scheduler/network/models",null,null,stop).getJSONArray("models");}catch(Exception ignored){}
                JSONArray result=list, available=catalog;String message=issue;
                app.main.post(()->{if(generation!=epoch)return;account=profile;validUntil=expires;rejected=false;working=false;error=message;
                    if(result!=null){nodes=result;nodesAt=System.currentTimeMillis();}if(available!=null)networkModels=available;notice="Account connected";app.accountChanged();changed();});
            }catch(Exception e){failure(generation,e);}
        });
    }
    private void failure(int generation,Exception e){app.main.post(()->{
        if(generation!=epoch)return;working=false;
        if(e instanceof NetworkApi.ApiError&&((NetworkApi.ApiError)e).status==401){reject();}
        error=e instanceof NetworkApi.ApiError?e.getMessage():"Could not connect. Check your connection and try again.";
        // Failed requests never become successful empty dashboards. Pending sign-in is retried only in foreground.
        if(e instanceof NetworkApi.ApiError&&((NetworkApi.ApiError)e).status>=400&&((NetworkApi.ApiError)e).status<500){code="";secret="";}
        changed();
        if(!code.isEmpty())schedulePoll();
    });}
    void reject(){
        rejected=true;app.stop();app.hideAccountChats();
        String savedToken=token;JSONObject savedProfile=account;long expires=validUntil;
        worker.execute(()->{try{vault.write(session(savedToken,savedProfile,expires,true));}catch(Exception ignored){}});changed();
    }
    void cancelRequests(){epoch++;cancelled.set(true);api.cancel();working=false;code="";secret="";app.main.removeCallbacks(poll);changed();}
    void signOut(){
        String old=token;boolean revoke=app.networkAllowed();cancelRequests();
        token="";account=new JSONObject();nodes=new JSONArray();networkModels=new JSONArray();nodesAt=0;validUntil=0;rejected=false;notice="Signed out on this device";error="";
        app.stop();app.hideAccountChats();app.route="local";app.prefs.edit().putString("route","local").apply();app.networkModel="auto";
        if(app.voicePack!=null)app.voicePack.cancel();
        for(KaiApp.Model m:app.models)if(m.downloadId!=-1&&!app.verifying.contains(m.id))app.cancelDownload(m);changed();
        worker.execute(()->{vault.clear();if(revoke&&!old.isEmpty()){try{api.json("/auth/logout",old,new JSONObject(),new AtomicBoolean());}catch(Exception ignored){}}});
    }
    JSONObject grant(String id){JSONArray list=account.optJSONArray("grants");if(list!=null)for(int i=0;i<list.length();i++){JSONObject g=list.optJSONObject(i);if(g!=null&&g.optString("id").equals(id)&&g.optBoolean("live")&&g.optLong("expiresAt",Long.MAX_VALUE)>System.currentTimeMillis())return g;}return null;}
}
