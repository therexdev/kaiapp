package io.koinosai.mobile;
import android.os.Looper;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @LooperMode(LooperMode.Mode.PAUSED)
public class AccountContractTest {
    KaiApp app;FakeApi api;MemoryVault vault;
    static class MemoryVault extends SessionVault {
        JSONObject saved;
        MemoryVault(KaiApp app){super(app);}
        @Override JSONObject read(){return saved;}
        @Override void write(JSONObject value){saved=value;}
        @Override void clear(){saved=null;}
    }
    static class FakeApi extends NetworkApi {
        final List<String> calls=new ArrayList<>();JSONObject profile,streamRequest;int reject;boolean failNodes,failStream;
        @Override JSONObject json(String path,String token,JSONObject body,AtomicBoolean stop) throws Exception {
            if(stop.get())throw new java.io.IOException("Stopped");calls.add(path);
            if(reject>0)throw new ApiError(reject,"session rejected");
            if(path.equals("/auth/device/start"))return new JSONObject().put("ok",true).put("userCode","ABCD-EFGH").put("deviceSecret","private-test-secret").put("expiresInSec",600);
            if(path.equals("/auth/device/poll")){assertEquals("private-test-secret",body.getString("deviceSecret"));return new JSONObject().put("token","private-test-token").put("account",profile);}
            if(path.equals("/account/api/nodes")){if(failNodes)throw new java.io.IOException("Offline");return new JSONObject().put("nodes",new JSONArray().put(new JSONObject().put("online",true).put("address","linked-wallet")));}
            if(path.equals("/scheduler/network/models"))return new JSONObject().put("models",new JSONArray());
            return new JSONObject().put("ok",true).put("account",profile);
        }
        @Override void stream(JSONObject request,AtomicBoolean stop,Frames frames) throws Exception {
            streamRequest=request;frames.frame(new JSONObject().put("delta","A partial reply"));
            if(failStream)throw new java.io.IOException("Connection interrupted");
            frames.frame(new JSONObject().put("done",true).put("output","A complete reply").put("costUsd",.002).put("servedModel","koinos-fast"));
        }
    }
    @Before public void setup() throws Exception {
        app=(KaiApp)RuntimeEnvironment.getApplication();app.account.worker.submit(()->{}).get();idle();app.account.worker.shutdownNow();
        api=new FakeApi();api.profile=new JSONObject().put("id","account-a").put("email","a@example.invalid").put("grants",new JSONArray().put(new JSONObject().put("id","grant-a").put("live",true).put("expiresAt",System.currentTimeMillis()+600000).put("remainingUsd",5)));
        vault=new MemoryVault(app);app.account=new AccountState(app,api,vault);app.account.restoring=false;app.chatApi=api;app.chats.clear();app.current=new KaiApp.Conversation();
    }
    @After public void close(){app.main.removeCallbacksAndMessages(null);app.account.worker.shutdownNow();app.inference.shutdownNow();app.network.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();}
    void idle(){Shadows.shadowOf(Looper.getMainLooper()).idle();}
    void settle() throws Exception {for(int i=0;i<3;i++){app.account.worker.submit(()->{}).get();idle();}}
    void signIn(){app.account.token="private-test-token";app.account.account=api.profile;app.account.validUntil=System.currentTimeMillis()+60000;app.accountChanged();app.grantId="grant-a";}
    @Test public void localOnlyAndSignedOutCannotReachNetworkOrLoadModels() throws Exception {
        app.account.start();app.account.refresh();app.send("hello");app.loadModel(app.models.get(0));settle();assertTrue(api.calls.isEmpty());assertNull(api.streamRequest);assertNull(app.active);assertFalse(app.busy);
        signIn();app.account.refresh();app.sendNetwork("hello");app.download(app.models.get(0));settle();assertTrue(api.calls.isEmpty());assertNull(api.streamRequest);assertEquals(-1,app.models.get(0).downloadId);
    }
    @Test public void deviceFlowPersistsSessionAndFetchesOnlyAccountNodes() throws Exception {
        app.setRoute("network");app.account.start();settle();assertEquals("ABCD-EFGH",app.account.code);app.account.poll();settle();
        assertTrue(app.account.signedIn());assertNotNull(vault.saved);assertEquals("private-test-token",vault.saved.getString("token"));assertEquals(1,app.account.nodes.length());assertTrue(api.calls.contains("/account/api/nodes"));
    }
    @Test public void expiredDeviceCodeReturnsToRetryableSignIn() throws Exception {
        app.setRoute("network");app.account.start();settle();api.reject=404;app.account.poll();settle();
        assertEquals("",app.account.code);assertEquals("",app.account.secret);assertFalse(app.account.working);assertFalse(app.account.signedIn());assertNull(vault.saved);
    }
    @Test public void expiredOrRejectedSessionsLockChatWithoutDeletingHistory() throws Exception {
        signIn();app.newChat();app.current.messages.add(new KaiApp.ChatMessage("user","private"));app.account.validUntil=0;assertFalse(app.account.signedIn());app.send("hello");assertFalse(app.generating);
        app.account.validUntil=System.currentTimeMillis()+60000;app.setRoute("network");api.reject=401;app.account.refresh();settle();assertFalse(app.account.signedIn());assertTrue(app.account.rejected);assertFalse(app.chats.isEmpty());assertTrue(app.visibleChats().isEmpty());
    }
    @Test public void failedDashboardRefreshPreservesTimestampedSnapshot() throws Exception {
        signIn();app.setRoute("network");app.account.refresh();settle();long time=app.account.nodesAt;api.failNodes=true;app.account.refresh();settle();assertEquals(time,app.account.nodesAt);assertEquals(1,app.account.nodes.length());assertFalse(app.account.error.isEmpty());
    }
    @Test public void modeSwitchNeverReusesLocalMessagesEvenAtChatLimit() throws Exception {
        signIn();app.newChat();KaiApp.Conversation local=app.current;local.messages.add(new KaiApp.ChatMessage("user","private local history"));app.setRoute("network");assertNotEquals(local,app.current);assertTrue(app.current.messages.isEmpty());assertEquals("local",local.route);
        app.setRoute("local");app.selectChat(local);while(app.visibleChats().size()<30){KaiApp.Conversation c=new KaiApp.Conversation();c.owner="account-a";app.chats.add(c);}app.setRoute("network");assertEquals("local",app.route);assertEquals("local",local.route);
    }
    @Test public void networkRequestUsesGrantAndOwnNodeFlagAndKeepsPartialFailure() throws Exception {
        signIn();app.setRoute("own");app.grantId="grant-a";api.failStream=true;app.send("hello");app.network.submit(()->{}).get();idle();assertTrue(api.streamRequest.getBoolean("selfHost"));assertEquals("grant-a",api.streamRequest.getString("grantId"));assertEquals("private-test-token",api.streamRequest.getString("sessionToken"));assertTrue(app.current.messages.get(1).incomplete);assertEquals("A partial reply",app.current.messages.get(1).text);assertFalse(app.busy);
    }
    @Test public void signOutLocksBothModesAndAnotherAccountCannotReadChats() throws Exception {
        signIn();app.newChat();KaiApp.Conversation old=app.current;old.messages.add(new KaiApp.ChatMessage("user","account A secret"));app.account.signOut();settle();assertFalse(app.account.signedIn());assertFalse(app.networkAllowed());assertNull(vault.saved);assertEquals("",app.exportChat());
        api.profile.put("id","account-b");signIn();assertFalse(app.visibleChats().contains(old));app.selectChat(old);assertNotEquals(old,app.current);
    }
}
