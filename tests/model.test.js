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
  assert.equal(Model.shortName("Logitech G Pro X SUPERLIGHT"), "G Pro X")
  assert.equal(Model.shortName("  Logitech   G502   X  "), "G502 X")
})

test("shortName drops the category prefix some receivers report", function () {
  assert.equal(Model.shortName("Wireless Mouse MX Master"), "MX Master")
  assert.equal(Model.shortName("Wireless Mouse MX Master 3S"), "MX Master 3S")
})

test("shortName falls back to the generic model when it has nothing to show", function () {
  assert.equal(Model.shortName(""), "Mouse")
  assert.equal(Model.shortName(null), "Mouse")
  assert.equal(Model.shortName("Logitech"), "Logitech")
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
    '"status":"Discharging","charging":false,"full":false,"discharging":true,' +
    '"connection":"LIGHTSPEED","dpi":1300,"dpi_min":100,"dpi_max":25600,"dpi_step":50}'
  )
  assert.deepEqual(status, {
    present: true,
    model: "Logitech G502 X PLUS",
    percent: 75,
    status: "Discharging",
    charging: false,
    full: false,
    discharging: true,
    connection: "LIGHTSPEED",
    dpi: 1300,
    dpiMin: 100,
    dpiMax: 25600,
    dpiStep: 50,
    dpiValues: [],
    rate: -1,
    rates: []
  })
})

test("parseStatus carries a sparse sensor list and the polling rates", function () {
  var status = Model.parseStatus(
    '{"present":true,"dpi":1600,"dpi_values":[100,200,400,800,1600],' +
    '"rate_hz":1000,"rates_hz":[125,250,500,1000]}'
  )
  assert.deepEqual(status.dpiValues, [100, 200, 400, 800, 1600])
  assert.equal(status.rate, 1000)
  assert.deepEqual(status.rates, [125, 250, 500, 1000])
})

test("parseNumberList refuses junk and bounds what it accepts", function () {
  assert.deepEqual(Model.parseNumberList(null), [])
  assert.deepEqual(Model.parseNumberList("800"), [])
  assert.deepEqual(Model.parseNumberList([800, "400", -1, 0, 800, 2.6]), [3, 400, 800])
  assert.deepEqual(Model.parseNumberList(["lots", null, {}]), [])
})

test("parseStatus marks an unreported DPI window instead of inventing one", function () {
  // -1 is what the panel treats as "no sensitivity control", which is the right
  // answer when Solaar is missing.
  var status = Model.parseStatus('{"present":true,"dpi":null,"dpi_min":null,"dpi_max":null,"dpi_step":null}')
  assert.equal(status.dpiMin, -1)
  assert.equal(status.dpiMax, -1)
  assert.equal(status.dpiStep, -1)
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

test("the DPI window is the mouse's own, with the generic one as a fallback", function () {
  assert.deepEqual(Model.dpiWindow(400, 1600, 200), { min: 400, max: 1600, step: 200 })
  assert.deepEqual(Model.dpiWindow(null, null, null), { min: 100, max: 25600, step: 50 })
  // A window that is not a window is ignored rather than trusted.
  assert.deepEqual(Model.dpiWindow(1600, 400, 200), { min: 100, max: 25600, step: 50 })
  assert.equal(Model.dpiMin(400), 400)
  assert.equal(Model.dpiMax(1600), 1600)
  assert.equal(Model.dpiStep(200), 200)
})

test("validity follows the mouse's window, not the G502 X's", function () {
  assert.equal(Model.isValidDpi(600, 400, 1600, 200), true)
  assert.equal(Model.isValidDpi(450, 400, 1600, 200), false)
  assert.equal(Model.isValidDpi(4000, 400, 1600, 200), false)
  assert.equal(Model.isValidDpi(200, 400, 1600, 200), false)
  assert.equal(Model.snapDpi(450, 400, 1600, 200), 400)
  assert.equal(Model.snapDpi(5000, 400, 1600, 200), 1600)
})

test("nearestDpi and dpiIndex agree on a sparse list", function () {
  var values = [100, 200, 400, 800, 1200, 1600]
  assert.equal(Model.nearestDpi(1150, values), 1200)
  assert.equal(Model.nearestDpi(1000, values), 800)
  assert.equal(Model.nearestDpi(1, values), 100)
  assert.equal(Model.nearestDpi(9000, values), 1600)
  assert.equal(Model.nearestDpi(9000, []), -1)
  assert.equal(Model.dpiIndex(1150, values), 4)
  assert.equal(Model.dpiIndex(9000, values), 5)
  assert.equal(Model.dpiIndex(800, []), -1)
})

test("a sparse list decides what is valid and what a write snaps to", function () {
  var values = [100, 200, 400, 800, 1200, 1600]
  assert.equal(Model.isValidDpi(1200, -1, -1, -1, values), true)
  assert.equal(Model.isValidDpi(1000, -1, -1, -1, values), false)
  assert.equal(Model.snapDpi(1000, -1, -1, -1, values), 800)
  assert.equal(Model.snapDpi(500, -1, -1, -1, values), 400)
})

test("presets come from the list when the mouse sent one", function () {
  var values = [100, 200, 300, 400, 500, 800, 1200, 1600, 3200, 6400, 12000, 25500]
  assert.deepEqual(Model.dpiPresets(-1, -1, -1, values), [400, 800, 1600, 3200, 6400])
  var narrow = [100, 150, 200, 250, 300]
  var picked = Model.dpiPresets(-1, -1, -1, narrow)
  assert.ok(picked.length >= 2)
  for (var i = 0; i < picked.length; i++) {
    assert.ok(narrow.indexOf(picked[i]) >= 0, String(picked[i]) + " is not in the list")
  }
})

test("presets shrink to what the mouse supports", function () {
  assert.deepEqual(Model.dpiPresets(400, 1600, 200), [400, 800, 1600])
  assert.deepEqual(Model.dpiPresets(100, 25600, 50), [400, 800, 1600, 3200, 6400])
  var narrow = Model.dpiPresets(1200, 1800, 50)
  assert.ok(narrow.length >= 2)
  assert.ok(narrow[0] >= 1200)
  assert.ok(narrow[narrow.length - 1] <= 1800)
})

test("nextDpi walks the preset row and stops at both ends", function () {
  assert.equal(Model.nextDpi(800, 1), 1600)
  assert.equal(Model.nextDpi(1600, -1), 800)
  assert.equal(Model.nextDpi(400, -1), 400)
  assert.equal(Model.nextDpi(6400, 1), 6400)
})

test("nextDpi steps on from the closest preset when the value is not one", function () {
  // The mouse can sit on any 50 dpi step, from the slider or its own buttons.
  assert.equal(Model.nextDpi(1300, -1), 800)
  assert.equal(Model.nextDpi(1300, 1), 3200)
})

test("nextDpi returns the current value when there is no direction", function () {
  assert.equal(Model.nextDpi(1300, 0), 1300)
  assert.equal(Model.nextDpi(1300, null), 1300)
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
