import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Coherent

ApplicationWindow {
    id: window
    width: 1380
    height: 850
    minimumWidth: 940
    minimumHeight: 620
    visible: true
    title: "Coherent"
    color: Theme.deep

    property string section: "messages"
    property string friendsTab: "friends"
    property var groupSelection: []
    property var inviteSelection: []
    property bool expandedCall: false
    property var selectedConversation: conversationById(controller.selectedConversationId)
    property var call: controller.currentCall
    property bool callVisible: call && call.id !== undefined
    property bool incomingCall: callVisible && call.participants &&
                                 call.participants.some(function(item) {
                                     return item.user_id === controller.user.id && item.state === "invited"
                                 })
    onSectionChanged: if (section === "settings") controller.callEngine.refreshDevices()
    onExpandedCallChanged: visibility = expandedCall ? Window.FullScreen : Window.Windowed
    onCallVisibleChanged: if (!callVisible) expandedCall = false
    Shortcut { sequence: "Escape"; onActivated: if (expandedCall) expandedCall = false }

    function conversationById(id) {
        for (let i = 0; i < controller.conversations.length; i++)
            if (controller.conversations[i].id === id) return controller.conversations[i]
        return null
    }
    function conversationTitle(item) {
        if (!item) return ""
        if (item.kind === "group") return item.name || "Групповой чат"
        return item.other_user ? item.other_user.username : "Личная беседа"
    }
    function initials(name) { return name && name.length ? name[0].toUpperCase() : "?" }
    function isFriend(id) {
        return controller.friends.some(function(item) { return item.id === id })
    }
    function timestamp(value) {
        if (!value) return ""
        const date = new Date(value)
        return isNaN(date.getTime()) ? "" : Qt.formatTime(date, "hh:mm")
    }
    function toggleGroupUser(id) {
        const next = groupSelection.slice()
        const index = next.indexOf(id)
        if (index >= 0) next.splice(index, 1)
        else next.push(id)
        groupSelection = next
    }

    component Avatar: Rectangle {
        property string name: ""
        property bool online: false
        implicitWidth: 42
        implicitHeight: 42
        radius: 14
        color: "#463163"
        Text {
            anchors.centerIn: parent
            text: initials(parent.name)
            color: Theme.text
            font.pixelSize: 17
            font.weight: Font.Bold
        }
        Rectangle {
            width: 9; height: 9; radius: 5
            visible: parent.online
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            color: Theme.green
            border.width: 2
            border.color: Theme.sidebar
        }
    }

    component StyledField: TextField {
        color: Theme.text
        placeholderTextColor: Theme.muted
        selectionColor: Theme.accent
        font.pixelSize: 14
        padding: 13
        background: Rectangle {
            radius: 12
            color: Theme.raised
            border.width: parent.activeFocus ? 1 : 0
            border.color: Theme.accent
        }
    }

    component DevicePicker: ColumnLayout {
        id: picker
        property string caption: ""
        property var devices: []
        property string selectedId: ""
        signal picked(string deviceId)
        spacing: 5
        Text { text: picker.caption; color: Theme.muted; font.pixelSize: 12 }
        ComboBox {
            Layout.fillWidth: true
            model: picker.devices
            textRole: "name"
            valueRole: "id"
            currentIndex: picker.selectedId.length ? indexOfValue(picker.selectedId) : 0
            enabled: count > 0
            onActivated: picker.picked(currentValue)
        }
    }

    Rectangle {
        anchors.fill: parent
        visible: !controller.authenticated
        color: Theme.deep
        Rectangle {
            width: 430
            height: authColumn.implicitHeight + 64
            anchors.centerIn: parent
            radius: 24
            color: Theme.panel
            border.width: 1
            border.color: Theme.border
            Column {
                id: authColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 32
                spacing: 18
                Row {
                    spacing: 14
                    Rectangle {
                        width: 48; height: 48; radius: 15
                        color: Theme.accent
                        Text { anchors.centerIn: parent; text: "C"; color: "white"; font.bold: true; font.pixelSize: 29 }
                    }
                    Column {
                        spacing: 1
                        Text { text: "Coherent"; color: Theme.text; font.pixelSize: 24; font.bold: true }
                        Text { text: "Будь на связи"; color: Theme.muted; font.pixelSize: 13 }
                    }
                }
                Text {
                    text: authTabs.currentIndex === 0 ? "С возвращением" : "Создать аккаунт"
                    color: Theme.text
                    font.pixelSize: 23
                    font.weight: Font.DemiBold
                }
                TabBar {
                    id: authTabs
                    width: parent.width
                    background: Rectangle { color: Theme.raised; radius: 10 }
                    TabButton { text: "Вход" }
                    TabButton { text: "Регистрация" }
                }
                StyledField { id: username; width: parent.width; placeholderText: "Имя пользователя" }
                StyledField {
                    id: password
                    width: parent.width
                    placeholderText: "Пароль"
                    echoMode: TextInput.Password
                    onAccepted: authTabs.currentIndex === 0
                        ? controller.login(username.text, password.text)
                        : controller.registerUser(username.text, password.text)
                }
                ActionButton {
                    width: parent.width
                    height: 44
                    accent: true
                    enabled: !controller.loading
                    label: controller.loading ? "Подключаюсь…" : authTabs.currentIndex === 0 ? "Войти" : "Зарегистрироваться"
                    onClicked: authTabs.currentIndex === 0
                        ? controller.login(username.text, password.text)
                        : controller.registerUser(username.text, password.text)
                }
                Text { text: "Нативный клиент для Windows"; color: Theme.muted; font.pixelSize: 12 }
            }
        }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0
        visible: controller.authenticated

        Rectangle {
            visible: !expandedCall
            Layout.fillHeight: true
            Layout.preferredWidth: 76
            color: Theme.deep
            Column {
                anchors.top: parent.top
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.topMargin: 20
                spacing: 16
                Rectangle {
                    width: 44; height: 44; radius: 15
                    color: Theme.accent
                    Text { anchors.centerIn: parent; text: "C"; color: "white"; font.pixelSize: 27; font.bold: true }
                }
                ActionButton {
                    width: 50; height: 48; label: "✉"
                    selected: section === "messages"
                    onClicked: section = "messages"
                    Rectangle {
                        visible: controller.conversations.some(function(item) { return item.unread })
                        width: 8; height: 8; radius: 4
                        anchors.right: parent.right; anchors.rightMargin: 4
                        anchors.top: parent.top; anchors.topMargin: 4
                        color: Theme.red
                    }
                }
                ActionButton {
                    width: 50; height: 48; label: "♟"
                    selected: section === "friends"
                    onClicked: section = "friends"
                    Rectangle {
                        visible: controller.incomingRequests.length > 0
                        width: 8; height: 8; radius: 4
                        anchors.right: parent.right; anchors.rightMargin: 4
                        anchors.top: parent.top; anchors.topMargin: 4
                        color: Theme.red
                    }
                }
                ActionButton {
                    width: 50; height: 48; label: "⚙"
                    selected: section === "settings"
                    onClicked: section = "settings"
                }
            }
            Avatar {
                name: controller.user.username || ""
                anchors.bottom: parent.bottom
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottomMargin: 20
            }
        }

        Rectangle {
            visible: !expandedCall
            Layout.fillHeight: true
            Layout.preferredWidth: 310
            color: Theme.sidebar
            border.width: 1
            border.color: Theme.border
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 18
                spacing: 14
                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        text: section === "messages" ? "Сообщения" : section === "friends" ? "Друзья" : "Настройки"
                        color: Theme.text
                        font.pixelSize: 21
                        font.weight: Font.DemiBold
                        Layout.fillWidth: true
                    }
                    ActionButton {
                        visible: section === "messages"
                        label: "+"
                        width: 36; height: 36
                        onClicked: { groupSelection = []; groupPopup.open() }
                    }
                    ActionButton {
                        visible: section === "messages" || section === "friends"
                        label: "↻"
                        width: 36; height: 36
                        onClicked: controller.refresh()
                    }
                }
                StyledField {
                    id: sidebarSearch
                    visible: section === "messages"
                    Layout.fillWidth: true
                    placeholderText: "Поиск беседы"
                }
                Text {
                    visible: section === "messages"
                    text: "ЛИЧНЫЕ И ГРУППОВЫЕ ЧАТЫ"
                    color: Theme.muted
                    font.pixelSize: 10
                    font.letterSpacing: 1.5
                }
                ListView {
                    visible: section === "messages"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: 4
                    model: controller.conversations.filter(function(item) {
                        return conversationTitle(item).toLowerCase().includes(sidebarSearch.text.toLowerCase())
                    })
                    delegate: Rectangle {
                        required property var modelData
                        width: ListView.view.width
                        height: 66
                        radius: 13
                        color: controller.selectedConversationId === modelData.id ? Theme.elevated : hover.hovered ? Theme.raised : "transparent"
                        Row {
                            anchors.fill: parent
                            anchors.margins: 10
                            spacing: 10
                            Avatar { name: conversationTitle(modelData) }
                            Column {
                                anchors.verticalCenter: parent.verticalCenter
                                width: parent.width - 65
                                spacing: 5
                                Text {
                                    text: conversationTitle(modelData)
                                    color: Theme.text
                                    font.pixelSize: 14
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                    width: parent.width
                                }
                                Text {
                                    text: modelData.last_message ? modelData.last_message.body : "Начните общение"
                                    color: Theme.muted
                                    font.pixelSize: 12
                                    elide: Text.ElideRight
                                    width: parent.width
                                }
                            }
                        }
                        Rectangle {
                            visible: modelData.unread
                            width: 7; height: 7; radius: 4
                            color: "white"
                            anchors.right: parent.right
                            anchors.rightMargin: 10
                            anchors.verticalCenter: parent.verticalCenter
                        }
                        HoverHandler { id: hover }
                        TapHandler {
                            onTapped: { section = "messages"; controller.selectConversation(modelData.id) }
                        }
                    }
                }
                ColumnLayout {
                    visible: section === "friends"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: 10
                    RowLayout {
                        Layout.fillWidth: true
                        ActionButton { Layout.fillWidth: true; label: "Друзья"; selected: friendsTab === "friends"; onClicked: friendsTab = "friends" }
                        ActionButton { Layout.fillWidth: true; label: "Заявки"; selected: friendsTab === "requests"; onClicked: friendsTab = "requests" }
                    }
                    StyledField {
                        id: friendQuery
                        Layout.fillWidth: true
                        placeholderText: "Найти пользователя"
                        onTextChanged: searchTimer.restart()
                    }
                    Timer {
                        id: searchTimer
                        interval: 350
                        repeat: false
                        onTriggered: controller.searchUsers(friendQuery.text)
                    }
                    ListView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 8
                        model: friendQuery.text.length >= 2 ? controller.searchResults
                             : friendsTab === "requests" ? controller.incomingRequests : controller.friends
                        delegate: Rectangle {
                            required property var modelData
                            width: ListView.view.width
                            height: 62
                            radius: 12
                            color: Theme.raised
                            RowLayout {
                                anchors.fill: parent
                                anchors.margins: 9
                                spacing: 8
                                Avatar {
                                    name: modelData.username
                                    online: controller.onlineIds.indexOf(modelData.id || modelData.user_id) >= 0
                                    implicitWidth: 38; implicitHeight: 38
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: modelData.username
                                    color: Theme.text
                                    font.pixelSize: 13
                                    elide: Text.ElideRight
                                }
                                ActionButton {
                                    width: 34; height: 32
                                    label: friendQuery.text.length >= 2
                                           ? modelData.relationship === "friends" ? "✉"
                                             : modelData.relationship === "incoming_pending" ? "✓"
                                             : modelData.relationship === "outgoing_pending" ? "…" : "+"
                                           : friendsTab === "requests" ? "✓" : "✉"
                                    onClicked: {
                                        if (friendQuery.text.length >= 2) {
                                            if (modelData.relationship === "friends") {
                                                section = "messages"
                                                controller.openConversation(modelData.id)
                                            }
                                            else if (modelData.relationship === "incoming_pending")
                                                controller.acceptFriend(modelData.request_id)
                                            else if (modelData.relationship === "none")
                                                controller.addFriend(modelData.id)
                                        } else if (friendsTab === "requests")
                                            controller.acceptFriend(modelData.request_id)
                                        else {
                                            section = "messages"
                                            controller.openConversation(modelData.id)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                ScrollView {
                    visible: section === "settings"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    ScrollBar.vertical.policy: ScrollBar.AsNeeded
                    ColumnLayout {
                    width: parent.width - 12
                    spacing: 10
                    Text { text: "Профиль"; color: Theme.muted; font.pixelSize: 12 }
                    Text { text: controller.user.username || ""; color: Theme.text; font.pixelSize: 18; font.bold: true }
                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.border }
                    Text { text: "УСТРОЙСТВА ЗВОНКА"; color: Theme.muted; font.pixelSize: 11; font.letterSpacing: 1 }
                    DevicePicker {
                        Layout.fillWidth: true
                        caption: "Микрофон"
                        devices: controller.callEngine.microphones
                        selectedId: controller.callEngine.selectedMicrophoneId
                        onPicked: function(deviceId) { controller.callEngine.selectMicrophone(deviceId) }
                    }
                    DevicePicker {
                        Layout.fillWidth: true
                        caption: "Динамики / наушники"
                        devices: controller.callEngine.speakers
                        selectedId: controller.callEngine.selectedSpeakerId
                        onPicked: function(deviceId) { controller.callEngine.selectSpeaker(deviceId) }
                    }
                    DevicePicker {
                        Layout.fillWidth: true
                        caption: "Камера"
                        devices: controller.callEngine.cameras
                        selectedId: controller.callEngine.selectedCameraId
                        onPicked: function(deviceId) { controller.callEngine.selectCamera(deviceId) }
                    }
                    Text { text: "БИТРЕЙТ ЭКРАНА · " + controller.callEngine.screenBitrateMbps + " Мбит/с";
                           color: Theme.muted; font.pixelSize: 11; font.letterSpacing: 1 }
                    Slider {
                        Layout.fillWidth: true
                        from: 5; to: 50; stepSize: 1
                        value: controller.callEngine.screenBitrateMbps
                        onMoved: controller.callEngine.setScreenBitrateMbps(Math.round(value))
                    }
                    Text { text: "Применится при следующем включении экрана";
                           color: Theme.muted; font.pixelSize: 11 }
                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.border }
                    Text { text: "ОБНОВЛЕНИЯ"; color: Theme.muted; font.pixelSize: 11; font.letterSpacing: 1 }
                    Text {
                        Layout.fillWidth: true
                        text: controller.updateStatus || "Проверка обновлений доступна здесь."
                        color: Theme.muted
                        font.pixelSize: 12
                        wrapMode: Text.WordWrap
                    }
                    ActionButton { Layout.fillWidth: true; label: "Проверить"; onClicked: controller.checkForUpdates() }
                    ActionButton { Layout.fillWidth: true; label: "Установить обновление"; accent: true; onClicked: controller.installUpdate() }
                    ActionButton { Layout.fillWidth: true; label: "Выйти из аккаунта"; onClicked: controller.logout() }
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: Theme.panel
            ColumnLayout {
                anchors.fill: parent
                spacing: 0
                Rectangle {
                    visible: !expandedCall
                    Layout.fillWidth: true
                    Layout.preferredHeight: 73
                    color: Theme.panel
                    border.width: 1
                    border.color: Theme.border
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 24
                        anchors.rightMargin: 24
                        spacing: 12
                        Text {
                            Layout.fillWidth: true
                            text: section === "messages"
                                  ? selectedConversation ? conversationTitle(selectedConversation) : "Выбери беседу"
                                  : section === "friends" ? "Твои контакты" : "Coherent для Windows"
                            color: Theme.text
                            font.pixelSize: 20
                            font.weight: Font.DemiBold
                        }
                        Text {
                            visible: selectedConversation && section === "messages"
                            text: selectedConversation && selectedConversation.kind === "group"
                                  ? selectedConversation.members.length + " участников" : ""
                            color: Theme.muted
                            font.pixelSize: 12
                        }
                        ActionButton {
                            visible: selectedConversation && selectedConversation.kind !== "group" &&
                                     selectedConversation.other_user && section === "messages"
                            label: selectedConversation && selectedConversation.other_user &&
                                   isFriend(selectedConversation.other_user.id)
                                   ? "В друзьях" : "Добавить в друзья"
                            enabled: selectedConversation && selectedConversation.other_user &&
                                     !isFriend(selectedConversation.other_user.id)
                            onClicked: controller.addFriend(selectedConversation.other_user.id)
                        }
                        ActionButton {
                            visible: selectedConversation && section === "messages" && !callVisible
                            label: "Позвонить"
                            accent: true
                            onClicked: controller.startCall()
                        }
                        ActionButton {
                            visible: selectedConversation && selectedConversation.kind === "group" && section === "messages"
                            label: "Название"
                            onClicked: { renameField.text = selectedConversation.name || ""; renamePopup.open() }
                        }
                    }
                }

                Rectangle {
                    visible: incomingCall
                    Layout.fillWidth: true
                    Layout.preferredHeight: 64
                    color: "#362248"
                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: 13
                        Text {
                            Layout.fillWidth: true
                            text: "Входящий звонок от " + (call.caller_username || "пользователя")
                            color: Theme.text
                            font.pixelSize: 14
                        }
                        ActionButton { label: "Принять"; accent: true; onClicked: controller.acceptCall() }
                        ActionButton { label: "Отклонить"; danger: true; onClicked: controller.endCall() }
                    }
                }

                Rectangle {
                    visible: callVisible && !incomingCall && section === "messages"
                    Layout.fillWidth: true
                    Layout.fillHeight: expandedCall
                    Layout.preferredHeight: controller.callEngine.connected
                                            ? expandedCall ? window.height : 320 : 85
                    color: "#120d21"
                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 14
                        spacing: 10
                        RowLayout {
                            Layout.fillWidth: true
                            Text {
                                Layout.fillWidth: true
                                text: controller.callEngine.connected ? "Звонок · " + (controller.callEngine.remoteName || "ожидание участников")
                                     : "Подключаем звонок…"
                                color: Theme.text
                                font.pixelSize: 14
                                font.weight: Font.DemiBold
                            }
                            ActionButton {
                                visible: controller.callEngine.connected
                                label: expandedCall ? "Свернуть" : "Развернуть"
                                onClicked: expandedCall = !expandedCall
                            }
                        }
                        Flow {
                            Layout.fillWidth: true
                            spacing: 8
                            ActionButton {
                                label: controller.callEngine.microphoneOn ? "Микрофон" : "Микр. выкл."
                                selected: controller.callEngine.microphoneOn
                                onClicked: controller.callEngine.toggleMicrophone()
                            }
                            ActionButton {
                                label: controller.callEngine.cameraOn ? "Камера вкл." : "Камера"
                                selected: controller.callEngine.cameraOn
                                onClicked: controller.callEngine.toggleCamera()
                            }
                            ActionButton {
                                label: controller.callEngine.screenOn ? "Стоп экран" : "Экран"
                                selected: controller.callEngine.screenOn
                                onClicked: controller.callEngine.screenOn
                                    ? controller.callEngine.toggleScreen(0) : screenPopup.open()
                            }
                            ActionButton {
                                visible: controller.callEngine.screenOn
                                label: controller.callEngine.systemAudioOn ? "Звук экрана вкл." : "Звук экрана выкл."
                                selected: controller.callEngine.systemAudioOn
                                onClicked: controller.callEngine.toggleSystemAudio()
                            }
                            ActionButton {
                                visible: controller.callEngine.connected && call.status === "active"
                                label: "Пригласить"
                                onClicked: { inviteSelection = []; invitePopup.open() }
                            }
                            ActionButton { label: "Завершить"; danger: true; onClicked: controller.endCall() }
                        }
                        Rectangle {
                            visible: controller.callEngine.connected
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            radius: 13
                            color: "#1a142a"
                            Text {
                                anchors.centerIn: parent
                                visible: controller.callEngine.remoteStreams.length === 0
                                text: "Ожидание участников и видео"
                                color: Theme.muted
                                font.pixelSize: 14
                            }
                            Flickable {
                                anchors.fill: parent
                                anchors.margins: 8
                                visible: controller.callEngine.remoteStreams.length > 0
                                clip: true
                                contentWidth: width
                                contentHeight: videoGrid.implicitHeight
                                Grid {
                                    id: videoGrid
                                    anchors.horizontalCenter: parent.horizontalCenter
                                    width: Math.min(parent.width,
                                                    columns * (expandedCall ? 520 : 340) +
                                                    (columns - 1) * columnSpacing)
                                    columns: Math.max(1, Math.min(3,
                                             Math.ceil(Math.sqrt(controller.callEngine.remoteStreams.length))))
                                    columnSpacing: 10
                                    rowSpacing: 10
                                    Repeater {
                                        model: controller.callEngine.remoteStreams
                                        delegate: Rectangle {
                                            required property var modelData
                                            width: (videoGrid.width - (videoGrid.columns - 1) *
                                                    videoGrid.columnSpacing) / videoGrid.columns
                                            height: Math.max(110, Math.min(
                                                expandedCall ? 500 : 210,
                                                width * modelData.height / Math.max(1, modelData.width) + 28))
                                            radius: 12
                                            color: Theme.raised
                                            border.width: 1
                                            border.color: Theme.border
                                            Image {
                                                anchors.fill: parent
                                                anchors.bottomMargin: 25
                                                source: "image://remote/" + modelData.key +
                                                        "/" + modelData.revision
                                                fillMode: Image.PreserveAspectFit
                                                cache: false
                                            }
                                            Rectangle {
                                                anchors.left: parent.left
                                                anchors.right: parent.right
                                                anchors.bottom: parent.bottom
                                                height: 25
                                                color: "#2b2040"
                                                radius: 8
                                                Text {
                                                    anchors.left: parent.left
                                                    anchors.leftMargin: 9
                                                    anchors.verticalCenter: parent.verticalCenter
                                                    text: modelData.name +
                                                          (modelData.source === "screen" ? " · экран" : " · камера")
                                                    color: Theme.text
                                                    font.pixelSize: 11
                                                }
                                                Text {
                                                    anchors.right: parent.right
                                                    anchors.rightMargin: 9
                                                    anchors.verticalCenter: parent.verticalCenter
                                                    text: modelData.width + "×" + modelData.height
                                                    color: Theme.muted
                                                    font.pixelSize: 10
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                Item {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    visible: section === "messages" && !expandedCall
                    Text {
                        anchors.centerIn: parent
                        visible: !selectedConversation
                        text: "Выбери чат слева или найди друга"
                        color: Theme.muted
                        font.pixelSize: 17
                    }
                    ListView {
                        id: messageList
                        anchors.fill: parent
                        anchors.margins: 20
                        visible: !!selectedConversation
                        clip: true
                        spacing: 12
                        model: controller.messages
                        onCountChanged: Qt.callLater(function() { positionViewAtEnd() })
                        delegate: Item {
                            required property var modelData
                            width: ListView.view.width
                            height: bubble.implicitHeight + 8
                            Rectangle {
                                id: bubble
                                anchors.right: modelData.sender_id === controller.user.id ? parent.right : undefined
                                anchors.left: modelData.sender_id !== controller.user.id ? parent.left : undefined
                                width: Math.min(parent.width * 0.72, Math.max(150, bodyText.implicitWidth + 32))
                                implicitHeight: bodyText.implicitHeight + 32
                                radius: 14
                                color: modelData.sender_id === controller.user.id ? "#663b99" : Theme.raised
                                Column {
                                    anchors.fill: parent
                                    anchors.margins: 12
                                    spacing: 5
                                    Text {
                                        id: bodyText
                                        width: parent.width
                                        text: modelData.body
                                        color: Theme.text
                                        font.pixelSize: 14
                                        wrapMode: Text.Wrap
                                    }
                                    Text {
                                        text: timestamp(modelData.created_at)
                                        color: "#c7b8dc"
                                        font.pixelSize: 10
                                        anchors.right: parent.right
                                    }
                                }
                            }
                        }
                        header: ActionButton {
                            visible: messageList.count >= 30
                            width: 180
                            label: "Ранние сообщения"
                            onClicked: controller.loadOlderMessages()
                        }
                    }
                }

                Rectangle {
                    visible: !!selectedConversation && section === "messages" && !expandedCall
                    Layout.fillWidth: true
                    Layout.preferredHeight: 78
                    color: Theme.panel
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 20
                        anchors.rightMargin: 20
                        anchors.topMargin: 10
                        anchors.bottomMargin: 14
                        spacing: 10
                        StyledField {
                            id: compose
                            Layout.fillWidth: true
                            placeholderText: "Напиши сообщение…"
                            onAccepted: {
                                if (text.trim().length) {
                                    controller.sendMessage(text)
                                    text = ""
                                }
                            }
                        }
                        ActionButton {
                            height: compose.height
                            label: "Отправить"
                            accent: true
                            onClicked: {
                                if (compose.text.trim().length) {
                                    controller.sendMessage(compose.text)
                                    compose.text = ""
                                }
                            }
                        }
                    }
                }

                Item {
                    visible: section !== "messages"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    Column {
                        anchors.centerIn: parent
                        spacing: 12
                        Text {
                            text: section === "friends" ? "Друзья и заявки" : "Настройки приложения"
                            color: Theme.text
                            font.pixelSize: 23
                            font.bold: true
                        }
                        Text {
                            text: section === "friends"
                                  ? "Найди пользователя слева и начни беседу."
                                  : "Обновления устанавливаются прямо из Coherent."
                            color: Theme.muted
                            font.pixelSize: 14
                        }
                    }
                }
            }
        }
    }

    Rectangle {
        visible: controller.error.length > 0
        width: Math.min(window.width - 40, 620)
        height: errorLabel.implicitHeight + 26
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 22
        radius: 12
        color: "#76354e"
        z: 100
        RowLayout {
            anchors.fill: parent
            anchors.margins: 12
            Text {
                id: errorLabel
                Layout.fillWidth: true
                text: controller.error
                color: Theme.text
                font.pixelSize: 13
                wrapMode: Text.WordWrap
            }
            ActionButton { label: "×"; width: 30; height: 30; onClicked: controller.clearError() }
        }
    }

    Popup {
        id: groupPopup
        width: 400
        height: 480
        x: (window.width - width) / 2
        y: (window.height - height) / 2
        modal: true
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        background: Rectangle { radius: 18; color: Theme.panel; border.color: Theme.border }
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 20
            spacing: 12
            Text { text: "Новый групповой чат"; color: Theme.text; font.pixelSize: 19; font.bold: true }
            StyledField { id: groupName; Layout.fillWidth: true; placeholderText: "Название (необязательно)" }
            Text { text: "Выбери минимум двух друзей"; color: Theme.muted; font.pixelSize: 12 }
            ListView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                model: controller.friends
                spacing: 4
                delegate: Rectangle {
                    required property var modelData
                    width: ListView.view.width
                    height: 44
                    radius: 9
                    color: groupSelection.indexOf(modelData.id) >= 0 ? Theme.elevated : Theme.raised
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.left: parent.left
                        anchors.leftMargin: 12
                        text: modelData.username
                        color: Theme.text
                        font.pixelSize: 13
                    }
                    Text {
                        anchors.right: parent.right
                        anchors.rightMargin: 12
                        anchors.verticalCenter: parent.verticalCenter
                        text: groupSelection.indexOf(modelData.id) >= 0 ? "✓" : "+"
                        color: Theme.accentBright
                    }
                    TapHandler { onTapped: toggleGroupUser(modelData.id) }
                }
            }
            ActionButton {
                Layout.fillWidth: true
                label: "Создать чат"
                accent: true
                enabled: groupSelection.length >= 2
                onClicked: {
                    controller.createGroup(groupSelection, groupName.text)
                    groupPopup.close()
                }
            }
        }
    }

    Popup {
        id: renamePopup
        width: 340; height: 150
        x: (window.width - width) / 2; y: (window.height - height) / 2
        modal: true
        background: Rectangle { radius: 16; color: Theme.panel; border.color: Theme.border }
        ColumnLayout {
            anchors.fill: parent; anchors.margins: 16; spacing: 12
            Text { text: "Название группы"; color: Theme.text; font.pixelSize: 17 }
            StyledField { id: renameField; Layout.fillWidth: true }
            ActionButton {
                Layout.fillWidth: true; label: "Сохранить"; accent: true
                onClicked: { controller.renameGroup(renameField.text); renamePopup.close() }
            }
        }
    }

    Popup {
        id: screenPopup
        width: 290
        height: Math.max(100, controller.callEngine.screens().length * 46 + 55)
        x: window.width - width - 30
        y: 120
        modal: true
        background: Rectangle { radius: 14; color: Theme.panel; border.color: Theme.border }
        Column {
            anchors.fill: parent; anchors.margins: 13; spacing: 8
            Text { text: "Выбери экран"; color: Theme.text; font.pixelSize: 14; font.bold: true }
            Repeater {
                model: controller.callEngine.screens()
                ActionButton {
                    required property int index
                    required property string modelData
                    width: parent.width
                    label: modelData
                    onClicked: { controller.callEngine.toggleScreen(index); screenPopup.close() }
                }
            }
        }
    }

    Popup {
        id: invitePopup
        width: 380
        height: 430
        x: (window.width - width) / 2
        y: (window.height - height) / 2
        modal: true
        background: Rectangle { radius: 16; color: Theme.panel; border.color: Theme.border }
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10
            Text { text: "Пригласить в звонок"; color: Theme.text; font.pixelSize: 18; font.bold: true }
            ListView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 5
                model: controller.friends.filter(function(friend) {
                    return !call.participants || !call.participants.some(function(p) {
                        return p.user_id === friend.id && p.state !== "left"
                    })
                })
                delegate: Rectangle {
                    required property var modelData
                    width: ListView.view.width
                    height: 42
                    radius: 9
                    color: inviteSelection.indexOf(modelData.id) >= 0 ? Theme.elevated : Theme.raised
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.left: parent.left; anchors.leftMargin: 12
                        text: modelData.username
                        color: Theme.text
                        font.pixelSize: 13
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.right: parent.right; anchors.rightMargin: 12
                        text: inviteSelection.indexOf(modelData.id) >= 0 ? "✓" : "+"
                        color: Theme.accentBright
                    }
                    TapHandler {
                        onTapped: {
                            const next = inviteSelection.slice()
                            const index = next.indexOf(modelData.id)
                            if (index >= 0) next.splice(index, 1)
                            else next.push(modelData.id)
                            inviteSelection = next
                        }
                    }
                }
            }
            ActionButton {
                Layout.fillWidth: true
                label: "Отправить приглашение"
                accent: true
                enabled: inviteSelection.length > 0
                onClicked: { controller.inviteCall(inviteSelection); invitePopup.close() }
            }
        }
    }
}
