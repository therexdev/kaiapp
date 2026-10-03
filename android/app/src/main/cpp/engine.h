#pragma once
#include "llama.h"
#include <atomic>
#include <functional>
#include <string>
#include <vector>

struct Message { std::string role; std::string text; };
struct Generation { std::string text; int tokens = 0; int dropped = 0; bool cancelled = false; bool limit = false; };

// All operations except cancel run on one owner thread. Cancellation never frees memory.
class Engine {
public:
    Engine() = default;
    ~Engine();
    void load(const std::string &path, int context, int threads);
    void unload();
    Generation generate(std::vector<Message> messages, int maxTokens, float temperature,
        const std::function<void(const std::string&, int, int)> &onText);
    void resetCancel() { cancelled.store(false); }
    void cancel() { cancelled.store(true); }
    bool stopped() const { return cancelled.load(); }
private:
    std::atomic<bool> cancelled{false};
    llama_model *model = nullptr;
    llama_context *context = nullptr;
    std::vector<llama_token> tokenize(const std::vector<Message> &messages);
};
