#pragma once

#include "ApiClient.h"
#include <QObject>
#include <QVariant>
#include <QTimer>

class CallEngine;
class NativeUpdater;

class AppController final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool authenticated READ authenticated NOTIFY stateChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY stateChanged)
    Q_PROPERTY(QVariantMap user READ user NOTIFY stateChanged)
    Q_PROPERTY(QVariantList conversations READ conversations NOTIFY stateChanged)
    Q_PROPERTY(QVariantList messages READ messages NOTIFY stateChanged)
    Q_PROPERTY(QVariantList friends READ friends NOTIFY stateChanged)
    Q_PROPERTY(QVariantList searchResults READ searchResults NOTIFY stateChanged)
    Q_PROPERTY(QVariantList incomingRequests READ incomingRequests NOTIFY stateChanged)
    Q_PROPERTY(QVariantList outgoingRequests READ outgoingRequests NOTIFY stateChanged)
    Q_PROPERTY(QVariantList onlineIds READ onlineIds NOTIFY stateChanged)
    Q_PROPERTY(QVariantMap currentCall READ currentCall NOTIFY stateChanged)
    Q_PROPERTY(QString selectedConversationId READ selectedConversationId NOTIFY stateChanged)
    Q_PROPERTY(QString error READ error NOTIFY stateChanged)
    Q_PROPERTY(QString updateStatus READ updateStatus NOTIFY stateChanged)
    Q_PROPERTY(QObject* callEngine READ callEngine CONSTANT)
public:
    explicit AppController(QObject* parent = nullptr);
    ~AppController() override;
    bool authenticated() const { return authenticated_; }
    bool loading() const { return loading_; }
    QVariantMap user() const { return user_; }
    QVariantList conversations() const { return conversations_; }
    QVariantList messages() const { return messages_; }
    QVariantList friends() const { return friends_; }
    QVariantList searchResults() const { return searchResults_; }
    QVariantList incomingRequests() const { return incomingRequests_; }
    QVariantList outgoingRequests() const { return outgoingRequests_; }
    QVariantList onlineIds() const { return onlineIds_; }
    QVariantMap currentCall() const { return currentCall_; }
    QString selectedConversationId() const { return selectedConversationId_; }
    QString error() const { return error_; }
    QString updateStatus() const { return updateStatus_; }
    QObject* callEngine() const;

    Q_INVOKABLE void login(const QString& username, const QString& password);
    Q_INVOKABLE void registerUser(const QString& username, const QString& password);
    Q_INVOKABLE void logout();
    Q_INVOKABLE void refresh();
    Q_INVOKABLE void selectConversation(const QString& id);
    Q_INVOKABLE void loadOlderMessages();
    Q_INVOKABLE void sendMessage(const QString& text);
    Q_INVOKABLE void searchUsers(const QString& query);
    Q_INVOKABLE void addFriend(const QString& userId);
    Q_INVOKABLE void acceptFriend(const QString& requestId);
    Q_INVOKABLE void rejectFriend(const QString& requestId);
    Q_INVOKABLE void openConversation(const QString& userId);
    Q_INVOKABLE void createGroup(const QVariantList& userIds, const QString& name);
    Q_INVOKABLE void renameGroup(const QString& name);
    Q_INVOKABLE void startCall();
    Q_INVOKABLE void acceptCall();
    Q_INVOKABLE void endCall();
    Q_INVOKABLE void inviteCall(const QVariantList& userIds);
    Q_INVOKABLE void checkForUpdates();
    Q_INVOKABLE void installUpdate();
    Q_INVOKABLE void clearError();

signals:
    void stateChanged();

private:
    void authenticate(const QString& mode, const QString& username, const QString& password);
    void onAuthenticated(const QJsonObject& account);
    void refreshConversations();
    void refreshFriends();
    void refreshCalls();
    void setCurrentCall(const QJsonObject& call);
    void joinCall(const QString& callId);
    void markLatestRead();
    void appendMessage(const QJsonObject& message);
    void setError(const QString& error);

    ApiClient api_;
    CallEngine* callEngine_;
    NativeUpdater* updater_;
    QTimer refreshTimer_;
    QVariantMap user_;
    QVariantList conversations_;
    QVariantList messages_;
    QVariantList friends_;
    QVariantList searchResults_;
    QVariantList incomingRequests_;
    QVariantList outgoingRequests_;
    QVariantList onlineIds_;
    QVariantMap currentCall_;
    QString selectedConversationId_;
    QString error_;
    QString updateStatus_;
    bool authenticated_ = false;
    bool loading_ = true;
    bool hasMoreMessages_ = false;
};
