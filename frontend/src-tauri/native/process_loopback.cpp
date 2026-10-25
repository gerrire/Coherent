#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <wrl/implements.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <cstring>
#include <new>
#include <stop_token>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {
using PacketCallback = void (*)(const std::int16_t*, std::uint32_t, std::int32_t, void*);

class ActivationHandler final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    ActivationHandler() : ready_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
    ~ActivationHandler() { if (ready_) CloseHandle(ready_); }

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> unknown;
        HRESULT activation = E_FAIL;
        const HRESULT call = operation->GetActivateResult(&activation, &unknown);
        result_ = FAILED(call) ? call : activation;
        if (SUCCEEDED(result_) && unknown) result_ = unknown.As(&client_);
        SetEvent(ready_);
        return S_OK;
    }
    HANDLE ready() const { return ready_; }
    HRESULT result() const { return result_; }
    ComPtr<IAudioClient> client() const { return client_; }

private:
    HANDLE ready_ = nullptr;
    HRESULT result_ = E_PENDING;
    ComPtr<IAudioClient> client_;
};

class Capture final {
public:
    Capture(DWORD excluded_process, PacketCallback callback, void* context)
        : excluded_process_(excluded_process), callback_(callback), context_(context), thread_([this](std::stop_token stop) noexcept {
            try { run(stop); }
            catch (const std::bad_alloc&) { report(E_OUTOFMEMORY); }
            catch (...) { report(E_FAIL); }
        }) {}
    ~Capture() { thread_.request_stop(); thread_.join(); }

private:
    void report(HRESULT result) const {
        callback_(nullptr, 0, static_cast<std::int32_t>(result), context_);
    }

    void run(std::stop_token stop) {
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(hr)) { report(hr); return; }
        // Release all interfaces before leaving the COM apartment, including failures.
        struct Apartment { ~Apartment() { CoUninitialize(); } } apartment;
        auto fail = [this](HRESULT result) { report(result); };

        auto handler = Microsoft::WRL::Make<ActivationHandler>();
        if (!handler || !handler->ready()) { fail(E_OUTOFMEMORY); return; }
        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        // HTML/WebRTC audio is owned by WebView2's actual process group, which
        // may outlive/reparent away from the current Tauri host process.
        params.ProcessLoopbackParams.TargetProcessId = excluded_process_;
        params.ProcessLoopbackParams.ProcessLoopbackMode =
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
        PROPVARIANT activation{};
        activation.vt = VT_BLOB;
        activation.blob.cbSize = sizeof(params);
        activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                         __uuidof(IAudioClient), &activation,
                                         handler.Get(), &operation);
        if (FAILED(hr)) { fail(hr); return; }
        for (int attempt = 0; ; ++attempt) {
            if (stop.stop_requested()) return;
            const auto waited = WaitForSingleObject(handler->ready(), 50);
            if (waited == WAIT_OBJECT_0) break;
            if (waited == WAIT_FAILED) { fail(HRESULT_FROM_WIN32(GetLastError())); return; }
            if (attempt >= 299) { fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT)); return; }
        }
        hr = handler->result();
        if (FAILED(hr)) { fail(hr); return; }
        auto client = handler->client();
        WAVEFORMATEX format{};
        // WASAPI's mixer uses float samples. Convert explicitly at our boundary,
        // rather than relying on driver-specific PCM16 conversion.
        format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        format.nChannels = 2;
        format.nSamplesPerSec = 48000;
        format.wBitsPerSample = 32;
        format.nBlockAlign = 8;
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_LOOPBACK |
                                AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                                0, 0, &format, nullptr);
        if (FAILED(hr)) { fail(hr); return; }
        ComPtr<IAudioCaptureClient> capture;
        hr = client->GetService(IID_PPV_ARGS(&capture));
        if (FAILED(hr)) { fail(hr); return; }
        struct EventHandle { HANDLE value; ~EventHandle() { if (value) CloseHandle(value); } } event{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
        HANDLE ready = event.value;
        if (!ready) { fail(HRESULT_FROM_WIN32(GetLastError())); return; }
        hr = client->SetEventHandle(ready);
        if (SUCCEEDED(hr)) hr = client->Start();
        if (FAILED(hr)) { fail(hr); return; }
        struct StartedClient { IAudioClient* client; ~StartedClient() { client->Stop(); } } started{client.Get()};

        std::vector<std::int16_t> pending;
        pending.reserve(1920);
        while (!stop.stop_requested()) {
            const DWORD waited = WaitForSingleObject(ready, 100);
            if (waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) { report(HRESULT_FROM_WIN32(GetLastError())); break; }
            UINT32 frames = 0;
            while (SUCCEEDED(hr = capture->GetNextPacketSize(&frames)) && frames > 0) {
                BYTE* data = nullptr;
                DWORD flags = 0;
                UINT64 position = 0, timestamp = 0;
                hr = capture->GetBuffer(&data, &frames, &flags, &position, &timestamp);
                if (FAILED(hr)) break;
                struct Packet {
                    IAudioCaptureClient* capture;
                    UINT32 frames;
                    bool released = false;
                    ~Packet() { if (!released) capture->ReleaseBuffer(frames); }
                } packet{capture.Get(), frames};
                const size_t old_size = pending.size();
                pending.resize(old_size + static_cast<size_t>(frames) * 2);
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    std::fill(pending.begin() + static_cast<ptrdiff_t>(old_size), pending.end(), 0);
                } else {
                    const auto* input = reinterpret_cast<const float*>(data);
                    for (size_t i = 0; i < static_cast<size_t>(frames) * 2; ++i) {
                        const float sample = std::isfinite(input[i]) ? std::clamp(input[i], -1.0f, 1.0f) : 0.0f;
                        pending[old_size + i] = static_cast<std::int16_t>(std::lround(sample * 32767.0f));
                    }
                }
                hr = capture->ReleaseBuffer(frames);
                packet.released = true;
                if (FAILED(hr)) break;
                constexpr size_t chunk_samples = 960 * 2; // 20 ms, stereo at 48 kHz.
                while (pending.size() >= chunk_samples) {
                    callback_(pending.data(), 960, 0, context_);
                    pending.erase(pending.begin(), pending.begin() + chunk_samples);
                }
            }
            if (FAILED(hr)) { report(hr); break; }
        }
    }

    DWORD excluded_process_;
    PacketCallback callback_;
    void* context_;
    std::jthread thread_;
};
}

extern "C" void* coherent_loopback_start(std::uint32_t excluded_process, PacketCallback callback, void* context) noexcept {
    if (!callback || !excluded_process) return nullptr;
    try { return new Capture(excluded_process, callback, context); }
    catch (...) { return nullptr; }
}

extern "C" void coherent_loopback_stop(void* capture) {
    delete static_cast<Capture*>(capture);
}
