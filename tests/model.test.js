// Tests for the pure logic in ../ui/Model.js. No dependencies:
//
//   node --test tests/
//
// Everything here is string and number handling, so it runs without a mouse, a
// shell or HID++ access. What it cannot cover is the Qt/QML wiring and the
// device itself — those stay manual.

var test = require("node:test")
var assert = require("node:assert/strict")
var Model = require("../ui/Model.js")

test("clampText keeps printable ascii, trims, and respects the limit", function () {
  assert.equal(Model.clampText("  G502 X  "), "G502 X")
  assert.equal(Model.clampText("G502\u00a0X"), "G502X")
  assert.equal(Model.clampText("G502\nX"), "G502X")
  assert.equal(Model.clampText("abcdef", 3), "abc")
  assert.equal(Model.clampText(null), "")
  assert.equal(Model.clampText(undefined), "")
})

test("shortName drops the vendor prefix and the wireless suffixes", function () {
  assert.equal(Model.shortName("Logitech G502 X PLUS"), "G502 X PLUS")
  assert.equal(Model.shortName("Logitech G502 X LIGHTSPEED"), "G502 X")
  assert.equal(Model.shortName("G502 X LS"), "G502 X")
  assert.equal(Model.shortName("  Logitech   G502   X  "), "G502 X")
})

test("shortName falls back to the generic model when it has nothing to show", function () {
  assert.equal(Model.shortName(""), "G502 X")
  assert.equal(Model.shortName(null), "G502 X")
})

test("allowStatus accepts the helper's states and refuses anything else", function () {
  assert.equal(Model.allowStatus("discharging"), "Discharging")
  assert.equal(Model.allowStatus("Charging"), "Charging")
  assert.equal(Model.allowStatus("not charging"), "Not charging")
  assert.equal(Model.allowStatus("banana"), "")
  assert.equal(Model.allowStatus(null), "")
})

test("isOn matches what the helper sends", function () {
  assert.equal(Model.isOn(true), true)
  assert.equal(Model.isOn("true"), true)
  assert.equal(Model.isOn(1), true)
  assert.equal(Model.isOn("1"), true)
  assert.equal(Model.isOn(false), false)
  assert.equal(Model.isOn(0), false)
  assert.equal(Model.isOn("yes"), false)
  assert.equal(Model.isOn(null), false)
})

test("parseStatus reads a full payload", function () {
  var status = Model.parseStatus(
    '{"present":true,"model":"Logitech G502 X PLUS","percent":75,' +
    '"status":"Discharging","charging":false,"full":false,"discharging":true,"dpi":1300}'
  )
  assert.deepEqual(status, {
    present: true,
    model: "Logitech G502 X PLUS",
    percent: 75,
    status: "Discharging",
    charging: false,
    full: false,
    discharging: true,
    dpi: 1300
  })
})

test("parseStatus turns missing values into the neutral ones", function () {
  var status = Model.parseStatus('{"present":true,"model":"G502 X","percent":null,"status":"","dpi":null}')
  assert.equal(status.percent, null) // unknown, not 0
  assert.equal(status.dpi, null)
  assert.equal(status.status, "")
  assert.equal(status.charging, false)
})

test("parseStatus clamps a silly charge and accepts a stringified dpi", function () {
  assert.equal(Model.parseStatus('{"percent":120}').percent, 100)
  assert.equal(Model.parseStatus('{"percent":74.6}').percent, 75)
  assert.equal(Model.parseStatus('{"dpi":"1300"}').dpi, 1300)
  assert.equal(Model.parseStatus('{"dpi":0}').dpi, null)
})

test("parseStatus ignores junk instead of throwing", function () {
  assert.deepEqual(Model.parseStatus(""), {})
  assert.deepEqual(Model.parseStatus("not json"), {})
  assert.deepEqual(Model.parseStatus("null"), {})
  assert.deepEqual(Model.parseStatus("[1,2]"), {})
  assert.deepEqual(Model.parseStatus(undefined), {})
})

