#include "engine.h"
#include "context_budget.h"
#include <algorithm>
#include <chrono>
#include <memory>
#include <stdexcept>

Engine::~Engine() { unload(); }
void Engine::unload() {
    if (context) llama_free(context);
    if (model) llama_model_free(model);
    context = nullptr; model = nullptr;
}
void Engine::load(const std::string &path, int contextSize, int threads) {
    unload();
    if (contextSize < 512 || contextSize > 4096 || threads < 1 || threads > 8)
        throw std::runtime_error("Invalid inference settings.");
    llama_backend_init();
    auto mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    mp.progress_callback = [](float, void *data) { return !static_cast<Engine*>(data)->stopped(); };
    mp.progress_callback_user_data = this;
    model = llama_model_load_from_file(path.c_str(), mp);
    if (!model) throw std::runtime_error(stopped() ? "Loading stopped." : "This model could not be loaded. Use a supported, complete text GGUF model.");
    auto cp = llama_context_default_params();
    cp.n_ctx = static_cast<uint32_t>(std::min(contextSize, llama_model_n_ctx_train(model)));
    cp.n_batch = 128; cp.n_ubatch = 128;
    cp.n_threads = threads; cp.n_threads_batch = threads;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    cp.abort_callback = [](void *data) { return static_cast<Engine*>(data)->stopped(); };
    cp.abort_callback_data = this;
    context = llama_init_from_model(model, cp);
    if (!context) { unload(); throw std::runtime_error("Not enough memory to start this model. Try a smaller model or shorter context."); }
    // Fail now rather than on the first user message if no supported chat template exists.
    try { tokenize({{"user", "Hello"}}); }
    catch (...) { unload(); throw; }
}
std::vector<llama_token> Engine::tokenize(const std::vector<Message> &messages) {
    std::vector<llama_chat_message> chat;
    for (const auto &m : messages) chat.push_back({m.role.c_str(), m.text.c_str()});
    const char *tmpl = llama_model_chat_template(model, nullptr);
    if (!tmpl) throw std::runtime_error("This GGUF has no chat template. Import an instruction/chat model with a supported template.");
    int count = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true, nullptr, 0);
    if (count < 0 || count > 2 * 1024 * 1024) throw std::runtime_error("The model's chat template is not supported.");
    std::vector<char> formatted(count + 1);
    count = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true, formatted.data(), formatted.size());
    if (count < 0 || count >= static_cast<int>(formatted.size())) throw std::runtime_error("Could not prepare the conversation.");
    auto vocab = llama_model_get_vocab(model);
    int n = -llama_tokenize(vocab, formatted.data(), count, nullptr, 0, true, true);
    if (n < 1) throw std::runtime_error("The message could not be tokenized.");
    std::vector<llama_token> result(n);
    if (llama_tokenize(vocab, formatted.data(), count, result.data(), result.size(), true, true) < 0)
        throw std::runtime_error("The message could not be tokenized.");
    return result;
}
static size_t utf8Prefix(const std::string &s) {
    if (s.empty()) return 0;
    size_t i = s.size() - 1;
    while (i > 0 && (static_cast<unsigned char>(s[i]) & 0xc0) == 0x80) --i;
    auto c = static_cast<unsigned char>(s[i]);
    size_t need = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    return s.size() - i < need ? i : s.size();
}
Generation Engine::generate(std::vector<Message> messages, int maxTokens, float temperature,
        const std::function<void(const std::string&, int, int)> &onText) {
    if (!model || !context) throw std::runtime_error("Load a model in Models first.");
    if (maxTokens < 1 || maxTokens > 1024 || temperature < 0 || temperature > 2)
        throw std::runtime_error("Invalid generation settings.");
    if (messages.empty() || messages.back().role != "user") throw std::runtime_error("A user message is required.");
    Generation result;
    std::vector<llama_token> tokens;
    const int capacity=static_cast<int>(llama_n_ctx(context));
    const int available=capacity-std::min(maxTokens,capacity/3);
    result.dropped=fitConversation(messages,available,[&](const std::vector<Message> &chat){tokens=tokenize(chat);return static_cast<int>(tokens.size());});
    maxTokens=std::min(maxTokens,capacity-static_cast<int>(tokens.size()));
    llama_memory_clear(llama_get_memory(context), true);
    for (size_t offset = 0; offset < tokens.size() && !stopped(); offset += 128) {
        auto count = std::min<size_t>(128, tokens.size() - offset);
        int code = llama_decode(context, llama_batch_get_one(tokens.data() + offset, count));
        if (code != 0 && !stopped()) throw std::runtime_error("Model processing failed. Try a shorter context or smaller model.");
    }
    auto sampler = std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)>(
        llama_sampler_chain_init(llama_sampler_chain_default_params()), llama_sampler_free);
    if (temperature == 0) llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    else {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_k(40));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_p(0.9f, 1));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
    }
    auto vocab = llama_model_get_vocab(model);
    for (int i = 0; i < maxTokens && !stopped(); ++i) {
        llama_token token = llama_sampler_sample(sampler.get(), context, -1);
        if (llama_vocab_is_eog(vocab, token)) break;
        char buffer[256];
        int length = llama_token_to_piece(vocab, token, buffer, sizeof(buffer), 0, false);
        if (length >= 0) result.text.append(buffer, length);
        else {
            std::vector<char> large(-length);
            length = llama_token_to_piece(vocab, token, large.data(), large.size(), 0, false);
            if (length < 0) throw std::runtime_error("Could not decode the response.");
            result.text.append(large.data(), length);
        }
        ++result.tokens;
        onText(result.text.substr(0, utf8Prefix(result.text)), result.tokens, result.dropped);
        if (i == maxTokens - 1) { result.limit = true; break; }
        int code = llama_decode(context, llama_batch_get_one(&token, 1));
        if (code != 0 && !stopped()) throw std::runtime_error("Response interrupted by an inference error.");
    }
    result.cancelled = stopped();
    result.text.resize(utf8Prefix(result.text));
    return result;
}
