"""Tests for the pure logic in ../scripts/status.py. No mouse needed:

    python3 -m unittest discover -s tests

The HID++ and sysfs paths need hardware; what is covered here is the reduction
of a sensor list into a DPI window, the snap a write goes through, and the
guards that keep one device's reading from being reported as another's.
"""

import unittest

from scripts import status


class DpiWindowTest(unittest.TestCase):
    def test_reduces_a_fine_sensor_to_low_high_and_step(self):
        values = list(range(100, 25601, 50))
        self.assertEqual(status._dpi_window(values), (100, 25600, 50))

    def test_reduces_a_short_list(self):
        self.assertEqual(status._dpi_window([400, 600, 800, 1000, 1200, 1400, 1600]), (400, 1600, 200))

    def test_refuses_a_list_that_is_not_a_range(self):
        self.assertEqual(status._dpi_window([]), (None, None, None))
        self.assertEqual(status._dpi_window([1000]), (None, None, None))
        self.assertEqual(status._dpi_window([1600, 1600]), (None, None, None))

    def test_uses_the_greatest_common_step(self):
        self.assertEqual(status._dpi_window([400, 600, 1000, 1400]), (400, 1400, 200))


class SnapDpiTest(unittest.TestCase):
    def test_snaps_into_the_device_window(self):
        self.assertEqual(status._snap_dpi(450, 400, 1600, 200), 400)
        self.assertEqual(status._snap_dpi(500, 400, 1600, 200), 600)

    def test_clamps_at_both_ends(self):
        self.assertEqual(status._snap_dpi(50, 400, 1600, 200), 400)
        self.assertEqual(status._snap_dpi(9000, 400, 1600, 200), 1600)

    def test_leaves_a_value_alone_when_there_is_no_window(self):
        self.assertEqual(status._snap_dpi(1234, None, None, None), 1234)


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


class ModelMatchTest(unittest.TestCase):
    def test_ignores_the_prefixes_the_two_sources_disagree_on(self):
        self.assertTrue(status._same_model("Wireless Mouse MX Master", "MX Master"))
        self.assertTrue(status._same_model("Logitech G502 X PLUS", "G502 X PLUS"))

    def test_missing_names_are_not_a_mismatch(self):
        self.assertTrue(status._same_model("", "G502 X PLUS"))
        self.assertTrue(status._same_model("G502 X PLUS", ""))

    def test_different_devices_do_not_match(self):
        self.assertFalse(status._same_model("MX Keys", "MX Master"))
        self.assertFalse(status._same_model("G502 X", "G915"))


class SetDpiArgumentTest(unittest.TestCase):
    def test_accepts_a_command_and_a_sane_value(self):
        self.assertEqual(status._parse_set_dpi(["status.py", "--set-dpi", "1600"]), 1600)

    def test_refuses_junk_and_out_of_range_values(self):
        self.assertIsNone(status._parse_set_dpi(["status.py"]))
        self.assertIsNone(status._parse_set_dpi(["status.py", "--set-dpi", "lots"]))
        self.assertIsNone(status._parse_set_dpi(["status.py", "--set-dpi", "0"]))
        self.assertIsNone(status._parse_set_dpi(["status.py", "--set-dpi", "999999"]))


if __name__ == "__main__":
    unittest.main()
