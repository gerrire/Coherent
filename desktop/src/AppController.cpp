#include "AppController.h"
#include "CallEngine.h"
#include "NativeUpdater.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QUrl>

namespace {
QVariantList list(const QJsonValue& value) { return value.toArray().toVariantList(); }
QString apiPath(const QString& value) { return QString::fromUtf8(QUrl::toPercentEncoding(value)); }
}

AppController::AppController(QObject* parent)
    : QObject(parent), api_(this), callEngine_(new CallEngine(this)), updater_(new NativeUpdater(this)) {
    connect(&api_, &ApiClient::eventReceived, this, [this](const QJsonObject& event) {
        const QString type = event.value("type").toString();
        if (type == "message") {
            const auto message = event.value("message").toObject();
            if (event.value("conversation_id").toString() == selectedConversationId_) {
                appendMessage(message);
                markLatestRead();
            }
            refreshConversations();
        } else if (type == "call") {
            refreshCalls();
        } else {
            refreshFriends();
        }
    });
    connect(updater_, &NativeUpdater::statusChanged, this, [this](const QString& status) {
        updateStatus_ = status;
        emit stateChanged();
    });
    connect(callEngine_, &CallEngine::errorOccurred, this, &AppController::setError);
    refreshTimer_.setInterval(30000);
    connect(&refreshTimer_, &QTimer::timeout, this, &AppController::refresh);
    api_.request("GET", "/api/v1/auth/me", {}, [this](const QJsonObject& account, const QString& error) {
        loading_ = false;
        if (error.isEmpty()) onAuthenticated(account);
        emit stateChanged();
    });
    updater_->check(false);
}

AppController::~AppController() = default;
QObject* AppController::callEngine() const { return callEngine_; }

void AppController::setError(const QString& error) {
    error_ = error;
    emit stateChanged();
}
void AppController::clearError() { setError({}); }

