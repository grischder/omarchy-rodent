# G502 X for Omarchy

A bar widget for the Logitech G502 X family (LIGHTSPEED and PLUS). The mouse on the bar turns **green, yellow, or red** with the charge. Click it for percent, charging state, LIGHTSPEED, and DPI presets.

![G502 X panel: charge, LIGHTSPEED, and DPI presets](preview.png)

## Store blurb

**G502 X LIGHTSPEED in the Omarchy bar.** A green / yellow / red mouse for charge (yellow under 50%, red under 25%), then a panel with percent, charging vs discharging, and one-tap DPI (400–6400). Hides when the mouse is gone. Low-battery notification when you are about to run out.

Layout and controls follow Omarchy’s stock power, network, and bluetooth panels. DPI talks to the mouse through Solaar. The wireless-peripheral bar treatment was inspired by [AirPods for Omarchy](https://github.com/thisisgm/omarchy-pods).

## Credits

This plugin is new code. It is not a fork. It does stand on other people’s work:

- **[Omarchy](https://omarchy.org)** first-party **power**, **network**, and **bluetooth** widgets ([basecamp/omarchy](https://github.com/basecamp/omarchy)) — panel structure, theme tokens, hero + info grid, and the preset-button row.
- **[Solaar](https://github.com/pwr-Solaar/Solaar)** (`logitech_receiver`, Daniel Pavel and contributors, GPL-2.0) — HID++ DPI read and write. Charge itself comes from the kernel HID++ battery; Solaar is not vendored, only imported if installed.
- **[AirPods for Omarchy](https://github.com/thisisgm/omarchy-pods)** by **thisisgm** (`io.github.thisisgm.omapods`) — the quality bar for a themed wireless-device widget on the Omarchy bar. No AirPods code is included.

## What it shows

- **Bar** — mouse glyph only, colored by charge: green at 50%+, yellow under 50%, red under 25%. Hover for the model, charge, state and DPI
- **Panel** — percent, charging or discharging, LIGHTSPEED, current DPI
- **Sensitivity** — presets you choose yourself, 400 / 800 / 1600 / 3200 / 6400 out of the box, same control style as power profiles
- **Low battery** — one critical notification when discharging hits the threshold (default 15%)

## Requirements

- Omarchy (omarchy-shell)
- A Logitech G502 X LIGHTSPEED (wireless PID `409F`) or G502 X PLUS (wireless PID `4099`) on the LIGHTSPEED receiver
- Charge comes from the kernel HID++ battery. **No sudo or pkexec is required.**
- DPI read/write uses the `logitech_receiver` Python module from Solaar. Install Solaar with Omarchy’s package helper if you want DPI. If that library is missing, charge still works and DPI shows as —.

## Install

```bash
omarchy plugin add https://github.com/Quarezz/omarchy-g502x.git --enable
```

Place it next to Bluetooth if it did not land there:

```bash
omarchy bar put morf.g502x --after omarchy.bluetooth
```

Or **Omarchy menu → Plugins**.

## Uninstall

```bash
omarchy plugin disable morf.g502x
omarchy plugin remove morf.g502x
```

Nothing else is written. Removing the plugin does not change onboard mouse profiles.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `lowBatteryPercent` | 15 | Notify once when discharging reaches this percent (5–40). |

## License

MIT. Plugins run unsandboxed inside omarchy-shell; review the source before you enable it.
