package io.koinosai.mobile;

import java.text.Normalizer;
import java.util.*;
import java.util.regex.*;

/** Local rules: no model call, account data, or chat transcript is sent to a planner. */
final class SearchPlanner {
    static final class Plan {
        final boolean search,followUp;final String query,topic;
        Plan(boolean search,boolean followUp,String query,String topic){this.search=search;this.followUp=followUp;this.query=query;this.topic=topic;}
    }
    private static final Set<String> FILLER=new HashSet<>(Arrays.asList(("a an the and or of to in on at for from with is are was were be been being do does did can could will would should have has had how what which when where who why please tell explain find search look up online web internet about me my your you i it its this that these those use uses using s m ve re want need know give get just really some something information details question thanks thank hi hello hey kai according based results much more most also now let's lets interested wondering wondering").split(" ")));
    private static final Set<String> REFERENCES=new HashSet<>(Arrays.asList(("first second third last earliest oldest newest latest best better worst one ones game games model models device devices option options choice choices release released order chronological chronologically timeline story price cost costs expensive cheaper today current compare comparison difference differences them they their those that this it again shorter longer summary summarize elaborate continue why year date dates years out came actually instead then respectively available availability same still vs versus").split(" ")));
    static String fold(String s){return Normalizer.normalize(s,Normalizer.Form.NFD).replaceAll("\\p{M}+","").toLowerCase(Locale.ROOT);}
    private static boolean matches(String s,String regex){return Pattern.compile(regex).matcher(s).find();}
    static String focus(String prompt){
        String s=prompt.trim();Matcher question=Pattern.compile("(?i)(?:^|[\\n.!?])\\s*(?:what|which|how|where|when|who|is|are|can|could|find|search|look up)\\b").matcher(s);int start=-1;
        while(question.find())start=question.start();return start>=0?s.substring(start).replaceFirst("^[\\n.!?]\\s*",""):s;
    }
    static List<String> words(String text){
        // Do not carry emails, URLs, long identifiers or likely secrets into a search query.
        String s=text.replaceAll("(?i)\\b(what|where|when|who|how|that|there|it)'s\\b", "$1 is").replaceAll("(?i)https?://\\S+|[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}|\\b(?:token|password|secret|api[_ -]?key)\\s*[:=]\\s*\\S+", " ");
        LinkedHashSet<String> out=new LinkedHashSet<>();Matcher m=Pattern.compile("[\\p{L}\\p{N}]+(?:[-'][\\p{L}\\p{N}]+)*").matcher(s);
        while(m.find()){String word=m.group().toLowerCase(Locale.ROOT),key=fold(word);if(word.length()>32||key.matches("[0-9]{5,}")||FILLER.contains(key))continue;out.add(word);}
        return new ArrayList<>(out);
    }
    static boolean follows(String prompt,String topic){
        if(topic.isEmpty()||matches(fold(prompt),"\\b(new topic|unrelated|switch topics|forget that|instead of)\\b"))return false;
        List<String> current=words(focus(prompt)),prior=words(topic);Set<String> known=new HashSet<>();for(String w:prior)known.add(fold(w));
        int novel=0;for(String w:current)if(!known.contains(fold(w))&&!REFERENCES.contains(fold(w)))novel++;
        boolean reference=matches(fold(prompt),"\\b(it|its|they|their|them|those|that one|this one|which one|make it|what about)\\b");
        return novel==0&&!current.isEmpty()||reference&&novel<=1;
    }
    static String topic(List<KaiApp.ChatMessage> history){
        String topic="";int start=Math.max(0,history.size()-16);
        for(int i=start;i<history.size();i++){KaiApp.ChatMessage m=history.get(i);if(m.role.equals("user")&&!m.text.trim().isEmpty()&&!follows(m.text,topic))topic=WebSearch.limit(focus(m.text),1200);}
        return topic;
    }
    static Plan plan(String prompt,List<KaiApp.ChatMessage> history,boolean enabled,boolean always,boolean allowTopic){
        String focused=focus(prompt),p=fold(focused),topic=topic(history);boolean follow=follows(focused,topic);
        boolean explicit=matches(p,"\\b(search|look up|browse|check online|verify|fact.check|sources?|citations?)\\b");
        boolean transform=matches(p,"^(please )?(write|rewrite|translate|summarize|summarise|rephrase|shorten|make|draft|compose|calculate|solve|continue|explain (that|it|this|your))\\b")||matches(p,"\\b(poem|fictional story)\\b");
        boolean timely=matches(p,"\\b(latest|current|today|tonight|tomorrow|yesterday|this (week|month|year)|right now|recent|news|weather|forecast|price|prices|cost|costs|stock|score|scores|schedule|available|availability|version|update|release|released|best|recommend|recommendations|reviews?|buy|buying|compatible|compatibility|specs|specifications|processor|chronolog\\w*|timeline|earliest|oldest)\\b");
        boolean forbidden=matches(fold(prompt),"\\b(do not|don[’']t|without|no) (use |using |do |doing )?(web|internet|online|search|searching|browse|browsing)\\b");
        boolean search=enabled&&!forbidden&&(always||!transform&&(explicit||timely)||matches(p,"^(please )?(search|look up|browse|check online|verify)\\b"));
        LinkedHashSet<String> selected=new LinkedHashSet<>();
        if(follow&&allowTopic){for(String w:words(topic)){if(!REFERENCES.contains(fold(w)))selected.add(w);if(selected.size()==5)break;}}
        List<String> terms=words(focused);for(String w:terms){selected.add(w);if(selected.size()>=22)break;}
        String query=WebSearch.limit(String.join(" ",selected),240).trim();
        // A query with no public subject (greeting, arithmetic, secret-only input) is not useful.
        if(query.isEmpty())search=false;
        return new Plan(search,follow,query,topic);
    }
}