void AppController::authenticate(const QString& mode, const QString& username, const QString& password) {
    if (username.trimmed().isEmpty() || password.isEmpty()) {
        setError(QStringLiteral("Введи имя и пароль."));
        return;
    }
    loading_ = true;
    setError({});
    emit stateChanged();
    api_.request("POST", "/api/v1/auth/" + mode,
                 {{"username", username.trimmed()}, {"password", password}},
                 [this](const QJsonObject& response, const QString& error) {
        loading_ = false;
        if (!error.isEmpty()) setError(error);
        else onAuthenticated(response.value("user").toObject());
        emit stateChanged();
    });
}
void AppController::login(const QString& username, const QString& password) {
    authenticate("login", username, password);
}
void AppController::registerUser(const QString& username, const QString& password) {
    authenticate("register", username, password);
}
void AppController::onAuthenticated(const QJsonObject& account) {
    user_ = account.toVariantMap();
    authenticated_ = true;
    api_.connectEvents();
    refreshTimer_.start();
    refresh();
}
void AppController::logout() {
    api_.request("POST", "/api/v1/auth/logout", {}, [this](const QJsonObject&, const QString& error) {
        if (!error.isEmpty()) { setError(error); return; }
        api_.closeEvents();
        refreshTimer_.stop();
        callEngine_->leave();
        authenticated_ = false;
        user_.clear(); conversations_.clear(); messages_.clear();
        friends_.clear(); searchResults_.clear(); currentCall_.clear();
        onlineIds_.clear();
        selectedConversationId_.clear();
        emit stateChanged();
    });
}
void AppController::refresh() {
    if (!authenticated_) return;
    refreshConversations();
    refreshFriends();
    refreshCalls();
}
void AppController::refreshConversations() {
    api_.request("GET", "/api/v1/conversations", {}, [this](const QJsonObject& response, const QString& error) {
        if (!error.isEmpty()) { setError(error); return; }
        conversations_ = list(response.value("conversations"));
        emit stateChanged();
    });
}
void AppController::refreshFriends() {
    api_.request("GET", "/api/v1/friends", {}, [this](const QJsonObject& response, const QString& error) {
        if (error.isEmpty()) { friends_ = list(response.value("friends")); emit stateChanged(); }
    });
    api_.request("GET", "/api/v1/friends/requests", {}, [this](const QJsonObject& response, const QString& error) {
        if (error.isEmpty()) {
            incomingRequests_ = list(response.value("incoming"));
            outgoingRequests_ = list(response.value("outgoing"));
            emit stateChanged();
        }
    });
    api_.request("GET", "/api/v1/users/presence", {}, [this](const QJsonObject& response, const QString& error) {
        if (error.isEmpty()) {
            onlineIds_ = list(response.value("online_user_ids"));
            emit stateChanged();
        }
    });
}
void AppController::refreshCalls() {
    api_.request("GET", "/api/v1/calls/current", {}, [this](const QJsonObject& response, const QString& error) {
        if (!error.isEmpty()) return;
        const QJsonArray calls = response.value("calls").toArray();
        const QString existing = currentCall_.value("id").toString();
        const QString me = user_.value("id").toString();
        QJsonObject chosen;
        for (const auto& item : calls) {
            const auto call = item.toObject();
            bool joined = false, invited = false;
            for (const auto& entry : call.value("participants").toArray()) {
                const auto participant = entry.toObject();
                if (participant.value("user_id").toString() != me) continue;
                joined = participant.value("state").toString() == "joined";
                invited = participant.value("state").toString() == "invited";
            }
            if (joined) { chosen = call; break; }
            if (invited && chosen.isEmpty()) chosen = call;
            if (call.value("id").toString() == existing && chosen.isEmpty()) chosen = call;
        }
        setCurrentCall(chosen);
    });
}
void AppController::setCurrentCall(const QJsonObject& call) {
    const QString oldId = currentCall_.value("id").toString();
    const QString newId = call.value("id").toString();
    currentCall_ = call.toVariantMap();
    if (newId.isEmpty() && !oldId.isEmpty()) callEngine_->leave();
    emit stateChanged();
    if (call.value("status").toString() == "active") {
        const QString me = user_.value("id").toString();
        for (const auto& item : call.value("participants").toArray()) {
            const auto participant = item.toObject();
            if (participant.value("user_id").toString() == me &&
                participant.value("state").toString() == "joined" &&
                callEngine_->roomId() != newId) {
                joinCall(newId);
                break;
            }
        }
    }
}
void AppController::selectConversation(const QString& id) {
    if (selectedConversationId_ == id) return;
    selectedConversationId_ = id;
    messages_.clear();
    hasMoreMessages_ = false;
    emit stateChanged();
    if (id.isEmpty()) return;
    api_.request("GET", "/api/v1/conversations/" + apiPath(id) + "/messages", {},
                 [this, id](const QJsonObject& response, const QString& error) {
        if (selectedConversationId_ != id) return;
        if (!error.isEmpty()) { setError(error); return; }
        messages_ = list(response.value("messages"));
        hasMoreMessages_ = response.value("has_more").toBool();
        emit stateChanged();
        markLatestRead();
    });
}
void AppController::loadOlderMessages() {
    if (!hasMoreMessages_ || messages_.isEmpty() || selectedConversationId_.isEmpty()) return;
    const QString firstId = messages_.first().toMap().value("id").toString();
    const QString conversation = selectedConversationId_;
    api_.request("GET", "/api/v1/conversations/" + apiPath(conversation) +
                 "/messages?before=" + apiPath(firstId), {},
                 [this, conversation](const QJsonObject& response, const QString& error) {
        if (selectedConversationId_ != conversation || !error.isEmpty()) return;
        const QVariantList older = list(response.value("messages"));
        QVariantList merged = older;
        merged.append(messages_);
        messages_ = merged;
        hasMoreMessages_ = response.value("has_more").toBool();
        emit stateChanged();
    });
}
void AppController::appendMessage(const QJsonObject& message) {
    const QString id = message.value("id").toString();
    for (const auto& item : messages_)
        if (item.toMap().value("id").toString() == id) return;
    messages_.append(message.toVariantMap());
    emit stateChanged();
}
void AppController::markLatestRead() {
    if (messages_.isEmpty() || selectedConversationId_.isEmpty()) return;
    const QString id = messages_.last().toMap().value("id").toString();
    api_.request("POST", "/api/v1/conversations/" + apiPath(selectedConversationId_) + "/read",
                 {{"message_id", id}}, [](const QJsonObject&, const QString&) {});
}
void AppController::sendMessage(const QString& text) {
    const QString body = text.trimmed();
    if (body.isEmpty() || selectedConversationId_.isEmpty()) return;
    const QString conversation = selectedConversationId_;
    api_.request("POST", "/api/v1/conversations/" + apiPath(conversation) + "/messages",
                 {{"body", body}}, [this, conversation](const QJsonObject& message, const QString& error) {
        if (!error.isEmpty()) { setError(error); return; }
        if (selectedConversationId_ == conversation) appendMessage(message);
        refreshConversations();
    });
}
void AppController::searchUsers(const QString& query) {
    if (query.trimmed().size() < 2) {
        searchResults_.clear();
        emit stateChanged();
        return;
    }
    api_.request("GET", "/api/v1/users/search?query=" + apiPath(query.trimmed()), {},
                 [this](const QJsonObject& response, const QString& error) {
        if (error.isEmpty()) { searchResults_ = list(response.value("items")); emit stateChanged(); }
        else setError(error);
    });
}
void AppController::addFriend(const QString& id) {
    api_.request("POST", "/api/v1/friends/requests", {{"target_user_id", id}},
                 [this](const QJsonObject&, const QString& error) {
        if (!error.isEmpty()) setError(error);
        else { refreshFriends(); refreshConversations(); }
    });
}
void AppController::acceptFriend(const QString& id) {
    api_.request("POST", "/api/v1/friends/requests/" + apiPath(id) + "/accept", {},
                 [this](const QJsonObject&, const QString& error) {
        if (!error.isEmpty()) setError(error); else refreshFriends();
    });
}
void AppController::rejectFriend(const QString& id) {
    api_.request("DELETE", "/api/v1/friends/requests/" + apiPath(id), {},
                 [this](const QJsonObject&, const QString& error) {
        if (!error.isEmpty()) setError(error); else refreshFriends();
    });
}
void AppController::openConversation(const QString& id) {
    api_.request("POST", "/api/v1/conversations", {{"user_id", id}},
                 [this](const QJsonObject& conversation, const QString& error) {
        if (!error.isEmpty()) { setError(error); return; }
        refreshConversations();
        selectConversation(conversation.value("id").toString());
    });
}
void AppController::createGroup(const QVariantList& ids, const QString& name) {
    QJsonArray users;
    for (const auto& id : ids) users.append(id.toString());
    QJsonObject body{{"user_ids", users}};
    if (!name.trimmed().isEmpty()) body["name"] = name.trimmed();
    api_.request("POST", "/api/v1/conversations/groups", body,
                 [this](const QJsonObject& conversation, const QString& error) {
        if (!error.isEmpty()) { setError(error); return; }
        refreshConversations();
        selectConversation(conversation.value("id").toString());
    });
}
void AppController::renameGroup(const QString& name) {
    if (selectedConversationId_.isEmpty()) return;
    api_.request("PATCH", "/api/v1/conversations/" + apiPath(selectedConversationId_),
                 {{"name", name.trimmed()}}, [this](const QJsonObject&, const QString& error) {
        if (!error.isEmpty()) setError(error); else refreshConversations();
    });
}
void AppController::startCall() {
    if (selectedConversationId_.isEmpty()) return;
    api_.request("POST", "/api/v1/conversations/" + apiPath(selectedConversationId_) + "/calls", {},
                 [this](const QJsonObject& call, const QString& error) {
        if (!error.isEmpty()) setError(error); else setCurrentCall(call);
    });
}
void AppController::acceptCall() {
    const QString id = currentCall_.value("id").toString();
    if (id.isEmpty()) return;
    api_.request("POST", "/api/v1/calls/" + apiPath(id) + "/accept", {},
                 [this](const QJsonObject& call, const QString& error) {
        if (!error.isEmpty()) setError(error); else setCurrentCall(call);
    });
}
void AppController::joinCall(const QString& id) {
    api_.request("POST", "/api/v1/calls/" + apiPath(id) + "/join", {},
                 [this, id](const QJsonObject& response, const QString& error) {
        if (currentCall_.value("id").toString() != id) return;
        if (!error.isEmpty()) { setError(error); return; }
        callEngine_->join(id, response.value("server_url").toString(),
                          response.value("token").toString());
    });
}
void AppController::endCall() {
    const QString id = currentCall_.value("id").toString();
    if (id.isEmpty()) return;
    api_.request("POST", "/api/v1/calls/" + apiPath(id) + "/end", {},
                 [this](const QJsonObject&, const QString& error) {
        if (!error.isEmpty()) setError(error);
        else { currentCall_.clear(); callEngine_->leave(); emit stateChanged(); }
    });
}
void AppController::inviteCall(const QVariantList& userIds) {
    const QString id = currentCall_.value("id").toString();
    if (id.isEmpty()) return;
    QJsonArray users;
    for (const auto& userId : userIds) users.append(userId.toString());
    api_.request("POST", "/api/v1/calls/" + apiPath(id) + "/invite",
                 {{"user_ids", users}}, [this](const QJsonObject& call, const QString& error) {
        if (!error.isEmpty()) setError(error); else setCurrentCall(call);
    });
}
void AppController::checkForUpdates() { updater_->check(true); }
void AppController::installUpdate() { updater_->install(); }
