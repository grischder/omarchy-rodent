import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "grischder.rodent"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(foreground, 1.4)

  readonly property string deviceTitle: (hostWidget && hostWidget.deviceTitle) ? hostWidget.deviceTitle : "Mouse"
  readonly property string mouseIcon: (hostWidget && hostWidget.mouseIcon) ? hostWidget.mouseIcon : Model.mouseIcon()
  readonly property int batteryPercent: hostWidget && hostWidget.batteryPercent !== undefined ? hostWidget.batteryPercent : -1
  readonly property real batteryFraction: hostWidget && hostWidget.batteryFraction !== undefined ? hostWidget.batteryFraction : 0
  readonly property bool charging: !!(hostWidget && hostWidget.charging)
  readonly property bool discharging: !!(hostWidget && hostWidget.discharging)
  readonly property bool fullyCharged: !!(hostWidget && hostWidget.fullyCharged)
  readonly property bool lowBattery: !!(hostWidget && hostWidget.lowBattery)
  readonly property string modeLabel: (hostWidget && hostWidget.modeLabel) ? hostWidget.modeLabel : ""
  readonly property int dpi: hostWidget && hostWidget.dpi !== undefined ? hostWidget.dpi : -1
  readonly property int dpiMin: (hostWidget && hostWidget.dpiMin > 0) ? hostWidget.dpiMin : Model.dpiMin()
  readonly property int dpiMax: (hostWidget && hostWidget.dpiMax > 0) ? hostWidget.dpiMax : Model.dpiMax()
  readonly property int dpiStep: (hostWidget && hostWidget.dpiStep > 0) ? hostWidget.dpiStep : Model.dpiStep()
  readonly property bool dpiSupported: !!(hostWidget && hostWidget.dpiSupported)
  readonly property var dpiValues: (hostWidget && hostWidget.dpiValues) ? hostWidget.dpiValues : []
  readonly property bool dpiIndexed: dpiValues.length > 1
  readonly property int rate: (hostWidget && hostWidget.rate > 0) ? hostWidget.rate : -1
  readonly property var rates: (hostWidget && hostWidget.rates) ? hostWidget.rates : []
  readonly property bool rateSupported: !!(hostWidget && hostWidget.rateSupported)
  readonly property string connection: (hostWidget && hostWidget.connection) ? hostWidget.connection : ""
  readonly property var dpiPresets: (hostWidget && hostWidget.dpiPresets) ? hostWidget.dpiPresets : Model.dpiPresets()
  readonly property bool dpiBusy: !!(hostWidget && hostWidget.dpiBusy)
  readonly property color fillColor: (hostWidget && hostWidget.batteryColor) ? hostWidget.batteryColor : (lowBattery ? urgent : foreground)
  property int dpiCursor: -1
  property int rateCursor: -1
  property int dpiPreview: -1

  // While dragging, the label and the settle-back position come from the
  // snapped preview. Between drags the knob follows the widget's DPI reading -
  // the value a write asked for, then whatever the helper reports back when it
  // exits - so preset buttons and the mouse's own DPI keys move it too. A write
  // that does not take snaps the knob back silently. The track is the mouse's
  // own window, widened if the reading somehow sits outside it, rather than
  // pinning the knob to an end.
  // A sparse sensor list is walked by index, so the values people actually use
  // get proportionate travel on the track instead of the first few percent of
  // a DPI-sized range.
  // In list mode the track walks the mouse's own values, capped like the
  // window below. A reading above the cap still gets a position, so the knob
  // does not lie about where the mouse is.
  readonly property var sliderValues: {
    var list = Model.sliderValues(root.dpiValues, root.dpi, Model.dpiSliderMax())
    return list.length > 1 ? list : root.dpiValues
  }
  readonly property int sliderMin: root.dpiIndexed ? 0 : Math.min(root.dpiMin, root.dpi > 0 ? root.dpi : root.dpiMin)
  readonly property int sliderMax: root.dpiIndexed
    ? sliderValues.length - 1
    : Math.max(Math.min(root.dpiMax, Model.dpiSliderMax()), root.dpi > 0 ? root.dpi : 0)
  readonly property int sliderStep: root.dpiIndexed ? 1 : root.dpiStep
  readonly property int sliderValue: {
    if (root.dpiIndexed) {
      var idx = Model.dpiIndex(root.dpiPreview > 0 ? root.dpiPreview : root.dpi, root.sliderValues)
      return idx < 0 ? 0 : idx
    }
    return dpiPreview > 0
      ? dpiPreview
      : Math.max(root.sliderMin, Math.min(root.sliderMax, root.dpi > 0 ? root.dpi : root.sliderMin))
  }

  // What a slider position means: a list entry when the mouse sent a list, a
  // snapped DPI otherwise.
  function previewFor(position) {
    if (root.dpiIndexed) {
      var idx = Math.max(0, Math.min(root.sliderValues.length - 1, Math.round(position)))
      return root.sliderValues[idx]
    }
    return Model.snapDpi(position, root.dpiMin, root.dpiMax, root.dpiStep, root.dpiValues)
  }

  readonly property string heroStatusText: modeLabel || "Standing by"

  function setDpi(value) {
    if (hostWidget && typeof hostWidget.setDpi === "function") hostWidget.setDpi(value)
  }

  function setRate(hz) {
    if (hostWidget && typeof hostWidget.setRate === "function") hostWidget.setRate(hz)
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  // A hover cursor is a keyboard artefact; the mouse showing it is only useful
  // while the pointer is actually there. It is cleared on leave and whenever
  // the panel opens or closes, so a green highlight always means "selected".
  onOpenedChanged: {
    dpiCursor = -1
    rateCursor = -1
    if (opened && hostWidget && typeof hostWidget.refresh === "function") hostWidget.refresh()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dx === 0) return
        var list = root.dpiPresets
        if (!list || list.length === 0) return
        var idx = root.dpiCursor
        if (idx < 0) {
          for (var i = 0; i < list.length; i++) {
            if (list[i] === root.dpi) { idx = i; break }
          }
          if (idx < 0) idx = 0
        }
        idx = Math.max(0, Math.min(list.length - 1, idx + dx))
        root.dpiCursor = idx
        root.setDpi(list[idx])
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroPercent.implicitHeight)

          Text {
            id: heroIcon
            text: root.mouseIcon
            textFormat: Text.PlainText
            color: root.fillColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter

            Behavior on color { ColorAnimation { duration: 200 } }
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPercent.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: root.deviceTitle
              textFormat: Text.PlainText
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              id: heroStatus
              text: root.heroStatusText.toUpperCase()
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroPercent
            text: root.batteryPercent >= 0 ? (root.batteryPercent + "%") : "—"
            textFormat: Text.PlainText
            color: root.fillColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.displayLarge
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter

            Behavior on color { ColorAnimation { duration: 200 } }
          }
        }

        Item {
          width: parent.width
          implicitHeight: Style.space(8)

          Rectangle {
            id: barTrack
            anchors.fill: parent
            radius: height / 2
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
          }

          Rectangle {
            id: barFill
            anchors.left: barTrack.left
            anchors.verticalCenter: barTrack.verticalCenter
            height: barTrack.height
            radius: barTrack.radius
            color: root.fillColor
            width: Math.max(barTrack.height, barTrack.width * root.batteryFraction)

            Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutCubic } }
            Behavior on color { ColorAnimation { duration: 220 } }
          }
        }

        Row {
          width: parent.width
          spacing: Style.space(20)

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair { label: "State"; value: root.modeLabel || "—" }
            InfoPair { label: "Connection"; value: root.connection || "—" }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair { label: "Sensitivity"; value: Model.formatDpi(root.dpi) }
            InfoPair { label: "Charge"; value: Model.chargeLabel(root.lowBattery, root.fullyCharged, root.charging, root.discharging) }
          }
        }

        PanelSeparator {
          foreground: root.foreground
          visible: root.dpiSupported
        }

        Column {
          width: parent.width
          spacing: Style.space(10)
          visible: root.dpiSupported

          PanelSectionHeader {
            text: "SENSITIVITY"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          InfoPair {
            label: "Adjust"
            value: Model.formatDpi(root.dpiPreview > 0 ? root.dpiPreview : root.dpi)
          }

          PanelSlider {
            bar: root.bar
            width: parent.width
            minimum: root.sliderMin
            maximum: root.sliderMax
            integer: true
            step: root.sliderStep
            enabled: !root.dpiBusy
            value: root.sliderValue

            // Follow the drag, but only write once it is let go: every move
            // would otherwise be a HID++ round trip.
            onMoved: function(v) { root.dpiPreview = root.previewFor(v) }
            onReleased: function(v) {
              root.dpiPreview = root.previewFor(v)
              root.setDpi(root.dpiPreview)
              root.dpiPreview = -1
            }
          }

          Row {
            id: dpiRow
            width: parent.width
            spacing: Style.space(6)

            readonly property real cellWidth: root.dpiPresets.length > 0
              ? (width - spacing * (root.dpiPresets.length - 1)) / root.dpiPresets.length
              : 0

            Repeater {
              model: root.dpiPresets
              Button {
                required property var modelData
                required property int index
                width: dpiRow.cellWidth
                text: String(modelData)
                fontSize: Style.font.bodySmall
                foreground: root.foreground
                fontFamily: root.fontFamily
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
                bordered: true
                enabled: !root.dpiBusy
                active: root.dpi === modelData
                hasCursor: root.dpiCursor === index
                onClicked: root.setDpi(modelData)
                onHovered: function(h) {
                  if (h) root.dpiCursor = index
                  else if (root.dpiCursor === index) root.dpiCursor = -1
                }
              }
            }
          }
        }

        PanelSeparator {
          foreground: root.foreground
          visible: root.rateSupported
        }

        Column {
          width: parent.width
          spacing: Style.space(10)
          visible: root.rateSupported

          PanelSectionHeader {
            text: "POLLING RATE"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Row {
            id: rateRow
            width: parent.width
            spacing: Style.space(6)

            readonly property real cellWidth: root.rates.length > 0
              ? (width - spacing * (root.rates.length - 1)) / root.rates.length
              : 0

            Repeater {
              model: root.rates
              Button {
                required property var modelData
                required property int index
                width: rateRow.cellWidth
                text: String(modelData) + " Hz"
                fontSize: Style.font.bodySmall
                foreground: root.foreground
                fontFamily: root.fontFamily
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
                bordered: true
                enabled: !root.dpiBusy
                active: root.rate === modelData
                hasCursor: root.rateCursor === index
                onClicked: root.setRate(modelData)
                onHovered: function(h) {
                  if (h) root.rateCursor = index
                  else if (root.rateCursor === index) root.rateCursor = -1
                }
              }
            }
          }
        }
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    InfoLabel { text: label }
    Item {
      width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth - parent.spacing * 2)
      height: 1
    }
    InfoValue { text: value }
  }

  component InfoLabel: Text {
    textFormat: Text.PlainText
    color: root.bar ? root.bar.foreground : root.foreground
    opacity: 0.6
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component InfoValue: Text {
    textFormat: Text.PlainText
    color: root.bar ? root.bar.foreground : root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
