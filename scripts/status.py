#!/usr/bin/python3
"""Read G502 X LIGHTSPEED charge from sysfs and DPI over HID++. Prints one JSON object."""

from __future__ import annotations

import json
import os
import select
import signal
import sys
import time
from pathlib import Path

SYSFS_ROOT = Path("/sys/class/power_supply")

# G502 X family on the LIGHTSPEED dongle only.
TRUSTED_VID = "046D"
TRUSTED_RECEIVER_PID = "C547"
# 409F: G502 X LIGHTSPEED, 4099: G502 X PLUS
TRUSTED_WPIDS = ("409F", "4099")

JOB_DEADLINE_SEC = 2.0
MAX_SYSFS_BYTES = 256
MAX_TEXT = 48
MAX_JSON_BYTES = 2048
MAX_STDERR_BYTES = 4096
# The HID++ reply JSON is ~100 bytes at its widest (dpi, percent, a status
# label and three flags). Cutting it short at this bound leaves invalid JSON,
# and an unparsable reply is dropped exactly like a missing mouse, which
# silently costs the DPI reading.
MAX_HID_REPLY = 256
MAX_BATTERY_NODES = 8
# What the HID++ ADJUSTABLE_DPI feature takes. Checking the range instead of a
# copy of the shipped presets keeps the helper and the panel from drifting
# apart - a stale copy silently drops writes.
DPI_MIN = 100
DPI_MAX = 25600
DPI_STEP = 50
KNOWN_MODELS = (
    "G502 X LIGHTSPEED",
    "Logitech G502 X LIGHTSPEED",
    "G502 X PLUS",
    "Logitech G502 X PLUS",
    "Logitech G502 X LS",
    "G502 X LS",
    "G502 X",
)
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


def _trusted_battery(entry: Path) -> bool:
    device = entry / "device"
    try:
        hid = device.resolve()
    except OSError:
        return False
    vid, pid = _hid_vid_pid(_read(hid / "uevent"))
    if vid != TRUSTED_VID or pid not in TRUSTED_WPIDS:
        return False
    parent = hid.parent
    if parent is None:
        return False
    pvid, ppid = _hid_vid_pid(_read(parent / "uevent"))
    return pvid == TRUSTED_VID and ppid == TRUSTED_RECEIVER_PID


def _status_label(raw: str) -> str:
    return STATUS_LABELS.get(_plain(raw, 32).lower(), "Unknown")


def _model_label(raw: str) -> str:
    name = _plain(raw, MAX_TEXT)
    for known in KNOWN_MODELS:
        if name.casefold() == known.casefold():
            return known
    # Not one of the spellings above: report the name the device gave rather
    # than assuming the base model, since a PLUS labelled "G502 X" would be
    # wrong on the bar, in the panel and in the notification. _plain has already
    # bounded it to printable ASCII and MAX_TEXT, so it is safe to display.
    return name or "G502 X"


def _empty_battery() -> dict:
    return {
        "present": False,
        "model": "",
        "percent": None,
        "status": "",
        "charging": False,
        "full": False,
        "discharging": False,
        "dpi": None,
    }


def _battery() -> dict:
    found = 0
    for entry in sorted(SYSFS_ROOT.glob("hidpp_battery_*")):
        found += 1
        if found > MAX_BATTERY_NODES:
            break
        if not _trusted_battery(entry):
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
        return {
            "present": True,
            "model": _model_label(_read(entry / "model_name")),
            "percent": percent,
            "status": status,
            "charging": charging and not full,
            "full": full,
            "discharging": discharging,
        }
    return _empty_battery()


def _trusted_receiver(info) -> bool:
    return _id(getattr(info, "vendor_id", None)) == TRUSTED_VID and _id(
        getattr(info, "product_id", None)
    ) == TRUSTED_RECEIVER_PID


