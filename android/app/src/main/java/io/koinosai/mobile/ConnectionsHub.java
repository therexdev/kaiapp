package io.koinosai.mobile;

import org.json.*;
import java.io.IOException;
import java.net.URI;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Same first-party, account-scoped managed Connections contract as desktop. */
final class ConnectionsHub {
    final KaiApp app;
    final ExecutorService worker=Executors.newSingleThreadExecutor();
    final NetworkApi api;
    AtomicBoolean stopped=new AtomicBoolean();
    JSONArray accounts=new JSONArray(),catalog=new JSONArray(),tools=new JSONArray();
    String owner="",generation="",error="",notice="",selectedAccount="",cursor="",query="",toolsCursor="",toolQuery="";
    boolean working,available;int epoch,revision;long refreshedAt;
    ConnectionsHub(KaiApp app){this(app,new NetworkApi());}
    ConnectionsHub(KaiApp app,NetworkApi api){this.app=app;this.api=api;}
    void changed(){revision++;app.changed();}
    void reset(){cancel();owner="";generation="";accounts=new JSONArray();catalog=new JSONArray();tools=new JSONArray();selectedAccount="";available=false;error="";notice="";refreshedAt=0;}
    void cancel(){epoch++;stopped.set(true);api.cancel();working=false;}
    interface Work {Object run(String token,AtomicBoolean stop) throws Exception;}
    void request(Work work,Consumer<Object> done){
        if(!app.account.signedIn()){error="Sign in to your KAI account first.";changed();return;}
        if(!app.networkAllowed()){error="Go online to use connected apps. Your local model can stay selected.";changed();return;}
        if(working||app.agent!=null&&app.agent.running){error="Wait for the current task, or stop it first.";changed();return;}
        String who=app.account.owner(),token=app.account.token;if(!owner.equals(who)){reset();owner=who;}
        int ticket=++epoch;AtomicBoolean stop=new AtomicBoolean();stopped=stop;working=true;error="";changed();
        worker.execute(()->{try{Object result=work.run(token,stop);app.main.post(()->{
            if(!valid(ticket,who,token,stop))return;working=false;done.accept(result);changed();
        });}catch(Exception e){app.main.post(()->{if(!valid(ticket,who,token,stop))return;working=false;error=KaiApp.safe(e);changed();});}});
    }
    boolean valid(int ticket,String who,String token,AtomicBoolean stop){return ticket==epoch&&!stop.get()&&app.networkAllowed()&&who.equals(app.account.owner())&&token.equals(app.account.token);}
    Object call(String action,JSONObject input,String token,String project,AtomicBoolean stop)throws Exception{
        JSONObject body=new JSONObject(input.toString()).put("generation",project);
        JSONObject result=api.json("/connections/api/"+action,token,body,stop);
        if(stop.get())throw new IOException("Stopped");
        return result.get("result");
    }
    void refresh(){request((token,stop)->{
        JSONObject status=api.json("/connections/status",null,null,stop);
        if(!status.optBoolean("available")||status.optInt("protocol")!=1)throw new IOException("KAI Connections is unavailable. Try again later.");
        String project=status.getString("generation");JSONObject data=(JSONObject)call("accounts",new JSONObject(),token,project,stop);
        return new JSONObject().put("generation",project).put("accounts",data.getJSONArray("accounts"));
    },result->{JSONObject data=(JSONObject)result;generation=data.optString("generation");accounts=data.optJSONArray("accounts");available=true;refreshedAt=System.currentTimeMillis();notice="Connections refreshed";});}
    void browse(String search,boolean more){
        if(!available){error="Refresh your connections first.";changed();return;}
        String next=more?cursor:"";request((token,stop)->call("catalog",new JSONObject().put("search",search).put("cursor",next),token,generation,stop),result->{
            JSONObject page=(JSONObject)result;catalog=more?append(catalog,page.optJSONArray("items")):page.optJSONArray("items");if(catalog==null)catalog=new JSONArray();cursor=page.optString("nextCursor","");if(cursor.equals("null"))cursor="";query=search;
        });
    }
    void connect(String slug,Consumer<String> open){request((token,stop)->{
        Object data=call("connect",new JSONObject().put("slug",slug),token,generation,stop);
        return connectURL(((JSONObject)data).getString("url"));
    },result->{notice="Complete sign-in in your browser, then tap Refresh.";open.accept((String)result);});}
    static String connectURL(String raw)throws Exception{
        URI u=new URI(raw);if(!"https".equals(u.getScheme())||u.getRawUserInfo()!=null||u.getPort()!=-1||!Arrays.asList("connect.composio.dev","backend.composio.dev").contains(u.getHost()))throw new IOException("Unsupported sign-in link. Refresh and try again.");return raw;
    }
    JSONObject account(String id){for(int i=0;i<accounts.length();i++){JSONObject a=accounts.optJSONObject(i);if(a!=null&&id.equals(a.optString("id")))return a;}return null;}
    void loadTools(String id,String search,boolean more){JSONObject account=account(id);if(account==null)return;String next=more?toolsCursor:"";
        request((token,stop)->call("tools",new JSONObject().put("toolkit",account.getString("toolkit")).put("search",search).put("cursor",next),token,generation,stop),result->{
            JSONObject page=(JSONObject)result;tools=more?append(tools,page.optJSONArray("items")):page.optJSONArray("items");if(tools==null)tools=new JSONArray();selectedAccount=id;toolsCursor=page.optString("nextCursor","");if(toolsCursor.equals("null"))toolsCursor="";toolQuery=search;
        });
    }
    String policyKey(){return "connections."+owner+"."+generation;}
    JSONObject policies(){try{return new JSONObject(app.prefs.getString(policyKey(),"{}"));}catch(Exception e){return new JSONObject();}}
    boolean enabled(String accountId,String toolId){JSONObject p=policies().optJSONObject(accountId);return p!=null&&p.has(toolId);}
    void allow(String accountId,JSONObject tool,boolean enable){
        if(app.agent!=null&&app.agent.running){error="Stop the task before changing access.";changed();return;}
        try{JSONObject root=policies(),p=root.optJSONObject(accountId);if(p==null)p=new JSONObject();
            if(enable){if(p.length()>=16&&!p.has(tool.getString("id")))throw new IOException("Choose up to 16 actions per account.");p.put(tool.getString("id"),new JSONObject(tool.toString()));}else p.remove(tool.getString("id"));
            root.put(accountId,p);app.prefs.edit().putString(policyKey(),root.toString()).apply();error="";changed();
        }catch(Exception e){error=KaiApp.safe(e);changed();}
    }
    List<JSONObject> selected(){List<JSONObject> list=new ArrayList<>();JSONObject all=policies();
        if(!owner.equals(app.account.owner()))return list;
        for(int i=0;i<accounts.length();i++){JSONObject a=accounts.optJSONObject(i);if(a==null||!"ACTIVE".equals(a.optString("status"))||a.optBoolean("disabled"))continue;
            JSONObject p=all.optJSONObject(a.optString("id"));if(p==null)continue;
            for(Iterator<String> keys=p.keys();keys.hasNext();){JSONObject t=p.optJSONObject(keys.next());if(t==null)continue;try{JSONObject ref=new JSONObject(t.toString()).put("accountId",a.getString("id")).put("accountName",a.optString("name",a.optString("toolkit")));list.add(ref);}catch(JSONException ignored){}}
        }return list;
    }
    static JSONArray append(JSONArray left,JSONArray right){JSONArray result=new JSONArray();Set<String> seen=new HashSet<>();for(JSONArray arr:new JSONArray[]{left,right})if(arr!=null)for(int i=0;i<arr.length()&&result.length()<240;i++){JSONObject o=arr.optJSONObject(i);if(o!=null&&seen.add(o.optString("id",o.optString("slug"))))result.put(o);}return result;}
    static JSONObject validateArgs(JSONObject values,JSONObject schema)throws Exception{
        if(values.toString().length()>16000)throw new IOException("Action inputs exceed 16 KB.");
        JSONObject props=schema.optJSONObject("properties");if(props==null)props=new JSONObject();JSONArray required=schema.optJSONArray("required");
        if(required!=null)for(int i=0;i<required.length();i++){String k=required.getString(i);if(!values.has(k)||values.isNull(k)||"".equals(values.opt(k)))throw new IOException("Missing action input: "+k);}
        for(Iterator<String> it=values.keys();it.hasNext();){String k=it.next();JSONObject p=props.optJSONObject(k);if(p==null)throw new IOException("Unknown action input: "+k);Object v=values.get(k);String t=p.optString("type");
            boolean good=t.isEmpty()||t.equals("string")&&v instanceof String||t.equals("boolean")&&v instanceof Boolean||t.equals("number")&&v instanceof Number||t.equals("integer")&&v instanceof Number&&((Number)v).doubleValue()==Math.rint(((Number)v).doubleValue())||t.equals("object")&&v instanceof JSONObject||t.equals("array")&&v instanceof JSONArray;
            if(!good)throw new IOException("Invalid type for "+k);JSONArray options=p.optJSONArray("enum");if(options!=null){boolean found=false;for(int i=0;i<options.length();i++)found|=options.get(i).equals(v);if(!found)throw new IOException("Invalid choice for "+k);}
        }return new JSONObject(values.toString());
    }
}
