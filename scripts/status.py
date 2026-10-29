#!/usr/bin/python3
"""Read a wireless mouse's charge and DPI over HID++. Prints one JSON object."""

from __future__ import annotations

import json
import math
import os
import select
import signal
import sys
import time
from pathlib import Path

SYSFS_ROOT = Path("/sys/class/power_supply")

LOGITECH_VID = "046D"
# The receiver families this widget speaks to. A mouse on one of these is a
# HID++ 2.0 device; anything else (nano, 27 MHz, wired, Bluetooth) either has no
# feature table or never goes through a receiver. The names are Solaar's own
# receiver_kind values, so a new receiver model shows up here without a change.
SUPPORTED_RECEIVERS = ("lightspeed", "unifying", "bolt")
RECEIVER_LABELS = {
    "lightspeed": "LIGHTSPEED",
    "unifying": "Unifying",
    "bolt": "Bolt",
}

JOB_DEADLINE_SEC = 2.0
MAX_SYSFS_BYTES = 256
MAX_TEXT = 48
MAX_JSON_BYTES = 8192
MAX_STDERR_BYTES = 4096
# The HID++ reply JSON carries the model, the connection and the DPI window on
# top of the reading. Cutting it short at this bound leaves invalid JSON, and an
# unparsable reply is dropped exactly like a missing mouse, which silently costs
# the DPI reading.
MAX_HID_REPLY = 8192
MAX_BATTERY_NODES = 8
# The absolute range a HID++ ADJUSTABLE_DPI write can carry. The device's own
# window is narrower and is what the panel offers; this only bounds the command.
ABS_DPI_MIN = 10
ABS_DPI_MAX = 65535
RATE_MIN_HZ = 100
RATE_MAX_HZ = 10000
STATUS_LABELS = {
    "charging": "Charging",
    "discharging": "Discharging",
    "full": "Full",
    "not charging": "Not charging",
    "unknown": "Unknown",
}


def _id(value) -> str:
    return str(value or "").strip().upper()


def _plain(value: str, max_len: int = MAX_TEXT) -> str:
    out: list[str] = []
    for ch in str(value or ""):
        code = ord(ch)
        if code < 32 or code == 127 or code > 126:
            continue
        out.append(ch)
        if len(out) >= max_len:
            break
    return "".join(out).strip()


