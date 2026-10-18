var MAX_STATUS_CHARS = 2048
var MAX_TEXT = 48

// What the HID++ ADJUSTABLE_DPI feature takes.
var DPI_MIN = 100
var DPI_MAX = 25600
var DPI_STEP = 50

// The slider covers the range people actually use; presets and the helper still
// reach the rest of the sensor (DPI_MIN..DPI_MAX).
var DPI_SLIDER_MIN = 400
var DPI_SLIDER_MAX = 6400

function clampText(value, maxLen) {
  var limit = maxLen || MAX_TEXT
  var s = String(value == null ? "" : value)
  var out = ""
  for (var i = 0; i < s.length && out.length < limit; i++) {
    var code = s.charCodeAt(i)
    if (code < 32 || code === 127 || code > 126) continue
    out += s.charAt(i)
  }
  return out.replace(/^\s+|\s+$/g, "")
}

function shortName(model) {
  var name = clampText(model, MAX_TEXT) || "G502 X"
  name = name.replace(/^Logitech\s+/i, "")
  name = name.replace(/\s+LIGHTSPEED$/i, "")
  name = name.replace(/\s+LS$/i, "")
  name = name.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "")
  name = clampText(name, 24)
  return name || "G502 X"
}

function mouseIcon() {
  return "󰍽"
}

function allowStatus(value) {
  var key = clampText(value, 32).toLowerCase()
  if (key === "charging") return "Charging"
  if (key === "discharging") return "Discharging"
  if (key === "full") return "Full"
  if (key === "not charging") return "Not charging"
  if (key === "unknown") return "Unknown"
  return ""
}

function parseStatus(raw) {
  var text = String(raw || "")
  if (text.length > MAX_STATUS_CHARS) return {}
  try {
    var next = JSON.parse(text.replace(/^\s+|\s+$/g, ""))
    if (!next || typeof next !== "object" || Array.isArray(next)) return {}
    var percent = parsePercent(next.percent)
    var dpi = parseDpi(next.dpi)
    return {
      present: isOn(next.present),
      model: clampText(next.model, MAX_TEXT),
      percent: percent < 0 ? null : percent,
      status: allowStatus(next.status),
      charging: isOn(next.charging),
      full: isOn(next.full),
      discharging: isOn(next.discharging),
      dpi: dpi > 0 ? dpi : null
    }
  } catch (e) {
    return {}
  }
}

// -1 means "no reading" and every caller checks for it, so the helper's own
// -1 (and any negative value) must not come back as a healthy-looking 0%.
function parsePercent(value) {
  if (value === null || value === undefined || value === "") return -1
  var n = Number(value)
  if (!isFinite(n) || n < 0) return -1
  return Math.min(100, Math.round(n))
}

function parseDpi(value) {
  if (value === null || value === undefined || value === "") return -1
  var n = Number(value)
  if (!isFinite(n) || n <= 0) return -1
  return Math.round(n)
}

function formatDpi(dpi) {
  var value = parseDpi(dpi)
  if (value <= 0) return "—"
  return String(value) + " DPI"
}

function dpiPresets() {
  return [400, 800, 1600, 3200, 6400]
}

function nextDpi(current, delta) {
  var list = dpiPresets()
  var value = parseDpi(current)
  var step = Number(delta)
  if (!isFinite(step) || step === 0) return value
  var idx = -1
  var best = 0
  var bestDist = 1e9
  for (var i = 0; i < list.length; i++) {
    if (list[i] === value) idx = i
    var dist = Math.abs(list[i] - value)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  if (idx < 0) idx = best
  idx = Math.max(0, Math.min(list.length - 1, idx + (step > 0 ? 1 : -1)))
  return list[idx]
}

function dpiMin() {
  return DPI_MIN
}

function dpiMax() {
  return DPI_MAX
}

function dpiStep() {
  return DPI_STEP
}

function dpiSliderMin() {
  return DPI_SLIDER_MIN
}

function dpiSliderMax() {
  return DPI_SLIDER_MAX
}

// The presets are a shortcut, not the whole range: the slider and the helper
// both take any value the sensor can do.
function isValidDpi(value) {
  var n = parseDpi(value)
  return n >= DPI_MIN && n <= DPI_MAX && n % DPI_STEP === 0
}

function snapDpi(value) {
  var n = parseDpi(value)
  if (n < 0) return n
  n = Math.round(n / DPI_STEP) * DPI_STEP
  return Math.max(DPI_MIN, Math.min(DPI_MAX, n))
}

function batteryBand(percent) {
  var n = parsePercent(percent)
  if (n < 0) return "unknown"
  if (n < 25) return "red"
  if (n < 50) return "yellow"
  return "green"
}

function chargeLabel(low, full, charging, discharging) {
  if (low) return "Low"
  if (full) return "Full"
  if (charging) return "Plugged in"
  if (discharging) return "On battery"
  return "—"
}

function modeLabel(present, full, charging, discharging) {
  if (!present) return "Not connected"
  if (full) return "Fully charged"
  if (charging) return "Charging"
  if (discharging) return "Discharging"
  return "Standing by"
}

function isOn(value) {
  return value === true || value === "true" || value === 1 || value === "1"
}

function shouldWarnLowBattery(percent, discharging, threshold, alreadyNotified) {
  var level = Number(percent)
  var limit = Number(threshold)
  if (!isFinite(level) || level < 0 || !isFinite(limit)) {
    return { level: -1, notify: false, notifiedLowBattery: false }
  }
  var low = discharging && level <= limit
  return {
    level: level,
    notify: low && !alreadyNotified,
    notifiedLowBattery: low
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    clampText: clampText,
    shortName: shortName,
    mouseIcon: mouseIcon,
    allowStatus: allowStatus,
    parseStatus: parseStatus,
    parsePercent: parsePercent,
    parseDpi: parseDpi,
    formatDpi: formatDpi,
    dpiPresets: dpiPresets,
    dpiMin: dpiMin,
    dpiMax: dpiMax,
    dpiStep: dpiStep,
    dpiSliderMin: dpiSliderMin,
    dpiSliderMax: dpiSliderMax,
    isValidDpi: isValidDpi,
    snapDpi: snapDpi,
    nextDpi: nextDpi,
    batteryBand: batteryBand,
    chargeLabel: chargeLabel,
    modeLabel: modeLabel,
    isOn: isOn,
    shouldWarnLowBattery: shouldWarnLowBattery
  }
}
