#include "ProcessLoopbackCapture.h"

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <wrl/implements.h>
#include <livekit/audio_source.h>
#include <livekit/audio_frame.h>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace {
class ActivationHandler final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
public:
    ActivationHandler() : completed_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
    ~ActivationHandler() { if (completed_) CloseHandle(completed_); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> unknown;
        HRESULT result = E_FAIL;
        const HRESULT call = operation->GetActivateResult(&result, &unknown);
        result_ = FAILED(call) ? call : result;
        if (SUCCEEDED(result_) && unknown)
            result_ = unknown.As(&client_);
        SetEvent(completed_);
        return S_OK;
    }
    HANDLE event() const { return completed_; }
    HRESULT result() const { return result_; }
    ComPtr<IAudioClient> client() const { return client_; }
private:
    HANDLE completed_ = nullptr;
    HRESULT result_ = E_PENDING;
    ComPtr<IAudioClient> client_;
};

QString hresultError(HRESULT hr) {
    return QStringLiteral("Системный звук Windows недоступен (0x%1).")
        .arg(static_cast<quint32>(hr), 8, 16, QLatin1Char('0'));
}
}

ProcessLoopbackCapture::~ProcessLoopbackCapture() { stop(); }
void ProcessLoopbackCapture::start(std::shared_ptr<livekit::AudioSource> source,
                                   ErrorHandler errorHandler) {
    stop();
    thread_ = std::jthread([this, source = std::move(source),
                            errorHandler = std::move(errorHandler)](std::stop_token token) {
        run(token, source, errorHandler);
    });
}
void ProcessLoopbackCapture::stop() {
    if (thread_.joinable()) {
        thread_.request_stop();
        thread_.join();
    }
}

void ProcessLoopbackCapture::run(std::stop_token stopToken,
                                 std::shared_ptr<livekit::AudioSource> source,
                                 ErrorHandler errorHandler) {
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(com)) { errorHandler(hresultError(com)); return; }
    auto fail = [&](HRESULT hr) {
        errorHandler(hresultError(hr));
        CoUninitialize();
    };
    auto handler = Make<ActivationHandler>();
    if (!handler || !handler->event()) { fail(E_OUTOFMEMORY); return; }

    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT activation{};
    activation.vt = VT_BLOB;
    activation.blob.cbSize = sizeof(params);
    activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                             __uuidof(IAudioClient), &activation,
                                             handler.Get(), &operation);
    if (FAILED(hr)) { fail(hr); return; }
    if (WaitForSingleObject(handler->event(), 15000) != WAIT_OBJECT_0) {
        fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
        return;
    }
    hr = handler->result();
    if (FAILED(hr)) { fail(hr); return; }
    const ComPtr<IAudioClient> client = handler->client();
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 4;
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
    HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ready) { fail(HRESULT_FROM_WIN32(GetLastError())); return; }
    hr = client->SetEventHandle(ready);
    if (SUCCEEDED(hr)) hr = client->Start();
    if (FAILED(hr)) {
        CloseHandle(ready);
        fail(hr);
        return;
    }

    std::vector<std::int16_t> pending;
    pending.reserve(960 * 2);
    while (!stopToken.stop_requested()) {
        const DWORD wait = WaitForSingleObject(ready, 100);
        if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) break;
        UINT32 count = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&count)) && count > 0) {
            BYTE* data = nullptr;
            DWORD flags = 0;
            UINT64 position = 0, timestamp = 0;
            hr = capture->GetBuffer(&data, &count, &flags, &position, &timestamp);
            if (FAILED(hr)) break;
            const size_t sampleCount = static_cast<size_t>(count) * 2;
            const size_t oldSize = pending.size();
            pending.resize(oldSize + sampleCount);
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT)
                std::fill(pending.begin() + static_cast<ptrdiff_t>(oldSize), pending.end(), 0);
            else
                std::memcpy(pending.data() + oldSize, data, sampleCount * sizeof(std::int16_t));
            capture->ReleaseBuffer(count);
            constexpr size_t kSamplesPerFrame = 480 * 2;
            while (pending.size() >= kSamplesPerFrame) {
                std::vector<std::int16_t> samples(pending.begin(),
                                                   pending.begin() + kSamplesPerFrame);
                pending.erase(pending.begin(), pending.begin() + kSamplesPerFrame);
                try {
                    livekit::AudioFrame frame(std::move(samples), 48000, 2, 480);
                    source->captureFrame(frame, 100);
                } catch (const std::exception& e) {
                    errorHandler(QString::fromUtf8(e.what()));
                    break;
                }
            }
        }
        if (FAILED(hr)) { errorHandler(hresultError(hr)); break; }
    }
    client->Stop();
    CloseHandle(ready);
    CoUninitialize();
}
