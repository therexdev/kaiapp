#pragma once
#include "engine.h"
#include <algorithm>
#include <stdexcept>

// Keep both ends of a long recent message, on UTF-8 boundaries. This is an
// explicit excerpt, not a generated summary or a replacement fact.
inline std::string contextExcerpt(const std::string &text, size_t keep) {
    size_t head=keep*2/3,tail=text.size()-keep/3;
    while(head>0&&(static_cast<unsigned char>(text[head])&0xc0)==0x80)--head;
    while(tail<text.size()&&(static_cast<unsigned char>(text[tail])&0xc0)==0x80)++tail;
    return text.substr(0,head)+"\n[Earlier message shortened]\n"+text.substr(tail);
}
inline int fitConversation(std::vector<Message> &messages,int available,
        const std::function<int(const std::vector<Message>&)> &count) {
    int dropped=0;
    while(count(messages)>available){
        size_t first=messages.front().role=="system"?1:0;
        int users=0;for(const auto &m:messages)if(m.role=="user")++users;
        if(users>2){
            size_t end=first+1;while(end<messages.size()-1&&messages[end].role!="user")++end;
            messages.erase(messages.begin()+first,messages.begin()+end);++dropped;continue;
        }
        // Preserve the immediately preceding question. First shorten its answer,
        // then an unusually long preceding question; never silently erase both.
        bool shortened=false;
        for(const auto &role:{"assistant","user"}){
            for(size_t i=first;i+1<messages.size();++i){
                size_t minimum=std::string(role)=="assistant"?192:320;
                if(messages[i].role==role&&messages[i].text.size()>minimum+64){
                    messages[i].text=contextExcerpt(messages[i].text,std::max(minimum,messages[i].text.size()/2));shortened=true;break;
                }
            }
            if(shortened)break;
        }
        if(!shortened)throw std::runtime_error("Not enough context to keep this question and the preceding exchange. Shorten the message or increase context in Settings and reload the model.");
    }
    return dropped;
}
