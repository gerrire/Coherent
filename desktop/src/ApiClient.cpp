#include "ApiClient.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QFileInfo>
#include <QStringList>
#include <QNetworkCookie>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QStandardPaths>
#include <QUrl>

#include <windows.h>
#include <wincrypt.h>

namespace {
class ProtectedCookieJar final : public QNetworkCookieJar {
public:
    explicit ProtectedCookieJar(QObject* parent) : QNetworkCookieJar(parent) {
        const QString location = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
        filePath_ = QDir(location).filePath("session.dat");
        QFile file(filePath_);
        if (!file.open(QIODevice::ReadOnly)) return;
        const QByteArray encrypted = file.readAll();
        DATA_BLOB input{static_cast<DWORD>(encrypted.size()),
                        reinterpret_cast<BYTE*>(const_cast<char*>(encrypted.constData()))};
        DATA_BLOB output{};
        if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, 0, &output)) return;
        QByteArray plain(reinterpret_cast<const char*>(output.pbData), static_cast<qsizetype>(output.cbData));
        LocalFree(output.pbData);
        QList<QNetworkCookie> cookies;
        for (const QByteArray& line : plain.split('\n')) {
            if (line.isEmpty()) continue;
            cookies.append(QNetworkCookie::parseCookies(line));
        }
        setAllCookies(cookies);
    }

    bool setCookiesFromUrl(const QList<QNetworkCookie>& cookies, const QUrl& url) override {
        const bool changed = QNetworkCookieJar::setCookiesFromUrl(cookies, url);
        if (changed) save();
        return changed;
    }

    void save() {
        QByteArray plain;
        for (const auto& cookie : allCookies()) {
            // Session cookies are deliberately stored to make the desktop login persistent.
            plain += cookie.toRawForm(QNetworkCookie::Full);
            plain += '\n';
        }
        DATA_BLOB input{static_cast<DWORD>(plain.size()),
                        reinterpret_cast<BYTE*>(plain.data())};
        DATA_BLOB output{};
        if (!CryptProtectData(&input, L"Coherent session", nullptr, nullptr, nullptr, 0, &output))
            return;
        QDir().mkpath(QFileInfo(filePath_).absolutePath());
        QFile file(filePath_);
        if (file.open(QIODevice::WriteOnly | QIODevice::Truncate))
            file.write(reinterpret_cast<const char*>(output.pbData), static_cast<qint64>(output.cbData));
        LocalFree(output.pbData);
    }

private:
    QString filePath_;
};

QString responseError(const QJsonObject& object, int code) {
    const QJsonValue detail = object.value("detail");
    if (detail.isString()) return detail.toString();
    if (detail.isArray()) {
        QStringList messages;
        for (const auto& item : detail.toArray()) {
            const QString message = item.toObject().value("msg").toString();
            if (!message.isEmpty()) messages << message;
        }
        if (!messages.isEmpty()) return messages.join(". ");
    }
    if (code == 401) return QStringLiteral("Войди в аккаунт ещё раз.");
    return QStringLiteral("Не удалось связаться с сервером.");
}
}

ApiClient::ApiClient(QObject* parent) : QObject(parent) {
    const QByteArray configured = qgetenv("COHERENT_API_BASE_URL");
    baseUrl_ = configured.isEmpty() ? QStringLiteral("https://coherent-web.ru")
                                    : QString::fromUtf8(configured).trimmed();
    if (baseUrl_.endsWith('/')) baseUrl_.chop(1);
    network_.setCookieJar(new ProtectedCookieJar(&network_));
    reconnect_.setInterval(3000);
    reconnect_.setSingleShot(true);
    connect(&reconnect_, &QTimer::timeout, this, &ApiClient::connectEvents);
    connect(&events_, &QWebSocket::connected, this, [this] {
        reconnect_.stop();
        emit connectionChanged(true);
    });
    connect(&events_, &QWebSocket::disconnected, this, [this] {
        emit connectionChanged(false);
        if (eventsEnabled_) reconnect_.start();
    });
    connect(&events_, &QWebSocket::textMessageReceived, this, [this](const QString& text) {
        const QJsonDocument doc = QJsonDocument::fromJson(text.toUtf8());
        if (doc.isObject()) emit eventReceived(doc.object());
    });
}

QUrl ApiClient::urlFor(const QString& path) const {
    return QUrl(baseUrl_ + path);
}

void ApiClient::ensureCsrf(std::function<void(bool)> callback) {
    if (!csrfToken_.isEmpty()) { callback(true); return; }
    send("GET", "/api/v1/auth/csrf", {}, [this, callback = std::move(callback)](
        const QJsonObject& result, const QString& error) {
        csrfToken_ = result.value("csrf_token").toString();
        callback(error.isEmpty() && !csrfToken_.isEmpty());
    });
}

void ApiClient::request(const QByteArray& method, const QString& path, const QJsonObject& body, Reply callback) {
    if (method == "GET") {
        send(method, path, body, std::move(callback));
    } else {
        ensureCsrf([this, method, path, body, callback = std::move(callback)](bool ok) {
            if (!ok) { callback({}, QStringLiteral("Не удалось получить защитный токен.")); return; }
            send(method, path, body, callback);
        });
    }
}

void ApiClient::send(const QByteArray& method, const QString& path, const QJsonObject& body, Reply callback) {
    QNetworkRequest request(urlFor(path));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("Accept", "application/json");
    if (method != "GET") request.setRawHeader("X-CSRF-Token", csrfToken_.toUtf8());
    const QByteArray payload = body.isEmpty() ? QByteArray() : QJsonDocument(body).toJson(QJsonDocument::Compact);
    QNetworkReply* reply = network_.sendCustomRequest(request, method, payload);
    connect(reply, &QNetworkReply::finished, this, [reply, callback = std::move(callback)] {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QJsonDocument document = QJsonDocument::fromJson(reply->readAll());
        const QJsonObject response = document.isObject() ? document.object()
            : document.isArray() ? QJsonObject{{"items", document.array()}} : QJsonObject{};
        const QString error = reply->error() == QNetworkReply::NoError && status < 400
                                  ? QString{} : responseError(response, status);
        reply->deleteLater();
        callback(response, error);
    });
}

void ApiClient::connectEvents() {
    eventsEnabled_ = true;
    if (events_.state() != QAbstractSocket::UnconnectedState) return;
    QUrl ws = urlFor("/api/v1/conversations/events");
    ws.setScheme(ws.scheme() == "https" ? "wss" : "ws");
    QNetworkRequest request(ws);
    request.setRawHeader("Origin", baseUrl_.toUtf8());
    const auto cookies = network_.cookieJar()->cookiesForUrl(urlFor("/"));
    QByteArray cookieHeader;
    for (const auto& cookie : cookies) {
        if (!cookieHeader.isEmpty()) cookieHeader += "; ";
        cookieHeader += cookie.toRawForm(QNetworkCookie::NameAndValueOnly);
    }
    request.setRawHeader("Cookie", cookieHeader);
    events_.open(request);
}

void ApiClient::closeEvents() {
    eventsEnabled_ = false;
    reconnect_.stop();
    events_.close();
}
