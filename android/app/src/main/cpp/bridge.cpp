#include "engine.h"
#include <jni.h>
#include <mutex>
#include <stdexcept>

static Engine engine;
static std::mutex operation;
static std::string bytes(JNIEnv *env, jbyteArray value) {
    jsize size = env->GetArrayLength(value);
    std::string result(size, '\0');
    env->GetByteArrayRegion(value, 0, size, reinterpret_cast<jbyte*>(result.data()));
    return result;
}
static void error(JNIEnv *env, const std::exception &e) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), e.what());
}
extern "C" JNIEXPORT void JNICALL Java_io_koinosai_mobile_NativeEngine_resetCancel(JNIEnv*, jclass) { engine.resetCancel(); }
extern "C" JNIEXPORT void JNICALL Java_io_koinosai_mobile_NativeEngine_cancel(JNIEnv*, jclass) { engine.cancel(); }
extern "C" JNIEXPORT void JNICALL Java_io_koinosai_mobile_NativeEngine_unload(JNIEnv*, jclass) {
    std::lock_guard<std::mutex> lock(operation); engine.unload();
}
extern "C" JNIEXPORT void JNICALL Java_io_koinosai_mobile_NativeEngine_load(JNIEnv *env, jclass, jbyteArray path, jint context, jint threads) {
    std::lock_guard<std::mutex> lock(operation);
    try { engine.load(bytes(env, path), context, threads); }
    catch (const std::exception &e) { error(env, e); }
}
extern "C" JNIEXPORT jintArray JNICALL Java_io_koinosai_mobile_NativeEngine_generate(JNIEnv *env, jclass, jobjectArray roles,
        jobjectArray contents, jint maxTokens, jfloat temperature, jobject callback) {
    std::lock_guard<std::mutex> lock(operation);
    try {
        const int n = env->GetArrayLength(roles);
        if (n != env->GetArrayLength(contents) || n > 200) throw std::runtime_error("Invalid conversation.");
        std::vector<Message> messages;
        for (int i=0; i<n; ++i) {
            auto role = static_cast<jbyteArray>(env->GetObjectArrayElement(roles, i));
            auto content = static_cast<jbyteArray>(env->GetObjectArrayElement(contents, i));
            messages.push_back({bytes(env, role), bytes(env, content)});
            env->DeleteLocalRef(role); env->DeleteLocalRef(content);
        }
        auto method = env->GetMethodID(env->GetObjectClass(callback), "onText", "([BII)V");
        if (!method) return nullptr;
        auto result = engine.generate(messages, maxTokens, temperature, [&](const std::string &text, int count, int dropped) {
            auto array = env->NewByteArray(text.size());
            env->SetByteArrayRegion(array, 0, text.size(), reinterpret_cast<const jbyte*>(text.data()));
            env->CallVoidMethod(callback, method, array, count, dropped);
            env->DeleteLocalRef(array);
            if (env->ExceptionCheck()) engine.cancel();
        });
        if (env->ExceptionCheck()) return nullptr;
        jint values[] = {result.tokens, result.dropped, result.cancelled ? 1 : 0, result.limit ? 1 : 0};
        auto array = env->NewIntArray(4); env->SetIntArrayRegion(array, 0, 4, values); return array;
    } catch (const std::exception &e) { error(env, e); return nullptr; }
}
