package io.koinosai.mobile;

import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.util.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28)
public class AgentRunnerTest {
    JSONObject tool()throws Exception{return new JSONObject("{\"id\":\"GMAIL_READ\",\"version\":\"v1\",\"toolkit\":\"gmail\",\"name\":\"Read email\",\"accountId\":\"account_a\",\"accountName\":\"My Gmail\",\"readOnly\":true,\"schema\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}}");}
    @Test public void multiStepUsesOnlySelectedToolsAndReturnsActualResult()throws Exception{
        AtomicInteger turns=new AtomicInteger(),calls=new AtomicInteger();AtomicBoolean stopped=new AtomicBoolean();
        String answer=AgentRunner.runLoop("Read today's email",Collections.singletonList(tool()),(messages,stop)->{
            if(turns.getAndIncrement()==0)return "{\"action\":\"action_1\",\"arguments\":{\"query\":\"today\"}}";
            assertTrue(messages.toString().contains("UNTRUSTED_ACTION_RESULT"));assertTrue(messages.toString().contains("3 messages"));return "{\"answer\":\"There are 3 messages.\"}";
        },(tool,args,stop)->{calls.incrementAndGet();assertEquals("account_a",tool.getString("accountId"));assertEquals("today",args.getString("query"));return "3 messages";},stopped,index->{});
        assertEquals(1,calls.get());assertEquals("There are 3 messages.",answer);
    }
    @Test public void unknownToolCannotExecute()throws Exception{
        AtomicInteger calls=new AtomicInteger();try{AgentRunner.runLoop("Task",Collections.singletonList(tool()),(m,s)->"{\"action\":\"shell\",\"arguments\":{}}",(t,a,s)->{calls.incrementAndGet();return "";},new AtomicBoolean(),i->{});fail();}catch(java.io.IOException e){assertTrue(e.getMessage().contains("outside"));}assertEquals(0,calls.get());
    }
    @Test public void identicalActionIsNeverRetried()throws Exception{
        AtomicInteger calls=new AtomicInteger();try{AgentRunner.runLoop("Task",Collections.singletonList(tool()),(m,s)->"{\"action\":\"action_1\",\"arguments\":{\"query\":\"today\"}}",(t,a,s)->{calls.incrementAndGet();return "ok";},new AtomicBoolean(),i->{});fail();}catch(java.io.IOException e){assertTrue(e.getMessage().contains("repeated"));}assertEquals(1,calls.get());
    }
    @Test public void cancellationBetweenModelAndToolBlocksAction()throws Exception{
        AtomicInteger calls=new AtomicInteger();AtomicBoolean stop=new AtomicBoolean();try{AgentRunner.runLoop("Task",Collections.singletonList(tool()),(m,s)->{stop.set(true);return "{\"action\":\"action_1\",\"arguments\":{\"query\":\"today\"}}";},(t,a,s)->{calls.incrementAndGet();return "";},stop,i->{});fail();}catch(java.io.IOException expected){}assertEquals(0,calls.get());
    }
    @Test public void malformedOrAmbiguousModelOutputCannotExecute()throws Exception{
        for(String output:new String[]{"I sent it!","{} {}","{\"answer\":\"sent\",\"action\":\"action_1\"}"}){
            AtomicInteger calls=new AtomicInteger();try{AgentRunner.runLoop("Task",Collections.singletonList(tool()),(m,s)->output,(t,a,s)->{calls.incrementAndGet();return "";},new AtomicBoolean(),i->{});fail(output);}catch(Exception expected){}assertEquals(0,calls.get());
        }
    }
    @Test public void actionFailureIsNotRetried()throws Exception{
        AtomicInteger calls=new AtomicInteger();try{AgentRunner.runLoop("Task",Collections.singletonList(tool()),(m,s)->"{\"action\":\"action_1\",\"arguments\":{\"query\":\"today\"}}",(t,a,s)->{calls.incrementAndGet();throw new java.io.IOException("Uncertain result");},new AtomicBoolean(),i->{});fail();}catch(java.io.IOException e){assertEquals("Uncertain result",e.getMessage());}assertEquals(1,calls.get());
    }
    @Test public void stepBudgetStopsAnUnboundedAgent()throws Exception{
        AtomicInteger calls=new AtomicInteger(),turns=new AtomicInteger();try{AgentRunner.runLoop("Task",Collections.singletonList(tool()),(m,s)->"{\"action\":\"action_1\",\"arguments\":{\"query\":\""+turns.incrementAndGet()+"\"}}",(t,a,s)->{calls.incrementAndGet();return "result";},new AtomicBoolean(),i->{});fail();}catch(java.io.IOException e){assertTrue(e.getMessage().contains("8-step"));}assertEquals(8,calls.get());
    }
    @Test public void oauthLinksMustStayOnExactTrustedHosts()throws Exception{
        assertEquals("https://connect.composio.dev/link/abc",ConnectionsHub.connectURL("https://connect.composio.dev/link/abc"));
        for(String url:new String[]{"http://connect.composio.dev/a","https://connect.composio.dev.evil.test/a","https://user@connect.composio.dev/a","https://connect.composio.dev:444/a","javascript:alert(1)"}){try{ConnectionsHub.connectURL(url);fail(url);}catch(Exception expected){}}
    }
    @Test public void schemaRejectsMissingUnknownAndWrongTypeArguments()throws Exception{
        JSONObject schema=tool().getJSONObject("schema");for(String args:new String[]{"{}","{\"query\":3}","{\"query\":\"x\",\"url\":\"https://evil.test\"}"}){try{ConnectionsHub.validateArgs(new JSONObject(args),schema);fail(args);}catch(Exception expected){}}
    }
    @Test public void deduplicationIsIndependentOfObjectKeyOrder()throws Exception{
        assertEquals(AgentRunner.canonical(new JSONObject("{\"b\":2,\"a\":{\"y\":1,\"x\":2}}")),AgentRunner.canonical(new JSONObject("{\"a\":{\"x\":2,\"y\":1},\"b\":2}")));
    }
}
