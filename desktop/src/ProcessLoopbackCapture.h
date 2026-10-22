#pragma once

#include <functional>
#include <memory>
#include <thread>
#include <QString>

namespace livekit { class AudioSource; }

// Captures the Windows playback mix, excluding audio rendered by this process
// and its descendants. The exclusion prevents the call's own playout from
// being sent to other participants a second time.
class ProcessLoopbackCapture final {
public:
    using ErrorHandler = std::function<void(const QString&)>;
    ProcessLoopbackCapture() = default;
    ~ProcessLoopbackCapture();
    ProcessLoopbackCapture(const ProcessLoopbackCapture&) = delete;
    ProcessLoopbackCapture& operator=(const ProcessLoopbackCapture&) = delete;
    void start(std::shared_ptr<livekit::AudioSource> source, ErrorHandler errorHandler);
    void stop();
private:
    void run(std::stop_token stopToken, std::shared_ptr<livekit::AudioSource> source,
             ErrorHandler errorHandler);
    std::jthread thread_;
};
