import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "grischder.rodent"

  readonly property bool showPercentage: Model.isOn(setting("showPercentage", true))
  readonly property int lowBatteryPercent: {
    var value = Number(setting("lowBatteryPercent", 15))
    if (!isFinite(value)) return 15
    return Math.max(5, Math.min(40, Math.round(value)))
  }

  property var status: ({})
  readonly property bool mousePresent: Model.isOn(status.present)
  readonly property string deviceTitle: Model.shortName(status.model)
  readonly property int batteryPercent: Model.parsePercent(status.percent)
  readonly property real batteryFraction: batteryPercent < 0 ? 0 : batteryPercent / 100
  readonly property bool charging: Model.isOn(status.charging)
  readonly property bool discharging: Model.isOn(status.discharging)
  readonly property bool fullyCharged: Model.isOn(status.full)
  readonly property bool lowBattery: mousePresent && discharging && batteryPercent >= 0 && batteryPercent <= lowBatteryPercent
  readonly property string mouseIcon: Model.mouseIcon()
  readonly property int dpi: Model.parseDpi(status.dpi)
  // The mouse's own sensor window. dpiSupported is false when Solaar could not
  // report one, which is also when a write would have nowhere to go.
  readonly property int dpiMin: Model.dpiMin(status.dpiMin)
  readonly property int dpiMax: Model.dpiMax(status.dpiMax)
  readonly property int dpiStep: Model.dpiStep(status.dpiStep)
  // A sparse sensor list beats the window: the mouse accepts these and only
  // these, so the slider walks them by index instead of inventing steps.
  readonly property var dpiValues: status.dpiValues || []
  readonly property bool dpiIndexed: dpiValues.length > 1
  // A reading alone is not a capability: without a window or list, a write
  // could only guess, so the controls stay away until one arrives.
  readonly property bool dpiSupported: dpiIndexed || Model.parseDpi(status.dpiMax) > 0
  readonly property var dpiPresets: Model.dpiPresets(dpiMin, dpiMax, dpiStep, dpiValues)
  readonly property int rate: Model.parseDpi(status.rate)
  readonly property var rates: status.rates || []
  readonly property bool rateSupported: rates.length > 0
  readonly property bool onboardProfile: Model.isOn(status.onboard)
  readonly property string connection: Model.clampText(status.connection, 24)
  readonly property color batteryColor: {
    var band = Model.batteryBand(batteryPercent)
    if (band === "red") return bar ? bar.urgent : Color.urgent
    if (band === "yellow") return "#e0c35a"
    if (band === "green") return "#62c46f"
    return bar ? bar.barForeground : Color.foreground
  }
  readonly property string modeLabel: Model.modeLabel(mousePresent, fullyCharged, charging, discharging)
  readonly property string tooltipText: {
    if (!mousePresent) return "Mouse — not connected"
    var bits = [deviceTitle]
    if (batteryPercent >= 0) bits.push(String(batteryPercent) + "%")
    if (modeLabel) bits.push(modeLabel)
    if (dpi > 0) bits.push(Model.formatDpi(dpi))
    return bits.join(" · ")
  }
  readonly property int jobDeadlineMs: 2500
  readonly property int killEscalateMs: 400
  readonly property int maxStatusChars: Model.maxStatusChars()

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  property bool dpiBusy: false
  property int statusJobPid: 0
  property int dpiJobPid: 0

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.settings = root.settings
    target.anchorItem = button
    target.hostWidget = root
  }

  function scriptPath(name) {
    var url = String(Qt.resolvedUrl("../scripts/" + name))
    return decodeURIComponent(url.replace(/^file:\/\//, ""))
  }

  function helperCommand(extra) {
    var cmd = ["/usr/bin/python3", "-u", root.scriptPath("status.py")]
    if (extra && extra.length) {
      for (var i = 0; i < extra.length; i++) cmd.push(extra[i])
    }
    return cmd
  }

  function refresh() {
    if (!statusProc.running && !dpiSetProc.running) statusProc.running = true
  }

  function applyStatus(raw) {
    var text = String(raw || "")
    if (text.length > root.maxStatusChars) return
    var next = Model.parseStatus(text)
    if (!next || typeof next !== "object") return
    var keys = Object.keys(next)
    if (keys.length === 0) return
    status = next
  }

  function parsePid(value) {
    var n = Number(value)
    if (!isFinite(n) || n <= 1) return 0
    return Math.round(n)
  }

  function trackPid(proc, isDpi) {
    var pid = parsePid(proc ? proc.processId : 0)
    if (pid <= 1) return
    if (isDpi) root.dpiJobPid = pid
    else root.statusJobPid = pid
  }

  function signalTree(pid, sigName) {
    if (pid <= 1) return
    Quickshell.execDetached(["/usr/bin/kill", "-s", sigName, "--", "-" + String(pid)])
    Quickshell.execDetached(["/usr/bin/kill", "-s", sigName, "--", String(pid)])
  }

  function requestStop() {
    root.signalTree(root.statusJobPid, "TERM")
    root.signalTree(root.dpiJobPid, "TERM")
    root.dpiBusy = false
  }

  function forceKill() {
    root.signalTree(root.statusJobPid, "KILL")
    root.signalTree(root.dpiJobPid, "KILL")
    root.statusJobPid = 0
    root.dpiJobPid = 0
    root.dpiBusy = false
  }

  function armJobWatch() {
    killWatch.stop()
    jobWatch.restart()
  }

  function disarmJobWatch() {
    if (statusProc.running || dpiSetProc.running) return
    jobWatch.stop()
    if (!killWatch.running) {
      root.statusJobPid = 0
      root.dpiJobPid = 0
    }
  }

  function setDpi(value) {
    if (!root.dpiSupported) return
    var next = Model.parseDpi(value)
    if (!Model.isValidDpi(next, root.dpiMin, root.dpiMax, root.dpiStep, root.dpiValues)) return
    if (dpiSetProc.running) return
    var merged = {}
    for (var key in status) merged[key] = status[key]
    merged.dpi = next
    status = merged
    dpiBusy = true
    dpiSetProc.command = root.helperCommand(["--set-dpi", String(next)])
    dpiSetProc.running = true
  }

  function nudgeDpi(delta) {
    root.setDpi(Model.nextDpi(root.dpi, delta, root.dpiPresets))
  }

  function setRate(hz) {
    var next = Model.parseDpi(hz)
    if (next < 0 || root.rates.indexOf(next) < 0) return
    if (root.onboardProfile) return
    if (dpiSetProc.running) return
    var merged = {}
    for (var key in status) merged[key] = status[key]
    merged.rate = next
    status = merged
    dpiBusy = true
    dpiSetProc.command = root.helperCommand(["--set-rate", String(next)])
    dpiSetProc.running = true
  }

  function checkLowBattery() {
    var state = Model.shouldWarnLowBattery(batteryPercent, discharging, lowBatteryPercent, persisted.notifiedLowBattery)
    persisted.notifiedLowBattery = state.notifiedLowBattery
    if (state.notify) sendLowBatteryWarning(state.level)
  }

  function sendLowBatteryWarning(level) {
    var name = root.deviceTitle
    Quickshell.execDetached([
      "omarchy-notification-send",
      "-g", root.mouseIcon,
      "-u", "critical",
      "--app-name", name,
      "Time to recharge!",
      name + " is down to " + String(level) + "%",
      "-t", "30000"
    ])
  }

  visible: mousePresent
  implicitWidth: mousePresent ? button.implicitWidth : 0
  implicitHeight: mousePresent ? button.implicitHeight : 0

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  onMousePresentChanged: if (!mousePresent) close()
  onBatteryPercentChanged: checkLowBattery()
  onDischargingChanged: checkLowBattery()
  onOpenedChanged: if (opened) refresh()
  Component.onCompleted: {
    refresh()
    checkLowBattery()
  }

  PersistentProperties {
    id: persisted
    reloadableId: "rodent"
    property bool notifiedLowBattery: false
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Popup.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "grischder.rodent"

    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.togglePanel() }
    function refresh() { root.refresh() }
  }

  Process {
    id: statusProc
    command: root.helperCommand([])
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (String(text).length > root.maxStatusChars) return
        root.applyStatus(text)
      }
    }
    onStarted: {
      root.trackPid(statusProc, false)
      root.armJobWatch()
    }
    onProcessIdChanged: root.trackPid(statusProc, false)
    onExited: root.disarmJobWatch()
  }

  Process {
    id: dpiSetProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (String(text).length > root.maxStatusChars) return
        root.applyStatus(text)
      }
    }
    onStarted: {
      root.trackPid(dpiSetProc, true)
      root.armJobWatch()
    }
    onProcessIdChanged: root.trackPid(dpiSetProc, true)
    onExited: {
      root.dpiBusy = false
      root.disarmJobWatch()
    }
  }

  Timer {
    id: jobWatch
    interval: root.jobDeadlineMs
    repeat: false
    onTriggered: {
      root.requestStop()
      killWatch.restart()
    }
  }

  Timer {
    id: killWatch
    interval: root.killEscalateMs
    repeat: false
    onTriggered: root.forceKill()
  }

  Timer {
    interval: root.opened ? 5000 : 12000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.checkLowBattery()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    useActiveColor: false
    foreground: root.batteryColor
    text: root.mouseIcon
    slotSize: Style.bar.iconSlot
    tooltipText: root.tooltipText
    onPressed: function(b) {
      if (!root.mousePresent) return
      root.togglePanel()
    }
  }
}
