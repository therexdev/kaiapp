#include "context_budget.h"
#include <iostream>
static int count(const std::vector<Message> &messages){int n=0;for(auto &m:messages)n+=m.text.size()+8;return n;}
static void check(bool value){if(!value)throw std::runtime_error("Context budget regression");}
int main(){
    std::vector<Message> chat{{"system","Keep context."},{"user","What's the best Pokemon game?"},{"assistant",std::string(2400,'x')},{"user","What is the first game chronologically?"}};
    int dropped=fitConversation(chat,650,count);check(dropped==0);check(chat.size()==4);check(chat[1].text.find("Pokemon")!=std::string::npos);check(chat[2].text.find("shortened")!=std::string::npos);check(count(chat)<=650);
    chat.insert(chat.begin()+1,{{"user","An older topic"},{"assistant",std::string(900,'x')}});check(fitConversation(chat,650,count)==1);check(chat[1].text.find("Pokemon")!=std::string::npos);
    auto intact=chat;bool rejected=false;try{fitConversation(chat,80,count);}catch(const std::exception&){rejected=true;}check(rejected);check(chat[1].text.find("Pokemon")!=std::string::npos);
    check(fitConversation(intact,2000,count)==0);
    std::string unicode;for(int i=0;i<100;i++)unicode+="\xF0\x9F\x98\x80";
    auto excerpt=contextExcerpt(unicode,195);check((static_cast<unsigned char>(excerpt.front())&0xc0)!=0x80);check(excerpt.find("shortened")!=std::string::npos);
    std::cout<<"PASS: recent exchange retained, long replies excerpted, oldest turns dropped first, insufficient context rejected, UTF-8 boundaries\n";
}
