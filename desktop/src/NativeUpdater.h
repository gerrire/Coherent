#pragma once

#include <QObject>
#include <memory>
#include <atomic>
#include <Velopack.hpp>

class NativeUpdater final : public QObject {
    Q_OBJECT
public:
    explicit NativeUpdater(QObject* parent = nullptr);
    void check(bool manual);
    void install();

signals:
    void statusChanged(const QString& status);

private:
    void download();
    std::shared_ptr<Velopack::UpdateManager> manager_;
    std::shared_ptr<Velopack::UpdateInfo> available_;
    std::atomic_bool busy_{false};
    bool downloaded_ = false;
    QString version_;
};
