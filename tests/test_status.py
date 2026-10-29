"""Tests for the pure logic in ../scripts/status.py. No mouse needed:

    python3 -m unittest discover -s tests

The HID++ and sysfs paths need hardware; what is covered here is the reduction
of a sensor list into a DPI window, the snap a write goes through, and the
guards that keep one device's reading from being reported as another's.
"""

import unittest

from scripts import status


class DpiShapeTest(unittest.TestCase):
    def test_reduces_a_fine_sensor_to_low_high_and_step(self):
        values = list(range(100, 25601, 50))
        self.assertEqual(status._dpi_shape(values), (100, 25600, 50, None))

    def test_reduces_a_short_list(self):
        self.assertEqual(status._dpi_shape([400, 600, 800, 1000, 1200, 1400, 1600]), (400, 1600, 200, None))

    def test_refuses_a_list_that_is_not_a_range(self):
        self.assertEqual(status._dpi_shape([]), (None, None, None, None))
        self.assertEqual(status._dpi_shape([1000]), (None, None, None, None))
        self.assertEqual(status._dpi_shape([1600, 1600]), (None, None, None, None))

    def test_uses_the_greatest_common_step(self):
        self.assertEqual(status._dpi_shape([400, 600, 800, 1000, 1200, 1400]), (400, 1400, 200, None))

    def test_keeps_a_sparse_list_as_a_list(self):
        # Dense where people aim, sparse at the top, like the PRO X Superlight.
        sparse = [100, 200, 300, 400, 800, 1200, 1600, 3200, 6400, 12000, 25500]
        self.assertEqual(status._dpi_shape(sparse), (None, None, None, sparse))

    def test_a_gap_in_an_otherwise_uniform_list_is_not_a_window(self):
        gapped = [100, 200, 300, 500, 600, 700]
        self.assertEqual(status._dpi_shape(gapped), (None, None, None, gapped))


class SnapDpiTest(unittest.TestCase):
    def test_snaps_into_the_device_window(self):
        self.assertEqual(status._snap_dpi(450, 400, 1600, 200), 400)
        self.assertEqual(status._snap_dpi(500, 400, 1600, 200), 600)

    def test_clamps_at_both_ends(self):
        self.assertEqual(status._snap_dpi(50, 400, 1600, 200), 400)
        self.assertEqual(status._snap_dpi(9000, 400, 1600, 200), 1600)

    def test_leaves_a_value_alone_when_there_is_no_window(self):
        self.assertEqual(status._snap_dpi(1234, None, None, None), 1234)

    def test_prefers_an_allowed_value_when_the_mouse_sent_a_list(self):
        allowed = [100, 200, 400, 800, 1200, 1600]
        self.assertEqual(status._snap_dpi(1150, None, None, None, allowed), 1200)
        self.assertEqual(status._snap_dpi(1000, None, None, None, allowed), 800)
        self.assertEqual(status._snap_dpi(9000, None, None, None, allowed), 1600)

    def test_a_tie_goes_to_the_lower_allowed_value(self):
        self.assertEqual(status._snap_dpi(500, None, None, None, [400, 600]), 400)


class BatteryStateTest(unittest.TestCase):
    def test_maps_solaar_status_codes(self):
        self.assertEqual(status._battery_state(0, 50)["status"], "Discharging")
        self.assertEqual(status._battery_state(1, 50)["status"], "Charging")
        self.assertEqual(status._battery_state(2, 95)["status"], "Charging")
        self.assertEqual(status._battery_state(4, 50)["status"], "Charging")
        self.assertEqual(status._battery_state(3, 100)["status"], "Full")
        self.assertEqual(status._battery_state(None, 50)["status"], "Unknown")
        self.assertEqual(status._battery_state(255, 50)["status"], "Unknown")

    def test_a_charging_mouse_at_full_is_not_still_charging(self):
        state = status._battery_state(1, 100)
        self.assertEqual(state["status"], "Full")
        self.assertFalse(state["charging"])
        self.assertTrue(state["full"])


