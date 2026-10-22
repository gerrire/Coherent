#pragma once

#include <QObject>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkCookieJar>
#include <QWebSocket>
#include <QTimer>
#include <functional>

class ApiClient final : public QObject {
    Q_OBJECT
public:
    using Reply = std::function<void(const QJsonObject&, const QString&)>;
    explicit ApiClient(QObject* parent = nullptr);
    void request(const QByteArray& method, const QString& path, const QJsonObject& body, Reply callback);
    void connectEvents();
    void closeEvents();
    QString baseUrl() const { return baseUrl_; }

signals:
    void eventReceived(const QJsonObject& event);
    void connectionChanged(bool connected);

private:
    void send(const QByteArray& method, const QString& path, const QJsonObject& body, Reply callback);
    void ensureCsrf(std::function<void(bool)> callback);
    QUrl urlFor(const QString& path) const;

    QNetworkAccessManager network_;
    QWebSocket events_;
    QTimer reconnect_;
    QString baseUrl_;
    QString csrfToken_;
    bool eventsEnabled_ = false;
};
