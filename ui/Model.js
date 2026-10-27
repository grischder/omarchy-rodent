var MAX_STATUS_CHARS = 2048
var MAX_TEXT = 48

// What the HID++ ADJUSTABLE_DPI feature takes, used when a mouse reports DPI
// but no sensor list. A mouse that does report one overrides all three.
var DPI_MIN = 100
var DPI_MAX = 25600
var DPI_STEP = 50

// The milestones people expect in a preset row. Each one is only offered when
// the mouse can actually be set to it.
var DPI_PRESETS = [400, 800, 1600, 3200, 6400]

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

// The helper reports whatever name the device gives. Receivers prefix it with
// the vendor ("Logitech G502 X PLUS") and some older models with a category
// ("Wireless Mouse MX Master"); the bar only has room for the model itself.
function shortName(model) {
  var name = clampText(model, MAX_TEXT) || "Mouse"
  name = name.replace(/^Logitech\s+/i, "")
  name = name.replace(/^Wireless\s+Mouse\s+/i, "")
  name = name.replace(/\s+LIGHTSPEED$/i, "")
  name = name.replace(/\s+SUPERLIGHT$/i, "")
  name = name.replace(/\s+LS$/i, "")
  name = name.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "")
  name = clampText(name, 24)
  return name || "Mouse"
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
      connection: clampText(next.connection, 24),
      dpi: dpi > 0 ? dpi : null,
      // -1 means the mouse did not report a window; dpiWindow fills in the
      // generic one rather than letting an unknown value become a real bound.
      dpiMin: parseDpi(next.dpi_min),
      dpiMax: parseDpi(next.dpi_max),
      dpiStep: parseDpi(next.dpi_step)
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

// The window a mouse reported, or the generic one when it reported none. A
// window that is not a sane range is treated as no window at all: the helper
// already rejected anything it could not read, so this is belt and braces.
function dpiWindow(min, max, step) {
  var lo = parseDpi(min)
  var hi = parseDpi(max)
  var st = parseDpi(step)
  if (lo < 0 || hi < 0 || hi <= lo) {
    // The whole window is suspect once its ends do not make a range, so the
    // step goes back to the default with them.
    lo = DPI_MIN
    hi = DPI_MAX
    st = DPI_STEP
  } else if (st < 0) {
    st = DPI_STEP
  }
  return { min: lo, max: hi, step: st }
}

function dpiMin(min) {
  var lo = parseDpi(min)
  return lo > 0 && lo < DPI_MAX ? lo : DPI_MIN
}

function dpiMax(max) {
  var hi = parseDpi(max)
  return hi > DPI_MIN ? hi : DPI_MAX
}

function dpiStep(step) {
  var st = parseDpi(step)
  return st > 0 ? st : DPI_STEP
}

// Presets are a shortcut, not the whole range. A mouse whose window misses the
// usual milestones gets four stops across its own range instead of unusable
// buttons the helper would have to clamp.
function dpiPresets(min, max, step) {
  var win = dpiWindow(min, max, step)
  var out = []
  for (var i = 0; i < DPI_PRESETS.length; i++) {
    var value = DPI_PRESETS[i]
    if (value < win.min || value > win.max) continue
    if ((value - win.min) % win.step !== 0) continue
    out.push(value)
  }
  if (out.length >= 2) return out
  var stops = 4
  for (var j = 0; j < stops; j++) {
    var raw = win.min + ((win.max - win.min) * j) / (stops - 1)
    var snapped = win.min + Math.round((raw - win.min) / win.step) * win.step
    snapped = Math.max(win.min, Math.min(win.max, snapped))
    if (out.indexOf(snapped) < 0) out.push(snapped)
  }
  return out.sort(function (a, b) { return a - b })
}

function nextDpi(current, delta, presets) {
  var list = presets && presets.length ? presets : dpiPresets()
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

function isValidDpi(value, min, max, step) {
  var win = dpiWindow(min, max, step)
  var n = parseDpi(value)
  if (n < 0 || n < win.min || n > win.max) return false
  return (n - win.min) % win.step === 0
}

function snapDpi(value, min, max, step) {
  var win = dpiWindow(min, max, step)
  var n = parseDpi(value)
  if (n < 0) return n
  var snapped = win.min + Math.round((n - win.min) / win.step) * win.step
  if (snapped > win.max) snapped = win.max - ((win.max - win.min) % win.step)
  return Math.max(win.min, Math.min(win.max, snapped))
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
    dpiWindow: dpiWindow,
    dpiPresets: dpiPresets,
    dpiMin: dpiMin,
    dpiMax: dpiMax,
    dpiStep: dpiStep,
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
