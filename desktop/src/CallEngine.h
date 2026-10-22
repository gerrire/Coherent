#pragma once

#include <QObject>
#include <QImage>
#include <QMutex>
#include <QThread>
#include <QCamera>
#include <QScreenCapture>
#include <QMediaCaptureSession>
#include <QVideoSink>
#include <QVideoFrame>
#include <QQuickImageProvider>
#include <QVariantList>
#include <QHash>
#include <atomic>

class RtcWorker;

class CallEngine final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString roomId READ roomId NOTIFY stateChanged)
    Q_PROPERTY(bool connected READ connected NOTIFY stateChanged)
    Q_PROPERTY(bool microphoneOn READ microphoneOn NOTIFY stateChanged)
    Q_PROPERTY(bool cameraOn READ cameraOn NOTIFY stateChanged)
    Q_PROPERTY(bool screenOn READ screenOn NOTIFY stateChanged)
    Q_PROPERTY(bool systemAudioOn READ systemAudioOn NOTIFY stateChanged)
    Q_PROPERTY(int videoRevision READ videoRevision NOTIFY frameChanged)
    Q_PROPERTY(QString remoteName READ remoteName NOTIFY stateChanged)
    Q_PROPERTY(QVariantList remoteStreams READ remoteStreams NOTIFY frameChanged)
    Q_PROPERTY(QVariantList microphones READ microphones NOTIFY devicesChanged)
    Q_PROPERTY(QVariantList speakers READ speakers NOTIFY devicesChanged)
    Q_PROPERTY(QVariantList cameras READ cameras NOTIFY devicesChanged)
    Q_PROPERTY(QString selectedMicrophoneId READ selectedMicrophoneId NOTIFY devicesChanged)
    Q_PROPERTY(QString selectedSpeakerId READ selectedSpeakerId NOTIFY devicesChanged)
    Q_PROPERTY(QString selectedCameraId READ selectedCameraId NOTIFY devicesChanged)
    Q_PROPERTY(int screenBitrateMbps READ screenBitrateMbps NOTIFY stateChanged)
public:
    explicit CallEngine(QObject* parent = nullptr);
    ~CallEngine() override;
    QString roomId() const { return roomId_; }
    bool connected() const { return connected_; }
    bool microphoneOn() const { return microphoneOn_; }
    bool cameraOn() const { return cameraOn_; }
    bool screenOn() const { return screenOn_; }
    bool systemAudioOn() const { return systemAudioOn_; }
    int videoRevision() const { return videoRevision_; }
    QString remoteName() const { return remoteName_; }
    QVariantList remoteStreams() const { return remoteStreams_; }
    QVariantList microphones() const { return microphones_; }
    QVariantList speakers() const { return speakers_; }
    QVariantList cameras() const { return cameras_; }
    QString selectedMicrophoneId() const { return selectedMicrophoneId_; }
    QString selectedSpeakerId() const { return selectedSpeakerId_; }
    QString selectedCameraId() const { return selectedCameraId_; }
    int screenBitrateMbps() const { return screenBitrateMbps_; }
    QImage frame(const QString& key) const;
    Q_INVOKABLE QVariantList screens() const;
    Q_INVOKABLE void join(const QString& id, const QString& serverUrl, const QString& token);
    Q_INVOKABLE void leave();
    Q_INVOKABLE void toggleMicrophone();
    Q_INVOKABLE void toggleCamera();
    Q_INVOKABLE void toggleScreen(int screenIndex);
    Q_INVOKABLE void toggleSystemAudio();
    Q_INVOKABLE void refreshDevices();
    Q_INVOKABLE void selectMicrophone(const QString& id);
    Q_INVOKABLE void selectSpeaker(const QString& id);
    Q_INVOKABLE void selectCamera(const QString& id);
    Q_INVOKABLE void setScreenBitrateMbps(int value);

    void receiveRemoteFrame(const QString& key, const QString& name,
                            const QString& source, const QImage& image);
    void removeRemoteStream(const QString& key);
    void receiveConnected(bool connected, const QString& error = {});
    void receiveAudioDevices(const QVariantList& microphones, const QVariantList& speakers);

signals:
    void stateChanged();
    void frameChanged();
    void devicesChanged();
    void errorOccurred(const QString& message);

private:
    void sendFrame(bool screen, const QVideoFrame& frame);
    void stopVideo();

    QThread workerThread_;
    RtcWorker* worker_ = nullptr;
    QString roomId_;
    QString remoteName_;
    bool connected_ = false;
    bool microphoneOn_ = true;
    bool cameraOn_ = false;
    bool screenOn_ = false;
    bool systemAudioOn_ = true;
    int videoRevision_ = 0;
    mutable QMutex frameMutex_;
    QHash<QString, QImage> remoteFrames_;
    QVariantList remoteStreams_;
    QVariantList microphones_;
    QVariantList speakers_;
    QVariantList cameras_;
    QString selectedMicrophoneId_;
    QString selectedSpeakerId_;
    QString selectedCameraId_;
    int screenBitrateMbps_ = 20;
    std::atomic_bool cameraFrameQueued_{false};
    std::atomic_bool screenFrameQueued_{false};
    QCamera* camera_ = nullptr;
    QScreenCapture* screenCapture_ = nullptr;
    QMediaCaptureSession cameraSession_;
    QMediaCaptureSession screenSession_;
    QVideoSink cameraSink_;
    QVideoSink screenSink_;
};

class RemoteFrameProvider final : public QQuickImageProvider {
public:
    explicit RemoteFrameProvider(CallEngine* engine)
        : QQuickImageProvider(QQuickImageProvider::Image), engine_(engine) {}
    QImage requestImage(const QString& id, QSize* size, const QSize& requestedSize) override {
        const QString key = id.section('/', 0, 0);
        QImage image = engine_->frame(key);
        if (size) *size = image.size();
        if (requestedSize.isValid()) return image.scaled(requestedSize, Qt::KeepAspectRatio, Qt::SmoothTransformation);
        return image;
    }
private:
    CallEngine* engine_;
};