test("parseStatus refuses an oversized payload", function () {
  // A stuck helper cannot flood the UI with a payload it would then re-render.
  assert.deepEqual(Model.parseStatus("{" + "x".repeat(3000) + "}"), {})
})

test("parsePercent returns -1 for unknown and clamps to 0..100", function () {
  assert.equal(Model.parsePercent(null), -1)
  assert.equal(Model.parsePercent(undefined), -1)
  assert.equal(Model.parsePercent(""), -1)
  assert.equal(Model.parsePercent("abc"), -1)
  assert.equal(Model.parsePercent(-1), -1) // the helper's own "no reading"
  assert.equal(Model.parsePercent(0), 0)
  assert.equal(Model.parsePercent(74.6), 75)
  assert.equal(Model.parsePercent(120), 100)
})

test("parseDpi returns -1 for unknown and rounds", function () {
  assert.equal(Model.parseDpi(null), -1)
  assert.equal(Model.parseDpi(""), -1)
  assert.equal(Model.parseDpi(0), -1)
  assert.equal(Model.parseDpi(-800), -1)
  assert.equal(Model.parseDpi("1300"), 1300)
  assert.equal(Model.parseDpi(1299.6), 1300)
})

test("formatDpi shows an em dash rather than a made up number", function () {
  assert.equal(Model.formatDpi(1300), "1300 DPI")
  assert.equal(Model.formatDpi(null), "—")
})

test("dpiPresets parses the setting, sorts and dedupes", function () {
  assert.deepEqual(Model.dpiPresets("3200, 800, 1600"), [800, 1600, 3200])
  assert.deepEqual(Model.dpiPresets("800, 800"), [800])
  assert.deepEqual(Model.dpiPresets("800, 1200, 1600, 2400, 3200"), [800, 1200, 1600, 2400, 3200])
})

test("dpiPresets drops what the sensor cannot take, keeping the rest", function () {
  assert.deepEqual(Model.dpiPresets("40, 800, 1000"), [800, 1000]) // below the sensor
  assert.deepEqual(Model.dpiPresets("800, 1024"), [800]) // not a sensor step
  assert.deepEqual(Model.dpiPresets("800, 25700"), [800]) // above the sensor
})

test("dpiPresets tolerates punctuation and stray text", function () {
  assert.deepEqual(Model.dpiPresets("800dpi, 1600 DPI"), [800, 1600])
  assert.deepEqual(Model.dpiPresets("800;1600"), [800, 1600])
})

test("dpiPresets caps the row and falls back to the shipped defaults", function () {
  assert.deepEqual(Model.dpiPresets("100,200,300,400,500,600,700,800,900"), [100, 200, 300, 400, 500, 600, 700, 800])
  assert.deepEqual(Model.dpiPresets(""), [400, 800, 1600, 3200, 6400])
  assert.deepEqual(Model.dpiPresets(null), [400, 800, 1600, 3200, 6400])
  assert.deepEqual(Model.dpiPresets("banana"), [400, 800, 1600, 3200, 6400])
})

test("isValidDpi follows the sensor range and its 50 dpi step", function () {
  assert.equal(Model.isValidDpi(100), true)
  assert.equal(Model.isValidDpi(1300), true)
  assert.equal(Model.isValidDpi(25600), true)
  assert.equal(Model.isValidDpi(1301), false)
  assert.equal(Model.isValidDpi(1024), false)
  assert.equal(Model.isValidDpi(50), false)
  assert.equal(Model.isValidDpi(25700), false)
  assert.equal(Model.isValidDpi(null), false)
})

test("snapDpi rounds to the sensor step and clamps at both ends", function () {
  assert.equal(Model.snapDpi(1301), 1300)
  assert.equal(Model.snapDpi(1337), 1350)
  assert.equal(Model.snapDpi(120), 100)
  assert.equal(Model.snapDpi(25690), 25600)
  assert.equal(Model.snapDpi(null), -1)
})