class DeviceMatchTest(unittest.TestCase):
    def test_the_wireless_pid_is_the_strong_signal(self):
        self.assertTrue(status._same_device({"wpid": "409F", "model": "G502 X"}, {"wpid": "409f", "model": "G502 X PLUS"}))
        self.assertFalse(status._same_device({"wpid": "4041", "model": "MX Master"}, {"wpid": "409F", "model": "MX Master"}))

    def test_names_are_the_fallback_when_no_pid_is_known(self):
        self.assertTrue(status._same_device({"model": "Wireless Mouse MX Master"}, {"model": "MX Master"}))
        self.assertFalse(status._same_device({"model": "MX Keys"}, {"model": "MX Master"}))

    def test_a_blank_name_is_not_evidence_of_a_match(self):
        self.assertFalse(status._same_device({"model": ""}, {"model": "G502 X PLUS"}))
        self.assertFalse(status._same_device({"model": "G502 X PLUS"}, {"model": ""}))
        self.assertFalse(status._same_device({}, {}))


class MergeTest(unittest.TestCase):
    def _sysfs(self, **fields):
        payload = status._empty_battery()
        payload.update({"present": True, "model": "G502 X", "wpid": "409F"})
        payload.update(fields)
        return payload

    def _hid(self, **fields):
        payload = status._empty_battery()
        payload.update({"present": True, "model": "G502 X", "wpid": "409F"})
        payload.update(fields)
        return payload

    def test_an_unread_battery_does_not_erase_the_sysfs_state(self):
        # Solaar saw the mouse but could not read its battery: a sleeping mouse.
        sysfs = self._sysfs(percent=12, status="Discharging", discharging=True)
        hid = self._hid(percent=None, status=None, charging=None, full=None, discharging=None)
        merged = status._merge(sysfs, hid)
        self.assertEqual(merged["percent"], 12)
        self.assertEqual(merged["status"], "Discharging")
        self.assertTrue(merged["discharging"])

    def test_a_different_wireless_pid_drops_the_sysfs_reading(self):
        sysfs = self._sysfs(percent=90, status="Discharging", discharging=True)
        hid = self._hid(wpid="4099", model="G502 X PLUS")
        merged = status._merge(sysfs, hid)
        self.assertIsNone(merged["percent"])
        self.assertEqual(merged["model"], "G502 X PLUS")

    def test_no_battery_report_is_none_not_zero(self):
        class Dead:
            def battery(self):
                return None

        self.assertIsNone(status._read_battery(Dead()))


class RateTest(unittest.TestCase):
    def test_basic_flags_are_milliseconds(self):
        # bits 0, 1 and 3 set: 1 ms, 2 ms and 4 ms.
        self.assertEqual(status._basic_rates_hz(0b00001011), [250, 500, 1000])

    def test_extended_flags_are_slots(self):
        # bits 0..3 set: 125, 250, 500 and 1000 Hz.
        self.assertEqual(status._extended_rates_hz(0b0001111), [125, 250, 500, 1000])
        self.assertEqual(status._extended_rates_hz(0), [])

    def test_extended_slot_lookup(self):
        self.assertEqual(status._extended_rate_slot(1000), 3)
        self.assertEqual(status._extended_rate_slot(4000), 5)
        self.assertIsNone(status._extended_rate_slot(300))


class OnboardTest(unittest.TestCase):
    def test_mode_byte_says_who_controls_the_mouse(self):
        self.assertTrue(status._onboard_active(b"\x01"))
        self.assertFalse(status._onboard_active(b"\x02"))
        self.assertIsNone(status._onboard_active(None))
        self.assertIsNone(status._onboard_active(b""))


class SetDpiArgumentTest(unittest.TestCase):
    def test_accepts_a_command_and_a_sane_value(self):
        self.assertEqual(status._parse_set_dpi(["status.py", "--set-dpi", "1600"]), 1600)

    def test_refuses_junk_and_out_of_range_values(self):
        self.assertIsNone(status._parse_set_dpi(["status.py"]))
        self.assertIsNone(status._parse_set_dpi(["status.py", "--set-dpi", "lots"]))
        self.assertIsNone(status._parse_set_dpi(["status.py", "--set-dpi", "0"]))
        self.assertIsNone(status._parse_set_dpi(["status.py", "--set-dpi", "999999"]))

    def test_accepts_a_polling_rate_command(self):
        self.assertEqual(status._parse_set_rate(["status.py", "--set-rate", "1000"]), 1000)
        self.assertIsNone(status._parse_set_rate(["status.py", "--set-rate", "0"]))
        self.assertIsNone(status._parse_set_rate(["status.py", "--set-rate", "50000"]))
        self.assertIsNone(status._parse_set_rate(["status.py", "--set-dpi", "800"]))


if __name__ == "__main__":
    unittest.main()
