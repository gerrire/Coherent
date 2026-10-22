#include "CallEngine.h"
#include "ProcessLoopbackCapture.h"

#include <QGuiApplication>
#include <QMediaDevices>
#include <QScreen>
#include <QSettings>
#include <QVideoFrame>
#include <QByteArray>

#include <livekit/livekit.h>
#include <livekit/platform_audio.h>
#include <livekit/room_delegate.h>
#include <livekit/remote_participant.h>
#include <livekit/remote_track_publication.h>

#include <cstring>
#include <algorithm>
#include <memory>

namespace {
constexpr int kMaxVideoWidth = 1920;
constexpr int kMaxVideoHeight = 1080;
QString streamKey(const std::string& identity, const std::string& track) {
    return QString::fromLatin1(QByteArray::fromStdString(identity + "/" + track)
        .toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}
}

class RtcWorker final : public QObject, public livekit::RoomDelegate {
public:
    explicit RtcWorker(CallEngine* owner) : owner_(owner) {}

    void refreshDevices() {
        try {
            if (!audio_) audio_ = std::make_unique<livekit::PlatformAudio>();
            QVariantList microphones, speakers;
            for (const auto& device : audio_->recordingDevices())
                microphones.append(QVariantMap{{"id", QString::fromStdString(device.id)},
                                               {"name", QString::fromStdString(device.name)}});
            for (const auto& device : audio_->playoutDevices())
                speakers.append(QVariantMap{{"id", QString::fromStdString(device.id)},
                                            {"name", QString::fromStdString(device.name)}});
            QMetaObject::invokeMethod(owner_, [owner = owner_, microphones, speakers] {
                owner->receiveAudioDevices(microphones, speakers);
            }, Qt::QueuedConnection);
        } catch (const std::exception& e) { report(e.what()); }
    }

    void selectMicrophone(const QString& id) {
        recordingDeviceId_ = id.toStdString();
        try { if (audio_ && !recordingDeviceId_.empty()) audio_->setRecordingDevice(recordingDeviceId_); }
        catch (const std::exception& e) { report(e.what()); }
    }
    void selectSpeaker(const QString& id) {
        playoutDeviceId_ = id.toStdString();
        try { if (audio_ && !playoutDeviceId_.empty()) audio_->setPlayoutDevice(playoutDeviceId_); }
        catch (const std::exception& e) { report(e.what()); }
    }
    void setScreenBitrateMbps(int value) { screenBitrateMbps_ = value; }

    void join(const QString& serverUrl, const QString& token) {
        try {
            if (room_) leave();
            if (!audio_) audio_ = std::make_unique<livekit::PlatformAudio>();
            try {
                if (!recordingDeviceId_.empty()) audio_->setRecordingDevice(recordingDeviceId_);
                if (!playoutDeviceId_.empty()) audio_->setPlayoutDevice(playoutDeviceId_);
            } catch (const std::exception& e) { report(e.what()); }
            room_ = std::make_unique<livekit::Room>();
            room_->setDelegate(this);
            livekit::RoomOptions options;
            options.auto_subscribe = true;
            if (!room_->connect(serverUrl.toStdString(), token.toStdString(), options))
                throw std::runtime_error("LiveKit не принял подключение.");
            microphoneSource_ = audio_->createAudioSource({});
            microphoneTrack_ = livekit::LocalAudioTrack::createLocalAudioTrack("microphone", microphoneSource_);
            if (auto participant = room_->localParticipant().lock()) {
                livekit::TrackPublishOptions publish;
                publish.source = livekit::TrackSource::SOURCE_MICROPHONE;
                participant->publishTrack(microphoneTrack_, publish);
                if (!microphoneOn_) microphoneTrack_->mute();
            }
            QMetaObject::invokeMethod(owner_, [owner = owner_] { owner->receiveConnected(true); },
                                      Qt::QueuedConnection);
        } catch (const std::exception& e) {
            const QString message = QString::fromUtf8(e.what());
            leave();
            QMetaObject::invokeMethod(owner_, [owner = owner_, message] {
                owner->receiveConnected(false, message);
            }, Qt::QueuedConnection);
        }
    }

    void leave() {
        stopSystemAudio();
        cameraTrack_.reset();
        screenTrack_.reset();
        cameraSource_.reset();
        screenSource_.reset();
        microphoneTrack_.reset();
        microphoneSource_.reset();
        if (room_) { room_->disconnect(); room_.reset(); }
        audio_.reset();
        QMetaObject::invokeMethod(owner_, [owner = owner_] { owner->receiveConnected(false); },
                                  Qt::QueuedConnection);
    }

