package io.koinosai.mobile;

import android.os.Looper;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @LooperMode(LooperMode.Mode.PAUSED)
public class MobileAgentContractTest {
    KaiApp app;FakeService service;JSONObject tool;
    class FakeService extends NetworkApi {
        volatile int calls,turns;JSONObject executeBody;boolean failWrite;
        @Override JSONObject json(String path,String token,JSONObject body,AtomicBoolean stop)throws Exception{
            if(stop.get())throw new java.io.IOException("Stopped");assertEquals("account-secret",token);assertEquals("project-one",body.getString("generation"));
            if(path.endsWith("/tool"))return new JSONObject().put("result",tool);
            if(path.endsWith("/execute")){calls++;executeBody=new JSONObject(body.toString());if(failWrite)throw new java.io.IOException("Connection lost");return new JSONObject().put("result","Message sent");}
            throw new AssertionError(path);
        }
        @Override void stream(JSONObject request,AtomicBoolean stop,Frames frames)throws Exception{
            assertEquals("account-secret",request.getString("sessionToken"));assertEquals("grant-one",request.getString("grantId"));assertFalse(request.getBoolean("selfHost"));
            String output=turns++==0?"{\"action\":\"action_1\",\"arguments\":{\"recipient\":\"friend@example.invalid\",\"body\":\"Hello\"}}":"{\"answer\":\"Your message was sent.\"}";
            frames.frame(new JSONObject().put("done",true).put("output",output));
        }
    }
    @Before public void setup()throws Exception{
        app=(KaiApp)RuntimeEnvironment.getApplication();app.account.worker.submit(()->{}).get();idle();app.account.token="account-secret";app.account.validUntil=System.currentTimeMillis()+600000;
        app.account.account=new JSONObject().put("id","owner-one").put("grants",new JSONArray().put(new JSONObject().put("id","grant-one").put("live",true).put("expiresAt",System.currentTimeMillis()+600000).put("remainingUsd",5)));
        app.accountChanged();app.setNetworkEnabled(true);app.setRoute("network");app.grantId="grant-one";
        tool=new JSONObject("{\"id\":\"GMAIL_SEND\",\"version\":\"v1\",\"toolkit\":\"gmail\",\"name\":\"Send email\",\"readOnly\":false,\"schema\":{\"type\":\"object\",\"properties\":{\"recipient\":{\"type\":\"string\"},\"body\":{\"type\":\"string\"}},\"required\":[\"recipient\",\"body\"]}}");
        app.connections.owner="owner-one";app.connections.generation="project-one";app.connections.available=true;app.connections.accounts=new JSONArray().put(new JSONObject().put("id","gmail-one").put("toolkit","gmail").put("name","My Gmail").put("status","ACTIVE"));app.connections.allow("gmail-one",tool,true);
        service=new FakeService();app.agent=new AgentRunner(app,service,service);app.error="";
    }
    void idle(){Shadows.shadowOf(Looper.getMainLooper()).idle();}
    void until(BooleanSupplier ready)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(!ready.getAsBoolean()&&System.nanoTime()<end){idle();Thread.sleep(10);}idle();assertTrue("Async state not reached",ready.getAsBoolean());}
    @After public void close()throws Exception{app.agent.stop();until(()->!app.agent.running);app.main.removeCallbacksAndMessages(null);app.account.worker.shutdownNow();app.connections.worker.shutdownNow();app.network.shutdownNow();app.inference.shutdownNow();app.disk.shutdownNow();app.persistence.shutdownNow();}
    @Test public void writesWaitForExactReviewAndExecuteOnlyOnce()throws Exception{
        app.agent.start("Send Hello to friend@example.invalid");until(()->app.agent.review!=null);assertEquals(0,service.calls);AgentRunner.Review review=app.agent.review;assertTrue(review.arguments.contains("friend@example.invalid"));
        app.agent.approve("wrong-id",true);assertEquals(0,service.calls);app.agent.approve(review.id,true);app.agent.approve(review.id,true);until(()->!app.agent.running);
        assertEquals(1,service.calls);assertEquals("gmail-one",service.executeBody.getString("id"));assertEquals("Your message was sent.",app.agent.answer);assertEquals(1,app.agent.history().length());
    }
    @Test public void decliningOrGoingOfflineNeverExecutesPendingWrite()throws Exception{
        app.agent.start("Send Hello");until(()->app.agent.review!=null);app.agent.approve(app.agent.review.id,false);until(()->!app.agent.running);assertEquals(0,service.calls);
        service.turns=0;app.agent.start("Send Hello");until(()->app.agent.review!=null);app.setNetworkEnabled(false);until(()->!app.agent.running);assertEquals(0,service.calls);assertNull(app.agent.review);
    }
    @Test public void signOutInvalidatesPendingApprovalAndHidesAccountData()throws Exception{
        app.agent.start("Send Hello");until(()->app.agent.review!=null);String id=app.agent.review.id;app.setNetworkEnabled(false);app.account.signOut();app.agent.approve(id,true);until(()->!app.agent.running);assertEquals(0,service.calls);assertEquals(0,app.connections.accounts.length());assertEquals(0,app.agent.history().length());
    }
    @Test public void ambiguousWriteFailureStopsWithoutAutomaticRetry()throws Exception{
        service.failWrite=true;app.agent.start("Send Hello");until(()->app.agent.review!=null);app.agent.approve(app.agent.review.id,true);until(()->!app.agent.running);assertEquals(1,service.calls);assertEquals("Check the connected app",app.agent.status);assertTrue(String.join(" ",app.agent.trace).contains("uncertain"));
    }
    @Test public void readActionsRunWithoutWriteApproval()throws Exception{
        tool.put("readOnly",true);app.connections.allow("gmail-one",tool,true);app.agent.start("Read my email");until(()->!app.agent.running);assertEquals(1,service.calls);assertNull(app.agent.review);
    }
    @Test public void projectOrAccountChangeCannotInheritActionPermissions()throws Exception{
        assertEquals(1,app.connections.selected().size());app.connections.generation="project-two";assertTrue(app.connections.selected().isEmpty());app.connections.generation="project-one";app.account.account.put("id","owner-two");app.accountChanged();assertTrue(app.connections.selected().isEmpty());assertEquals(0,app.connections.accounts.length());
    }
    @Test public void interruptedCheckpointSurvivesAndBlocksBlindResubmission()throws Exception{
        app.agent.task="Send Hello";app.agent.runId="interrupted-run";app.agent.checkpoint("owner-one","Action may have been submitted. Check Gmail first.");
        app.agent=new AgentRunner(app,service,service);assertNotNull(app.agent.interrupted());app.agent.start("Send Hello again");assertFalse(app.agent.running);assertEquals(0,service.calls);assertTrue(app.error.contains("interrupted"));
    }
}
