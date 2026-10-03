package io.koinosai.mobile;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,application=android.app.Application.class)
public class NetworkStreamTest {
    @Test public void readsWebsiteFramesAndAuthoritativeUnicodeReply() throws Exception {
        List<JSONObject> frames=new ArrayList<>();
        String s=": heartbeat\n\ndata: {\"accepted\":true}\r\n\r\ndata: {\"delta\":\"Hi 👋\"}\n\ndata: {\"done\":true,\n data: \"output\":\"Hi 👋 there\",\"costUsd\":0.002}\n\ndata: [DONE]\n\n".replace("\n data:","\ndata:");
        NetworkApi.readEvents(new StringReader(s),new AtomicBoolean(),frames::add);
        assertEquals(3,frames.size());assertEquals("Hi 👋 there",frames.get(2).getString("output"));assertEquals(.002,frames.get(2).getDouble("costUsd"),.00001);
    }
    @Test public void disconnectedStreamDoesNotPretendToComplete() throws Exception {
        List<JSONObject> frames=new ArrayList<>();
        assertThrows(IOException.class,()->NetworkApi.readEvents(new StringReader("data: {\"delta\":\"partial\"}\n\n"),new AtomicBoolean(),frames::add));assertEquals("partial",frames.get(0).getString("delta"));
    }
    @Test public void serverErrorsAndPrematureDoneAreFailures() {
        assertThrows(IOException.class,()->NetworkApi.readEvents(new StringReader("data: {\"error\":{\"message\":\"No provider\"}}\n\n"),new AtomicBoolean(),f->fail()));
        assertThrows(IOException.class,()->NetworkApi.readEvents(new StringReader("data: [DONE]\n\n"),new AtomicBoolean(),f->fail()));
    }
    @Test public void oversizedFramesAndCancellationAreBounded() {
        assertThrows(IOException.class,()->NetworkApi.readEvents(new StringReader("data: "+"x".repeat(300000)),new AtomicBoolean(),f->fail()));
        assertThrows(IOException.class,()->NetworkApi.readEvents(new StringReader("data: {}\n\n"),new AtomicBoolean(true),f->fail()));
    }
}
