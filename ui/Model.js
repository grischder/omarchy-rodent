var MAX_STATUS_CHARS = 16384
var MAX_TEXT = 48

// What the HID++ ADJUSTABLE_DPI feature takes, used when a mouse reports DPI
// but no sensor list. A mouse that does report one overrides all three.
var DPI_MIN = 100
var DPI_MAX = 25600
var DPI_STEP = 50

// The milestones people expect in a preset row. Each one is only offered when
// the mouse can actually be set to it.
var DPI_PRESETS = [400, 800, 1600, 3200, 6400]

// The slider stops here even when the sensor goes further. A G502 X reports
// 100..25600, but 25k DPI is unusable and it flattened the useful part of the
// track into the first few percent. The helper still accepts the full range
// from the command line.
var DPI_SLIDER_MAX = 6400

function maxStatusChars() {
  return MAX_STATUS_CHARS
}

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

// A list the helper sent: positive whole numbers only, deduplicated and sorted.
// A sensor list can be long (the PRO X Superlight reports 89 values), so the
// cap keeps a hostile or broken reply from growing the UI's state unbounded.
var MAX_LIST = 1024

function parseNumberList(value) {
  if (!value || typeof value !== "object" || typeof value.length !== "number") return []
  var out = []
  for (var i = 0; i < value.length && out.length < MAX_LIST; i++) {
    var n = parseDpi(value[i])
    if (n > 0 && out.indexOf(n) < 0) out.push(n)
  }
  return out.sort(function (a, b) { return a - b })
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
      dpiStep: parseDpi(next.dpi_step),
      // Non-empty only when the mixer is not uniform; it then beats the window.
      dpiValues: parseNumberList(next.dpi_values),
      rate: parseDpi(next.rate_hz),
      rates: parseNumberList(next.rates_hz)
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

function dpiSliderMax() {
  return DPI_SLIDER_MAX
}

// The list a list-driven slider walks: the mouse's own values up to the cap,
// widened just enough to keep a reading above the cap reachable.
function sliderValues(values, current, cap) {
  if (!values || !values.length) return []
  var limit = parseDpi(cap)
  if (limit < 0) limit = DPI_SLIDER_MAX
  var now = parseDpi(current)
  if (now > limit) limit = now
  var out = []
  for (var i = 0; i < values.length; i++) {
    if (values[i] <= limit) out.push(values[i])
  }
  if (!out.length) out.push(values[0])
  return out
}

// The closest value the mouse actually accepts, or -1 for an empty list.
// Ties go to the lower value so the result does not depend on list order.
function nearestDpi(value, values) {
  if (!values || !values.length) return -1
  var n = parseDpi(value)
  if (n < 0) return -1
  var best = values[0]
  for (var i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - n) < Math.abs(best - n)) best = values[i]
  }
  return best
}

// Where a reading sits on a list-driven slider. -1 when there is no list.
function dpiIndex(value, values) {
  if (!values || !values.length) return -1
  var target = nearestDpi(value, values)
  return target < 0 ? -1 : values.indexOf(target)
}

// Presets are a shortcut, not the whole range. A sparse sensor list decides
// what is offered; a mouse whose window misses the usual milestones gets four
// stops across its own range instead of unusable buttons.
function dpiPresets(min, max, step, values) {
  if (values && values.length) {
    var picked = []
    for (var k = 0; k < DPI_PRESETS.length; k++) {
      var near = nearestDpi(DPI_PRESETS[k], values)
      if (near > 0 && picked.indexOf(near) < 0) picked.push(near)
    }
    if (picked.length >= 2) return picked.sort(function (a, b) { return a - b })
    var span = 4
    for (var m = 0; m < span; m++) {
      var at = Math.round(((values.length - 1) * m) / (span - 1))
      if (picked.indexOf(values[at]) < 0) picked.push(values[at])
    }
    return picked.sort(function (a, b) { return a - b })
  }
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

function isValidDpi(value, min, max, step, values) {
  var n = parseDpi(value)
  if (n < 0) return false
  if (values && values.length) return values.indexOf(n) >= 0
  var win = dpiWindow(min, max, step)
  if (n < win.min || n > win.max) return false
  return (n - win.min) % win.step === 0
}

function snapDpi(value, min, max, step, values) {
  var n = parseDpi(value)
  if (n < 0) return n
  if (values && values.length) return nearestDpi(n, values)
  var win = dpiWindow(min, max, step)
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
    maxStatusChars: maxStatusChars,
    shortName: shortName,
    mouseIcon: mouseIcon,
    allowStatus: allowStatus,
    parseStatus: parseStatus,
    parsePercent: parsePercent,
    parseDpi: parseDpi,
    formatDpi: formatDpi,
    dpiWindow: dpiWindow,
    nearestDpi: nearestDpi,
    dpiIndex: dpiIndex,
    parseNumberList: parseNumberList,
    dpiPresets: dpiPresets,
    dpiMin: dpiMin,
    dpiMax: dpiMax,
    dpiStep: dpiStep,
    dpiSliderMax: dpiSliderMax,
    sliderValues: sliderValues,
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
