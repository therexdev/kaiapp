#include "engine.h"
#include <iostream>
#include <stdexcept>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    try {
        Engine engine;
        engine.load(argv[1], 512, 2);
        auto first = engine.generate({{"system", "You are a helpful assistant."}, {"user", "Say hello in one short sentence."}}, 24, 0,
            [](const std::string&, int, int){});
        if (first.tokens < 1 || first.text.empty()) throw std::runtime_error("No generated output");
        std::cout << "Generation: " << first.text << "\n";
        auto stopped = engine.generate({{"user", "Count to one hundred."}}, 80, 0,
            [&](const std::string&, int count, int){ if (count >= 3) engine.cancel(); });
        if (!stopped.cancelled || stopped.tokens > 3) throw std::runtime_error("Cancellation failed");
        engine.resetCancel();
        std::vector<Message> history{{"system", "Be concise."}};
        for (int i=0;i<12;++i) { history.push_back({"user", std::string(200, 'a')}); history.push_back({"assistant", "OK."}); }
        history.push_back({"user", "Say hello."});
        auto trimmed = engine.generate(history, 12, 0, [](const std::string&,int,int){});
        if (trimmed.dropped < 1 || trimmed.tokens < 1) throw std::runtime_error("History trimming failed");
        bool rejected = false;
        try { engine.generate({{"user", std::string(12000, 'x')}}, 12, 0, [](const std::string&,int,int){}); }
        catch (const std::exception&) { rejected = true; }
        if (!rejected) throw std::runtime_error("Oversized prompt accepted");
        engine.unload(); engine.resetCancel(); engine.load(argv[1],512,2); engine.unload();
        std::cout << "PASS: inference, stop, history trimming, oversized prompt rejection, unload and reload\n";
        return 0;
    } catch (const std::exception &e) { std::cerr << e.what() << "\n"; return 1; }
}
