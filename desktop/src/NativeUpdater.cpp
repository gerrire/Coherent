#include "NativeUpdater.h"
#include <QCoreApplication>
#include <QMetaObject>
#include <QPointer>
#include <thread>

namespace {
constexpr char kRepository[] = "https://github.com/gerrire/Coherent";
}

NativeUpdater::NativeUpdater(QObject* parent) : QObject(parent) {
    try {
        manager_ = std::make_shared<Velopack::UpdateManager>(
            std::make_unique<Velopack::GithubSource>(kRepository, "", false));
    } catch (const std::exception& e) {
        emit statusChanged(QString::fromUtf8(e.what()));
    }
}

void NativeUpdater::check(bool manual) {
    if (!manager_) {
        if (manual) emit statusChanged(QStringLiteral("Обновления доступны после установки приложения."));
        return;
    }
    if (busy_.exchange(true)) return;
    emit statusChanged(QStringLiteral("Проверяю обновления…"));
    const auto manager = manager_;
    QPointer<NativeUpdater> self(this);
    std::thread([self, manager, manual] {
        std::shared_ptr<Velopack::UpdateInfo> update;
        QString error;
        try {
            auto result = manager->CheckForUpdates();
            if (result) update = std::make_shared<Velopack::UpdateInfo>(std::move(*result));
        } catch (const std::exception& e) {
            if (manual) error = QString::fromUtf8(e.what());
        }
        if (!self) return;
        QMetaObject::invokeMethod(self, [self, update, error] {
            if (!self) return;
            self->busy_.store(false);
            if (!error.isEmpty()) { emit self->statusChanged(error); return; }
            self->available_ = update;
            self->downloaded_ = false;
            if (!update) {
                emit self->statusChanged(QStringLiteral("Установлена последняя версия."));
            } else {
                self->version_ = QString::fromStdString(update->TargetFullRelease.Version);
                emit self->statusChanged(QStringLiteral("Доступна версия %1. Нажми «Установить».")
                                             .arg(self->version_));
            }
        }, Qt::QueuedConnection);
    }).detach();
}

void NativeUpdater::install() {
    if (!available_ || busy_.load()) {
        check(true);
        return;
    }
    if (!downloaded_) { download(); return; }
    if (busy_.exchange(true)) return;
    emit statusChanged(QStringLiteral("Устанавливаю обновление…"));
    const auto manager = manager_;
    const auto update = available_;
    QPointer<NativeUpdater> self(this);
    std::thread([self, manager, update] {
        QString error;
        try { manager->WaitExitThenApplyUpdates(*update, false, true); }
        catch (const std::exception& e) { error = QString::fromUtf8(e.what()); }
        if (!self) return;
        QMetaObject::invokeMethod(self, [self, error] {
            if (!self) return;
            self->busy_.store(false);
            if (error.isEmpty()) QCoreApplication::quit();
            else emit self->statusChanged(error);
        }, Qt::QueuedConnection);
    }).detach();
}

void NativeUpdater::download() {
    if (!available_ || busy_.exchange(true)) return;
    emit statusChanged(QStringLiteral("Скачиваю обновление…"));
    const auto manager = manager_;
    const auto update = available_;
    QPointer<NativeUpdater> self(this);
    std::thread([self, manager, update] {
        QString error;
        try {
            manager->DownloadUpdates(*update, nullptr, nullptr);
        } catch (const std::exception& e) { error = QString::fromUtf8(e.what()); }
        if (!self) return;
        QMetaObject::invokeMethod(self, [self, error] {
            if (!self) return;
            self->busy_.store(false);
            if (error.isEmpty()) {
                self->downloaded_ = true;
                emit self->statusChanged(QStringLiteral("Загружено. Нажми «Установить» для перезапуска."));
            } else emit self->statusChanged(error);
        }, Qt::QueuedConnection);
    }).detach();
}