    void setMicrophone(bool enabled) {
        microphoneOn_ = enabled;
        if (!microphoneTrack_) return;
        try {
            if (enabled) microphoneTrack_->unmute(); else microphoneTrack_->mute();
        } catch (const std::exception& e) { report(e.what()); }
    }

    void setSystemAudio(bool enabled) {
        if (!enabled) { stopSystemAudio(); return; }
        if (!room_ || systemAudioTrack_) return;
        try {
            systemAudioSource_ = std::make_shared<livekit::AudioSource>(48000, 2);
            systemAudioTrack_ = livekit::LocalAudioTrack::createLocalAudioTrack(
                "system-audio", systemAudioSource_);
            if (auto participant = room_->localParticipant().lock()) {
                livekit::TrackPublishOptions publish;
                publish.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
                participant->publishTrack(systemAudioTrack_, publish);
            }
            systemCapture_ = std::make_unique<ProcessLoopbackCapture>();
            systemCapture_->start(systemAudioSource_, [this](const QString& message) {
                const std::string utf8 = message.toStdString();
                report(utf8);
            });
        } catch (const std::exception& e) {
            stopSystemAudio();
            report(e.what());
        }
    }

    void stopSystemAudio() {
        if (systemCapture_) {
            systemCapture_->stop();
            systemCapture_.reset();
        }
        if (systemAudioTrack_ && room_) {
            try {
                if (auto participant = room_->localParticipant().lock()) {
                    if (auto publication = systemAudioTrack_->publication())
                        participant->unpublishTrack(publication->sid());
                }
            } catch (const std::exception& e) { report(e.what()); }
        }
        systemAudioTrack_.reset();
        systemAudioSource_.reset();
    }

    void stopVideo(bool screen) {
        auto& track = screen ? screenTrack_ : cameraTrack_;
        auto& source = screen ? screenSource_ : cameraSource_;
        if (track && room_) {
            try {
                if (auto participant = room_->localParticipant().lock()) {
                    if (auto publication = track->publication())
                        participant->unpublishTrack(publication->sid());
                }
            } catch (const std::exception& e) { report(e.what()); }
        }
        track.reset();
        source.reset();
    }

    void capture(bool screen, const QImage& input) {
        if (!room_ || input.isNull()) return;
        try {
            auto& source = screen ? screenSource_ : cameraSource_;
            auto& track = screen ? screenTrack_ : cameraTrack_;
            int& width = screen ? screenWidth_ : cameraWidth_;
            int& height = screen ? screenHeight_ : cameraHeight_;
            if (!source) {
                const double scale = std::min({1.0,
                    static_cast<double>(kMaxVideoWidth) / input.width(),
                    static_cast<double>(kMaxVideoHeight) / input.height()});
                width = std::max(2, static_cast<int>(input.width() * scale) & ~1);
                height = std::max(2, static_cast<int>(input.height() * scale) & ~1);
                source = std::make_shared<livekit::VideoSource>(width, height);
                track = livekit::LocalVideoTrack::createLocalVideoTrack(
                    screen ? "screen" : "camera", source);
                if (auto participant = room_->localParticipant().lock()) {
                    livekit::TrackPublishOptions publish;
                    publish.source = screen ? livekit::TrackSource::SOURCE_SCREENSHARE
                                            : livekit::TrackSource::SOURCE_CAMERA;
                    publish.video_encoding = livekit::VideoEncodingOptions{
                        screen ? static_cast<std::uint64_t>(screenBitrateMbps_) * 1'000'000ull
                               : 8'000'000ull, 30.0};
                    publish.degradation_preference =
                        livekit::DegradationPreference::MaintainResolution;
                    participant->publishTrack(track, publish);
                }
            }
            const QImage image = input.scaled(width, height, Qt::IgnoreAspectRatio,
                                              Qt::FastTransformation)
                                        .convertToFormat(QImage::Format_RGBA8888);
            std::vector<std::uint8_t> bytes(static_cast<size_t>(width) * height * 4);
            std::memcpy(bytes.data(), image.constBits(), bytes.size());
            livekit::VideoFrame frame(width, height, livekit::VideoBufferType::RGBA,
                                      std::move(bytes));
            source->captureFrame(frame);
        } catch (const std::exception& e) { report(e.what()); }
    }

