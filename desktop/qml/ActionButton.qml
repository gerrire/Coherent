import QtQuick
import Coherent

Rectangle {
    id: root
    property string label: ""
    property bool accent: false
    property bool danger: false
    property bool selected: false
    signal clicked()
    implicitWidth: textItem.implicitWidth + 30
    implicitHeight: 38
    radius: 11
    color: !enabled ? Theme.elevated
           : danger ? "#73314c"
           : accent ? Theme.accent
           : selected ? Theme.elevated
           : hover.hovered ? "#34264a" : Theme.raised
    border.width: accent || danger ? 0 : 1
    border.color: Theme.border
    opacity: enabled ? 1 : 0.55
    Behavior on color { ColorAnimation { duration: 140 } }
    Text {
        id: textItem
        anchors.centerIn: parent
        text: root.label
        color: Theme.text
        font.pixelSize: 13
        font.weight: Font.DemiBold
    }
    HoverHandler { id: hover }
    TapHandler { enabled: root.enabled; onTapped: root.clicked() }
}