def _read(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return handle.read(MAX_SYSFS_BYTES)
    except OSError:
        return ""


def _hid_vid_pid(uevent: str) -> tuple[str, str]:
    for line in uevent.splitlines():
        if not line.startswith("HID_ID="):
            continue
        parts = line.split("=", 1)[1].strip().split(":")
        if len(parts) != 3:
            return "", ""
        vid = parts[1].upper()[-4:]
        pid = parts[2].upper()[-4:]
        return vid, pid
    return "", ""


def _receiver_kind(product_id) -> str:
    """What Solaar calls this receiver family, or "" when it does not know it."""
    text = str(product_id or "").strip()
    if not text:
        return ""
    try:
        from logitech_receiver import base_usb

        info = base_usb.get_receiver_info(int(text, 16))
    except Exception:
        return ""
    return str(info.get("receiver_kind") or "").strip().lower()


def _connection(kind: str) -> str:
    return RECEIVER_LABELS.get(kind.strip().lower(), "Wireless") if kind else "Wireless"


def _logitech_battery(entry: Path) -> str | None:
    """The receiver kind behind this sysfs battery, or None when it is not ours.

    Without Solaar the kind is unknown and the reading is still accepted: charge
    keeps working and there is no feature table to ask a mouse from a keyboard.
    """
    device = entry / "device"
    try:
        hid = device.resolve()
    except OSError:
        return None
    vid, wpid = _hid_vid_pid(_read(hid / "uevent"))
    if vid != LOGITECH_VID:
        return None
    parent = hid.parent
    if parent is None:
        return None
    pvid, ppid = _hid_vid_pid(_read(parent / "uevent"))
    if pvid != LOGITECH_VID:
        return None
    kind = _receiver_kind(ppid)
    if kind and kind not in SUPPORTED_RECEIVERS:
        return None
    return kind


def _sysfs_wpid(entry: Path) -> str:
    try:
        hid = (entry / "device").resolve()
    except OSError:
        return ""
    return _hid_vid_pid(_read(hid / "uevent"))[1]


def _status_label(raw: str) -> str:
    return STATUS_LABELS.get(_plain(raw, 32).lower(), "Unknown")


def _model_label(raw: str) -> str:
    # Report the name the device gave rather than guessing a model. _plain has
    # already bounded it to printable ASCII and MAX_TEXT, so it is safe to show.
    return _plain(raw, MAX_TEXT)


def _empty_battery() -> dict:
    return {
        "present": False,
        "model": "",
        "percent": None,
        "status": "",
        "charging": False,
        "full": False,
        "discharging": False,
        "connection": "",
        "dpi": None,
        "dpi_min": None,
        "dpi_max": None,
        "dpi_step": None,
        "dpi_values": None,
        "rate_hz": None,
        "rates_hz": None,
        "onboard": None,
    }


def _battery() -> dict:
    """Charge from sysfs, for any mouse behind a Logitech receiver.

    This is a fallback: it needs no Solaar and no HID++ round trip, but it cannot
    tell a mouse from a keyboard sharing the receiver, and some models expose no
    capacity at all.
    """
    found = 0
    for entry in sorted(SYSFS_ROOT.glob("hidpp_battery_*")):
        found += 1
        if found > MAX_BATTERY_NODES:
            break
        kind = _logitech_battery(entry)
        if kind is None:
            continue
        status = _status_label(_read(entry / "status"))
        percent_raw = _plain(_read(entry / "capacity"), 8)
        try:
            percent = int(percent_raw)
        except ValueError:
            percent = None
        if percent is not None:
            percent = max(0, min(100, percent))
        charging = status == "Charging" or status == "Full"
        discharging = status == "Discharging"
        full = status == "Full" or (charging and percent is not None and percent >= 99)
        payload = _empty_battery()
        payload.update(
            {
                "present": True,
                "model": _model_label(_read(entry / "model_name")),
                "percent": percent,
                "status": status,
                "charging": charging and not full,
                "full": full,
                "discharging": discharging,
                "connection": _connection(kind),
                "wpid": _sysfs_wpid(entry),
            }
        )
        return payload
    return _empty_battery()


def _close(dev) -> None:
    closer = getattr(dev, "close", None)
    if callable(closer):
        try:
            closer()
        except Exception:
            pass


def _device_name(dev) -> str:
    for attr in ("name", "codename"):
        try:
            name = _plain(getattr(dev, attr, ""))
        except Exception:
            name = ""
        if name:
            return name
    return ""


def _is_mouse(dev) -> bool:
    try:
        return str(getattr(dev, "kind", "") or "").strip().lower() == "mouse"
    except Exception:
        return False


def _mice():
    """Yield (device, receiver_kind) for mice on a supported receiver."""
    from logitech_receiver import base
    from logitech_receiver import receiver as hid_receiver

    for info in base.receivers_and_devices():
        if getattr(info, "isDevice", False):
            continue
        kind = _receiver_kind(getattr(info, "product_id", None))
        if kind not in SUPPORTED_RECEIVERS:
            continue
        try:
            opened = hid_receiver.create_receiver(base, info)
        except Exception:
            continue
        if not opened:
            continue
        try:
            candidates = list(opened)
        except Exception:
            continue
        for item in candidates:
            if item and _is_mouse(item):
                yield item, kind


def _battery_state(code: int | None, percent: int | None) -> dict:
    """Map Solaar's BatteryStatus value onto the labels the panel already uses."""
    charging = False
    full = False
    discharging = False
    if code == 3:  # FULL
        label = "Full"
        full = True
    elif code in (1, 2, 4):  # RECHARGING, ALMOST_FULL, SLOW_RECHARGE
        label = "Charging"
        charging = True
    elif code == 0:  # DISCHARGING
        label = "Discharging"
        discharging = True
    else:
        label = "Unknown"
    if charging and percent is not None and percent >= 99:
        label = "Full"
        charging = False
        full = True
    return {
        "status": label,
        "charging": charging,
        "full": full,
        "discharging": discharging,
    }


def _read_battery(dev) -> dict | None:
    """Battery through Solaar, which covers every battery feature mice ship.

    None means "no report", which is not the same as a report of zero. The
    caller must leave the sysfs reading in place rather than overwrite it with
    defaults: a sleeping mouse would otherwise lose its discharging state and
    with it the low-battery warning.
    """
    try:
        report = dev.battery()
    except Exception:
        return None
    if report is None:
        return None
    level = getattr(report, "level", None)
    try:
        percent = int(level) if level is not None else None
    except (TypeError, ValueError):
        percent = None
    if percent is not None:
        # 0 means "no reading" rather than an empty battery, and a value past
        # 100 is a bad parse; neither may reach the bar as a real charge.
        percent = max(0, min(100, percent)) if 0 < percent <= 100 else None
    # Solaar models this as an enum.Flag, which does not cast with int().
    raw_status = getattr(report, "status", None)
    raw_status = getattr(raw_status, "value", raw_status)
    try:
        code = int(raw_status) if raw_status is not None else None
    except (TypeError, ValueError):
        code = None
    state = _battery_state(code, percent)
    if percent is not None:
        state["percent"] = percent
    return state


def _dpi_list(dev) -> list[int]:
    from logitech_receiver.hidpp20_constants import SupportedFeature
    from logitech_receiver.settings_templates import produce_dpi_list

    try:
        return produce_dpi_list(SupportedFeature.ADJUSTABLE_DPI, 0x10, 1, dev, 0)
    except Exception:
        return []


def _dpi_shape(values: list[int]) -> tuple[int | None, int | None, int | None, list[int] | None]:
    """Describe a sensor list as a window when it is uniform, else as the list.

    Most gaming mice report every value between their ends, so low/high/step says
    everything and the panel gets a plain slider. Some report a sparse list that
    is dense where people actually aim (the PRO X Superlight: 89 values, most of
    them under 1000), and a step would invent values the mouse cannot take. In
    that case the list itself travels to the panel.
    """
    clean = sorted({int(v) for v in values if isinstance(v, int) and v > 0})
    if len(clean) < 2:
        return None, None, None, None
    low, high = clean[0], clean[-1]
    step = 0
    for before, after in zip(clean, clean[1:]):
        step = math.gcd(step, after - before)
    if step > 0 and len(clean) == (high - low) // step + 1:
        return low, high, step, None
    return None, None, None, clean


def _snap_dpi(
    value: int,
    low: int | None,
    high: int | None,
    step: int | None,
    allowed: list[int] | None = None,
) -> int:
    if allowed:
        # Nearest allowed value; on a tie the lower one, so the result is stable.
        return int(min(allowed, key=lambda candidate: (abs(candidate - value), candidate)))
    if low is not None and high is not None:
        value = max(low, min(high, value))
    if low is not None and step:
        # Half up, matching Math.round in the panel. Python's round() is half to
        # even, which would send 500 to 400 on a 200 dpi mouse while the panel
        # showed 600.
        value = low + math.floor((value - low) / step + 0.5) * step
        if high is not None:
            value = min(high, value)
    return int(value)


def _basic_rates_hz(flags: int) -> list[int]:
    """REPORT_RATE choices: one bit per millisecond, 1 ms = 1000 Hz."""
    return sorted(1000 // ms for bit, ms in enumerate(range(1, 9)) if flags & (1 << bit))


def _extended_rates_hz(flags: int) -> list[int]:
    """EXTENDED_ADJUSTABLE_REPORT_RATE choices, one bit per slot."""
    table = (125, 250, 500, 1000, 2000, 4000, 8000)
    return [hz for slot, hz in enumerate(table) if flags & (1 << slot)]


def _extended_rate_slot(hz: int) -> int | None:
    table = (125, 250, 500, 1000, 2000, 4000, 8000)
    try:
        return table.index(hz)
    except ValueError:
        return None


def _onboard_active(mode: bytes | None) -> bool | None:
    """True when an onboard profile controls the mouse, False in host mode.

    Mode 0x01 means the mouse runs the profile stored in its own memory; 0x02
    means the host (software) is in control. Report rate is held by the profile
    in the first case, so writes are refused - the same caveat Solaar prints on
    its Report Rate setting.
    """
    if not mode:
        return None
    return (int(mode[0]) & 0xFF) == 1


def _read_onboard(dev) -> bool | None:
    from logitech_receiver.hidpp20_constants import SupportedFeature

    try:
        mode = dev.feature_request(SupportedFeature.ONBOARD_PROFILES, 0x20)
    except Exception:
        return None
    return _onboard_active(mode)


def _read_rate(dev) -> tuple[int | None, list[int]]:
    """Current polling rate and the ones the mouse accepts, in Hz."""
    from logitech_receiver.hidpp20_constants import SupportedFeature

    try:
        reply = dev.feature_request(SupportedFeature.REPORT_RATE, 0x00)
        if reply and len(reply) >= 1:
            rates = _basic_rates_hz(int(reply[0]))
            current = dev.feature_request(SupportedFeature.REPORT_RATE, 0x10)
            hz = 1000 // int(current[0]) if current and int(current[0]) > 0 else None
            return (hz if hz in rates else None), rates
        reply = dev.feature_request(SupportedFeature.EXTENDED_ADJUSTABLE_REPORT_RATE, 0x10)
        if reply and len(reply) >= 2:
            rates = _extended_rates_hz((int(reply[0]) << 8) | int(reply[1]))
            current = dev.feature_request(SupportedFeature.EXTENDED_ADJUSTABLE_REPORT_RATE, 0x20)
            slot = int(current[0]) if current else -1
            table = (125, 250, 500, 1000, 2000, 4000, 8000)
            hz = table[slot] if 0 <= slot < len(table) else None
            return (hz if hz in rates else None), rates
    except Exception:
        return None, []
    return None, []


def _set_rate(dev, hz: int) -> tuple[int | None, list[int]]:
    from logitech_receiver.hidpp20_constants import SupportedFeature

    try:
        reply = dev.feature_request(SupportedFeature.REPORT_RATE, 0x00)
        if reply and len(reply) >= 1 and hz in _basic_rates_hz(int(reply[0])):
            dev.feature_request(SupportedFeature.REPORT_RATE, 0x20, bytes([1000 // hz]))
            return _read_rate(dev)
        reply = dev.feature_request(SupportedFeature.EXTENDED_ADJUSTABLE_REPORT_RATE, 0x10)
        if reply and len(reply) >= 2:
            rates = _extended_rates_hz((int(reply[0]) << 8) | int(reply[1]))
            slot = _extended_rate_slot(hz)
            if hz in rates and slot is not None:
                dev.feature_request(SupportedFeature.EXTENDED_ADJUSTABLE_REPORT_RATE, 0x30, bytes([slot]))
                return _read_rate(dev)
    except Exception:
        pass
    return _read_rate(dev)


def _read_dpi(dev) -> int | None:
    from logitech_receiver.hidpp20_constants import SupportedFeature

    reply = dev.feature_request(SupportedFeature.ADJUSTABLE_DPI, 0x20)
    if not reply or len(reply) < 5:
        return None
    current = (reply[1] << 8) | reply[2]
    if current == 0:
        current = (reply[3] << 8) | reply[4]
    if current <= 0:
        return None
    return int(current)


def _set_dpi(dev, dpi: int) -> int | None:
    from logitech_receiver.hidpp20_constants import SupportedFeature

    payload = bytes([0x00, (dpi >> 8) & 0xFF, dpi & 0xFF])
    reply = dev.feature_request(SupportedFeature.ADJUSTABLE_DPI, 0x30, payload)
    if not reply or len(reply) < 3:
        return _read_dpi(dev)
    current = (reply[1] << 8) | reply[2]
    if current <= 0:
        return _read_dpi(dev)
    return int(current)


def _hid_work(set_to: int | None, set_rate_to: int | None) -> dict:
    out = _empty_battery()
    try:
        for dev, kind in _mice():
            out["present"] = True
            out["model"] = _device_name(dev)
            out["connection"] = _connection(kind)
            out["wpid"] = _id(getattr(dev, "wpid", ""))
            state = _read_battery(dev)
            if state is None:
                # Leave the group unset; _merge must not let "no report" erase
                # the sysfs flags it is meant to complement.
                for key in ("percent", "status", "charging", "full", "discharging"):
                    out[key] = None
            else:
                out.update(state)
            low, high, step, allowed = _dpi_shape(_dpi_list(dev))
            out["dpi_min"] = low
            out["dpi_max"] = high
            out["dpi_step"] = step
            out["dpi_values"] = allowed
            if set_to is not None:
                out["dpi"] = _set_dpi(dev, _snap_dpi(set_to, low, high, step, allowed))
            else:
                out["dpi"] = _read_dpi(dev)
            out["onboard"] = _read_onboard(dev)
            if set_rate_to is not None:
                out["rate_hz"], out["rates_hz"] = _set_rate(dev, set_rate_to)
            else:
                out["rate_hz"], out["rates_hz"] = _read_rate(dev)
            _close(dev)
            return out
    except Exception:
        return out
    return out


def _reap(pid: int) -> None:
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def _kill_pid(pid: int) -> None:
    if pid <= 1:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    _reap(pid)


def _silence_fd(target_fd: int) -> None:
    try:
        dn = os.open(os.devnull, os.O_WRONLY)
        os.dup2(dn, target_fd)
        if dn != target_fd:
            os.close(dn)
    except OSError:
        pass


def _drain_stderr() -> None:
    """Keep fd 2 from blocking, but never retain more than MAX_STDERR_BYTES."""
    try:
        r, w = os.pipe()
    except OSError:
        _silence_fd(2)
        return
    pid = os.fork()
    if pid == 0:
        os.close(w)
        seen = 0
        try:
            while True:
                chunk = os.read(r, 256)
                if not chunk:
                    break
                seen += len(chunk)
                if seen >= MAX_STDERR_BYTES:
                    while os.read(r, 256):
                        pass
                    break
        except OSError:
            pass
        os._exit(0)
    os.close(r)
    try:
        os.dup2(w, 2)
    finally:
        os.close(w)


def _become_session() -> None:
    try:
        os.setsid()
    except OSError:
        pass


def _hid_report(set_to: int | None, set_rate_to: int | None) -> dict:
    empty = _empty_battery()
    try:
        r, w = os.pipe()
    except OSError:
        return empty
    try:
        pid = os.fork()
    except OSError:
        os.close(r)
        os.close(w)
        return empty
    if pid == 0:
        os.close(r)
        _silence_fd(1)
        _silence_fd(2)
        try:
            payload = _hid_work(set_to, set_rate_to)
            msg = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
            os.write(w, msg[:MAX_HID_REPLY])
        except Exception:
            pass
        try:
            os.close(w)
        except OSError:
            pass
        os._exit(0)

    os.close(w)
    deadline = time.monotonic() + JOB_DEADLINE_SEC
    buf = b""
    dead = False
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            _kill_pid(pid)
            break
        try:
            ready, _, _ = select.select([r], [], [], min(0.05, left))
        except InterruptedError:
            continue
        if ready:
            try:
                chunk = os.read(r, MAX_HID_REPLY)
            except OSError:
                chunk = b""
            if not chunk:
                dead = True
                break
            buf += chunk
            if len(buf) >= MAX_HID_REPLY:
                buf = buf[:MAX_HID_REPLY]
                break
        try:
            waited, _status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            waited = pid
        if waited:
            dead = True
            try:
                extra = os.read(r, MAX_HID_REPLY)
                if extra:
                    buf = (buf + extra)[:MAX_HID_REPLY]
            except OSError:
                pass
            break
    try:
        os.close(r)
    except OSError:
        pass
    if not dead:
        _kill_pid(pid)
    else:
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
    if not buf:
        return empty
    try:
        next_payload = json.loads(buf.decode("ascii"))
    except (ValueError, UnicodeDecodeError):
        return empty
    if not isinstance(next_payload, dict):
        return empty
    return next_payload


def _parse_set_dpi(argv: list[str]) -> int | None:
    if len(argv) < 3 or argv[1] != "--set-dpi":
        return None
    try:
        value = int(argv[2])
    except ValueError:
        return None
    if value < ABS_DPI_MIN or value > ABS_DPI_MAX:
        return None
    return value


def _parse_set_rate(argv: list[str]) -> int | None:
    if len(argv) < 3 or argv[1] != "--set-rate":
        return None
    try:
        value = int(argv[2])
    except ValueError:
        return None
    if value < RATE_MIN_HZ or value > RATE_MAX_HZ:
        return None
    return value


class _CappedStdout:
    def __init__(self, inner, limit: int) -> None:
        self._inner = inner
        self._limit = limit
        self._used = 0

    def write(self, data) -> int:
        text = data if isinstance(data, str) else bytes(data).decode("utf-8", "replace")
        encoded = text.encode("utf-8", "replace")
        remain = self._limit - self._used
        if remain <= 0:
            return len(text)
        chunk = encoded[:remain]
        self._used += len(chunk)
        self._inner.write(chunk.decode("utf-8", "replace"))
        return len(text)

    def flush(self) -> None:
        self._inner.flush()

    def fileno(self) -> int:
        return self._inner.fileno()


def _emit(payload: dict) -> None:
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    if len(text.encode("ascii", "replace")) > MAX_JSON_BYTES:
        text = json.dumps(_empty_battery(), separators=(",", ":"), ensure_ascii=True)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


_payload = None


def _flush_payload() -> None:
    global _payload
    if _payload is None:
        return
    try:
        _emit(_payload)
    except Exception:
        pass
    _payload = None


def _on_term(_signum, _frame) -> None:
    _flush_payload()
    os._exit(0)


def _comparable_model(name: str) -> str:
    text = _plain(name).casefold()
    for prefix in ("wireless mouse ", "logitech "):
        if text.startswith(prefix):
            text = text[len(prefix) :]
    return text.strip()


def _same_device(sysfs: dict, hid: dict) -> bool:
    """Whether a sysfs node and a Solaar device describe the same hardware.

    The wireless product id is the strong signal: every receiver device has
    one. Names are the fallback, and a blank name on either side is not
    evidence of anything - a keyboard with no model_name must not be mistaken
    for the mouse Solaar just selected.
    """
    a_wpid = _id(sysfs.get("wpid"))
    b_wpid = _id(hid.get("wpid"))
    if a_wpid and b_wpid:
        return a_wpid == b_wpid
    a = _comparable_model(sysfs.get("model", ""))
    b = _comparable_model(hid.get("model", ""))
    return bool(a) and bool(b) and a == b


def _merge(payload: dict, hid: dict) -> dict:
    """Solaar's reading wins; sysfs still fills whatever it did not report.

    A receiver can carry a keyboard next to the mouse, and sysfs does not say
    which is which. When the two sides name different devices, the sysfs node
    is not the mouse, so its charge must not be lent to it.
    """
    if payload.get("present") and not _same_device(payload, hid):
        payload = _empty_battery()
    payload["present"] = True
    for key in ("model", "connection", "percent", "status", "charging", "full", "discharging"):
        value = hid.get(key)
        if value is not None and value != "":
            payload[key] = value
    for key in ("dpi", "dpi_min", "dpi_max", "dpi_step", "dpi_values", "rate_hz", "rates_hz", "onboard"):
        payload[key] = hid.get(key)
    return payload


def main() -> int:
    global _payload
    _become_session()
    _drain_stderr()
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = _CappedStdout(sys.stdout, MAX_JSON_BYTES + 1)
    signal.signal(signal.SIGTERM, _on_term)
    payload = _battery()
    _payload = payload
    wanted = _parse_set_dpi(sys.argv)
    wanted_rate = _parse_set_rate(sys.argv)
    hid = _hid_report(wanted, wanted_rate)
    if hid.get("present"):
        payload = _merge(payload, hid)
    elif not payload["present"]:
        payload = _empty_battery()
    _payload = payload
    _flush_payload()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