    void onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) override {
        if (!event.track || !event.participant || !event.publication ||
            event.track->kind() != livekit::TrackKind::KIND_VIDEO) return;
        const std::string identity = event.participant->identity();
        const std::string name = event.publication->name();
        const QString key = streamKey(identity, name);
        const QString kind = event.publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE
            ? QStringLiteral("screen") : QStringLiteral("camera");
        const QString displayName = QString::fromStdString(event.participant->name().empty()
            ? identity : event.participant->name());
        room.setOnVideoFrameCallback(identity, name,
            [owner = owner_, key, displayName, kind](const livekit::VideoFrame& frame, std::int64_t) {
                try {
                    auto rgba = frame.type() == livekit::VideoBufferType::RGBA
                                    ? nullptr : std::make_unique<livekit::VideoFrame>(
                                          frame.convert(livekit::VideoBufferType::RGBA));
                    const livekit::VideoFrame& view = rgba ? *rgba : frame;
                    QImage image(view.data(), view.width(), view.height(),
                                 view.width() * 4, QImage::Format_RGBA8888);
                    QImage copy = image.copy();
                    QMetaObject::invokeMethod(owner, [owner, key, displayName, kind, copy] {
                        owner->receiveRemoteFrame(key, displayName, kind, copy);
                    }, Qt::QueuedConnection);
                } catch (...) {}
            });
    }
    void onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) override {
        if (event.participant && event.publication &&
            event.track && event.track->kind() == livekit::TrackKind::KIND_VIDEO) {
            const QString key = streamKey(event.participant->identity(), event.publication->name());
            room.clearOnVideoFrameCallback(event.participant->identity(), event.publication->name());
            QMetaObject::invokeMethod(owner_, [owner = owner_, key] {
                owner->removeRemoteStream(key);
            }, Qt::QueuedConnection);
        }
    }
    void onDisconnected(livekit::Room&, const livekit::DisconnectedEvent&) override {
        QMetaObject::invokeMethod(owner_, [owner = owner_] { owner->receiveConnected(false); },
                                  Qt::QueuedConnection);
    }
private:
    void report(const std::string& message) {
        const QString text = QString::fromStdString(message);
        QMetaObject::invokeMethod(owner_, [owner = owner_, text] {
            emit owner->errorOccurred(text);
        }, Qt::QueuedConnection);
    }
    CallEngine* owner_;
    std::unique_ptr<livekit::Room> room_;
    std::unique_ptr<livekit::PlatformAudio> audio_;
    std::shared_ptr<livekit::PlatformAudioSource> microphoneSource_;
    std::shared_ptr<livekit::LocalAudioTrack> microphoneTrack_;
    std::shared_ptr<livekit::AudioSource> systemAudioSource_;
    std::shared_ptr<livekit::LocalAudioTrack> systemAudioTrack_;
    std::unique_ptr<ProcessLoopbackCapture> systemCapture_;
    std::shared_ptr<livekit::VideoSource> cameraSource_;
    std::shared_ptr<livekit::VideoSource> screenSource_;
    std::shared_ptr<livekit::LocalVideoTrack> cameraTrack_;
    std::shared_ptr<livekit::LocalVideoTrack> screenTrack_;
    int cameraWidth_ = 0;
    int cameraHeight_ = 0;
    int screenWidth_ = 0;
    int screenHeight_ = 0;
    bool microphoneOn_ = true;
    int screenBitrateMbps_ = 20;
    std::string recordingDeviceId_;
    std::string playoutDeviceId_;
};