def _trusted_device(dev) -> bool:
    if _id(getattr(dev, "wpid", None)) not in TRUSTED_WPIDS:
        return False
    rec = getattr(dev, "receiver", None)
    rec_pid = _id(getattr(rec, "product_id", None) if rec is not None else None)
    rec_vid = _id(getattr(rec, "vendor_id", None) if rec is not None else None)
    if rec_pid != TRUSTED_RECEIVER_PID:
        return False
    if rec_vid and rec_vid != TRUSTED_VID:
        return False
    return True


def _close(dev) -> None:
    closer = getattr(dev, "close", None)
    if callable(closer):
        try:
            closer()
        except Exception:
            pass


def _devices():
    from logitech_receiver import base
    from logitech_receiver import receiver as hid_receiver

    for info in base.receivers_and_devices():
        if getattr(info, "isDevice", False):
            continue
        if not _trusted_receiver(info):
            continue
        try:
            opened = hid_receiver.create_receiver(base, info)
            candidates = list(opened) if opened else []
        except Exception:
            continue
        for item in candidates:
            if item and _trusted_device(item):
                yield item


def _read_unified_battery(dev) -> dict:
    from logitech_receiver.hidpp20_constants import SupportedFeature

    reply = dev.feature_request(SupportedFeature.UNIFIED_BATTERY, 0x10)
    if not reply or len(reply) < 4:
        return {}
    percent = int(reply[0])
    status_byte = int(reply[2])
    ext_power = int(reply[3])
    if percent <= 0 or percent > 100:
        percent = None
    charging = status_byte in (1, 2, 4) or (ext_power != 0 and status_byte == 0)
    full = status_byte == 3
    discharging = status_byte == 0 and not charging
    if full:
        label = "Full"
        charging = False
    elif charging:
        label = "Charging"
    elif discharging:
        label = "Discharging"
    else:
        label = "Unknown"
    return {
        "percent": percent,
        "status": label,
        "charging": charging,
        "full": full,
        "discharging": discharging,
    }


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


def _hid_work(set_to: int | None) -> dict:
    matched = None
    out = {
        "dpi": None,
        "percent": None,
        "status": "",
        "charging": False,
        "full": False,
        "discharging": False,
    }
    try:
        for dev in _devices():
            matched = dev
            out.update(_read_unified_battery(dev))
            if set_to is not None:
                out["dpi"] = _set_dpi(dev, set_to)
            else:
                out["dpi"] = _read_dpi(dev)
            return out
    except Exception:
        return out
    finally:
        if matched is not None:
            _close(matched)
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


def _hid_report(set_to: int | None) -> dict:
    empty = {
        "dpi": None,
        "percent": None,
        "status": "",
        "charging": False,
        "full": False,
        "discharging": False,
    }
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
            payload = _hid_work(set_to)
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
    if value < DPI_MIN or value > DPI_MAX or value % DPI_STEP:
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


def main() -> int:
    global _payload
    _become_session()
    _drain_stderr()
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = _CappedStdout(sys.stdout, MAX_JSON_BYTES + 1)
    signal.signal(signal.SIGTERM, _on_term)
    payload = _battery()
    payload["dpi"] = None
    _payload = payload
    wanted = _parse_set_dpi(sys.argv)
    if payload["present"]:
        hid = _hid_report(wanted)
        if hid.get("dpi") is not None:
            try:
                payload["dpi"] = int(hid["dpi"])
            except (TypeError, ValueError):
                payload["dpi"] = None
        if hid.get("percent") is not None:
            try:
                payload["percent"] = max(0, min(100, int(hid["percent"])))
            except (TypeError, ValueError):
                pass
        if hid.get("status") in STATUS_LABELS.values():
            payload["status"] = hid["status"]
            payload["charging"] = hid.get("charging") is True
            payload["full"] = hid.get("full") is True
            payload["discharging"] = hid.get("discharging") is True
        _payload = payload
    _payload = None
    _emit(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