test("the slider window sits inside the sensor range", function () {
  assert.equal(Model.dpiSliderMin(), 400)
  assert.equal(Model.dpiSliderMax(), 6400)
  assert.ok(Model.dpiSliderMin() > Model.dpiMin())
  assert.ok(Model.dpiSliderMax() < Model.dpiMax())
  // The presets still reach past the window on both sides.
  assert.equal(Model.isValidDpi(Model.dpiSliderMin() - Model.dpiStep()), true)
  assert.equal(Model.isValidDpi(Model.dpiSliderMax() + Model.dpiStep()), true)
})

test("nextDpi walks the preset list and stops at both ends", function () {
  var list = [800, 1600, 3200]
  assert.equal(Model.nextDpi(800, 1, list), 1600)
  assert.equal(Model.nextDpi(1600, -1, list), 800)
  assert.equal(Model.nextDpi(800, -1, list), 800)
  assert.equal(Model.nextDpi(3200, 1, list), 3200)
})

test("nextDpi steps on from the closest preset when the value is not one", function () {
  // The mouse can sit on any 50 dpi step, from the slider or its own buttons.
  assert.equal(Model.nextDpi(1300, -1, [800, 1600, 3200]), 800)
  assert.equal(Model.nextDpi(1300, 1, [800, 1600, 3200]), 3200)
})

test("nextDpi returns the current value when there is no direction", function () {
  assert.equal(Model.nextDpi(1300, 0, [800, 1600]), 1300)
  assert.equal(Model.nextDpi(1300, null, [800, 1600]), 1300)
})

test("batteryBand colours the icon and leaves it neutral when it has no reading", function () {
  assert.equal(Model.batteryBand(0), "red")
  assert.equal(Model.batteryBand(24), "red")
  assert.equal(Model.batteryBand(25), "yellow")
  assert.equal(Model.batteryBand(49), "yellow")
  assert.equal(Model.batteryBand(50), "green")
  assert.equal(Model.batteryBand(100), "green")
  assert.equal(Model.batteryBand(-1), "unknown")
  assert.equal(Model.batteryBand(null), "unknown")
})

test("the labels never claim a state the mouse is not in", function () {
  assert.equal(Model.chargeLabel(true, false, false, false), "Low")
  assert.equal(Model.chargeLabel(false, true, true, false), "Full")
  assert.equal(Model.chargeLabel(false, false, true, false), "Plugged in")
  assert.equal(Model.chargeLabel(false, false, false, true), "On battery")
  assert.equal(Model.chargeLabel(false, false, false, false), "—")
  assert.equal(Model.modeLabel(false, false, false, false), "Not connected")
  assert.equal(Model.modeLabel(true, true, false, false), "Fully charged")
  assert.equal(Model.modeLabel(true, false, true, false), "Charging")
  assert.equal(Model.modeLabel(true, false, false, true), "Discharging")
  assert.equal(Model.modeLabel(true, false, false, false), "Standing by")
})

test("the low battery warning fires once per dip below the threshold", function () {
  assert.deepEqual(Model.shouldWarnLowBattery(12, true, 15, false), {
    level: 12,
    notify: true,
    notifiedLowBattery: true
  })
  var again = Model.shouldWarnLowBattery(12, true, 15, true)
  assert.equal(again.notify, false)
  assert.equal(again.notifiedLowBattery, true)
})

test("the warning re-arms once the mouse is back above the threshold", function () {
  assert.deepEqual(Model.shouldWarnLowBattery(75, true, 15, true), {
    level: 75,
    notify: false,
    notifiedLowBattery: false
  })
})

test("the warning needs the mouse on battery, and no reading never warns", function () {
  assert.equal(Model.shouldWarnLowBattery(12, false, 15, false).notify, false) // plugged in
  assert.equal(Model.shouldWarnLowBattery(-1, true, 15, false).notify, false) // no reading
  assert.equal(Model.shouldWarnLowBattery(undefined, true, 15, false).notify, false)
  assert.equal(Model.shouldWarnLowBattery(12, true, 15, false).notify, true)
})