CallEngine::CallEngine(QObject* parent) : QObject(parent) {
    screenBitrateMbps_ = QSettings().value("media/screenBitrateMbps", 20).toInt();
    screenBitrateMbps_ = std::clamp(screenBitrateMbps_, 5, 50);
    worker_ = new RtcWorker(this);
    worker_->moveToThread(&workerThread_);
    connect(&workerThread_, &QThread::finished, worker_, &QObject::deleteLater);
    workerThread_.start();
    QMetaObject::invokeMethod(worker_, [worker = worker_, bitrate = screenBitrateMbps_] {
        worker->setScreenBitrateMbps(bitrate);
    }, Qt::QueuedConnection);
    cameraSession_.setVideoSink(&cameraSink_);
    screenSession_.setVideoSink(&screenSink_);
    connect(&cameraSink_, &QVideoSink::videoFrameChanged, this,
            [this](const QVideoFrame& frame) { sendFrame(false, frame); });
    connect(&screenSink_, &QVideoSink::videoFrameChanged, this,
            [this](const QVideoFrame& frame) { sendFrame(true, frame); });
    refreshDevices();
}
CallEngine::~CallEngine() {
    stopVideo();
    if (workerThread_.isRunning()) {
        QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->leave(); },
                                  Qt::BlockingQueuedConnection);
        workerThread_.quit();
        workerThread_.wait();
    }
}
QImage CallEngine::frame(const QString& key) const {
    QMutexLocker lock(&frameMutex_);
    return remoteFrames_.value(key);
}
QVariantList CallEngine::screens() const {
    QVariantList result;
    for (const QScreen* screen : QGuiApplication::screens()) result.append(screen->name());
    return result;
}
void CallEngine::join(const QString& id, const QString& serverUrl, const QString& token) {
    if (id.isEmpty() || serverUrl.isEmpty() || token.isEmpty() || roomId_ == id) return;
    stopVideo();
    {
        QMutexLocker lock(&frameMutex_);
        remoteFrames_.clear();
    }
    remoteStreams_.clear();
    remoteName_.clear();
    connected_ = false;
    roomId_ = id;
    emit frameChanged();
    emit stateChanged();
    QMetaObject::invokeMethod(worker_, [worker = worker_, serverUrl, token] {
        worker->join(serverUrl, token);
    }, Qt::QueuedConnection);
}
void CallEngine::leave() {
    stopVideo();
    roomId_.clear();
    connected_ = false;
    {
        QMutexLocker lock(&frameMutex_);
        remoteFrames_.clear();
    }
    remoteStreams_.clear();
    remoteName_.clear();
    emit frameChanged();
    emit stateChanged();
    QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->leave(); },
                              Qt::QueuedConnection);
}
void CallEngine::receiveConnected(bool connected, const QString& error) {
    connected_ = connected;
    if (connected && screenOn_ && systemAudioOn_)
        QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->setSystemAudio(true); },
                                  Qt::QueuedConnection);
    if (!connected && !error.isEmpty()) {
        roomId_.clear();
        emit errorOccurred(error);
    }
    emit stateChanged();
}
void CallEngine::receiveAudioDevices(const QVariantList& microphones, const QVariantList& speakers) {
    microphones_ = microphones;
    speakers_ = speakers;
    emit devicesChanged();
}
void CallEngine::receiveRemoteFrame(const QString& key, const QString& name,
                                     const QString& source, const QImage& image) {
    {
        QMutexLocker lock(&frameMutex_);
        remoteFrames_.insert(key, image);
    }
    bool updated = false;
    for (auto& item : remoteStreams_) {
        QVariantMap stream = item.toMap();
        if (stream.value("key").toString() != key) continue;
        stream["width"] = image.width();
        stream["height"] = image.height();
        stream["revision"] = stream.value("revision").toInt() + 1;
        item = stream;
        updated = true;
        break;
    }
    if (!updated) remoteStreams_.append(QVariantMap{
        {"key", key}, {"name", name}, {"source", source},
        {"width", image.width()}, {"height", image.height()}, {"revision", 1}});
    remoteName_ = name;
    ++videoRevision_;
    emit frameChanged();
    emit stateChanged();
}
void CallEngine::removeRemoteStream(const QString& key) {
    {
        QMutexLocker lock(&frameMutex_);
        remoteFrames_.remove(key);
    }
    for (qsizetype i = 0; i < remoteStreams_.size(); ++i) {
        if (remoteStreams_[i].toMap().value("key").toString() == key) {
            remoteStreams_.removeAt(i);
            break;
        }
    }
    emit frameChanged();
}
void CallEngine::toggleMicrophone() {
    microphoneOn_ = !microphoneOn_;
    emit stateChanged();
    const bool enabled = microphoneOn_;
    QMetaObject::invokeMethod(worker_, [worker = worker_, enabled] {
        worker->setMicrophone(enabled);
    }, Qt::QueuedConnection);
}
void CallEngine::toggleCamera() {
    if (cameraOn_) {
        cameraOn_ = false;
        if (camera_) {
            camera_->stop();
            cameraSession_.setCamera(nullptr);
            camera_->deleteLater();
            camera_ = nullptr;
        }
        QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->stopVideo(false); },
                                  Qt::QueuedConnection);
    } else {
        const auto devices = QMediaDevices::videoInputs();
        if (devices.isEmpty()) { emit errorOccurred(QStringLiteral("Камера не найдена.")); return; }
        auto chosen = devices.first();
        for (const auto& device : devices) {
            if (QString::fromLatin1(device.id().toBase64(QByteArray::Base64UrlEncoding |
                    QByteArray::OmitTrailingEquals)) == selectedCameraId_) {
                chosen = device;
                break;
            }
        }
        camera_ = new QCamera(chosen, this);
        cameraSession_.setCamera(camera_);
        cameraOn_ = true;
        camera_->start();
    }
    emit stateChanged();
}
void CallEngine::toggleScreen(int index) {
    if (screenOn_) {
        screenOn_ = false;
        if (screenCapture_) {
            screenCapture_->stop();
            screenSession_.setScreenCapture(nullptr);
            screenCapture_->deleteLater();
            screenCapture_ = nullptr;
        }
        QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->stopVideo(true); },
                                  Qt::QueuedConnection);
        QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->setSystemAudio(false); },
                                  Qt::QueuedConnection);
    } else {
        const auto available = QGuiApplication::screens();
        if (index < 0 || index >= available.size()) {
            emit errorOccurred(QStringLiteral("Экран не найден."));
            return;
        }
        screenCapture_ = new QScreenCapture(this);
        screenCapture_->setScreen(available.at(index));
        screenCapture_->setMaximumFrameRate(30.0);
        screenSession_.setScreenCapture(screenCapture_);
        screenOn_ = true;
        screenCapture_->start();
        if (systemAudioOn_)
            QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->setSystemAudio(true); },
                                      Qt::QueuedConnection);
    }
    emit stateChanged();
}
void CallEngine::toggleSystemAudio() {
    systemAudioOn_ = !systemAudioOn_;
    emit stateChanged();
    if (screenOn_) {
        const bool enabled = systemAudioOn_;
        QMetaObject::invokeMethod(worker_, [worker = worker_, enabled] {
            worker->setSystemAudio(enabled);
        }, Qt::QueuedConnection);
    }
}
void CallEngine::refreshDevices() {
    QVariantList found;
    for (const auto& device : QMediaDevices::videoInputs())
        found.append(QVariantMap{
            {"id", QString::fromLatin1(device.id().toBase64(QByteArray::Base64UrlEncoding |
                 QByteArray::OmitTrailingEquals))}, {"name", device.description()}});
    cameras_ = found;
    emit devicesChanged();
    QMetaObject::invokeMethod(worker_, [worker = worker_] { worker->refreshDevices(); },
                              Qt::QueuedConnection);
}
void CallEngine::selectMicrophone(const QString& id) {
    QMetaObject::invokeMethod(worker_, [worker = worker_, id] { worker->selectMicrophone(id); },
                              Qt::QueuedConnection);
}
void CallEngine::selectSpeaker(const QString& id) {
    QMetaObject::invokeMethod(worker_, [worker = worker_, id] { worker->selectSpeaker(id); },
                              Qt::QueuedConnection);
}
void CallEngine::selectCamera(const QString& id) {
    if (selectedCameraId_ == id) return;
    selectedCameraId_ = id;
    if (cameraOn_) { toggleCamera(); toggleCamera(); }
}
void CallEngine::setScreenBitrateMbps(int value) {
    value = std::clamp(value, 5, 50);
    if (screenBitrateMbps_ == value) return;
    screenBitrateMbps_ = value;
    QSettings().setValue("media/screenBitrateMbps", value);
    QMetaObject::invokeMethod(worker_, [worker = worker_, value] {
        worker->setScreenBitrateMbps(value);
    }, Qt::QueuedConnection);
    emit stateChanged();
}
void CallEngine::sendFrame(bool screen, const QVideoFrame& frame) {
    if (!connected_ || (screen ? !screenOn_ : !cameraOn_)) return;
    auto& pending = screen ? screenFrameQueued_ : cameraFrameQueued_;
    if (pending.exchange(true)) return;
    const QImage image = frame.toImage();
    if (image.isNull()) { pending.store(false); return; }
    QMetaObject::invokeMethod(worker_, [this, worker = worker_, screen, image] {
        worker->capture(screen, image);
        (screen ? screenFrameQueued_ : cameraFrameQueued_).store(false);
    }, Qt::QueuedConnection);
}
void CallEngine::stopVideo() {
    if (cameraOn_) toggleCamera();
    if (screenOn_) toggleScreen(0);
}
