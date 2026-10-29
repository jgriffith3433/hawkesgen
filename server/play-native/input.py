#!/usr/bin/env python3
# Real OS input for hawkes-play-native (docs/play-native.md, "Input"): one JSON object per line on stdin, one answer
# per line on stdout. Keyboard and mouse go in through XTEST on the game's X display (the X server delivers them like
# a real keyboard's); the gamepad is a uinput Xbox 360 pad, when the host gives this container /dev/uinput.
#
#   {"op":"key","key":"Return","down":true}      a key by X keysym name (Return, space, Escape, Left, a, F1...);
#                                                 "down" omitted = press and release
#   {"op":"move","x":640,"y":360}                 the pointer, in screen pixels
#   {"op":"button","button":1,"down":true}        1 left, 2 middle, 3 right; "down" omitted = click
#   {"op":"scroll","dy":-1}                        wheel (negative = up)
#   {"op":"pad","button":"a","down":true}         a b x y lb rb back start guide ls rs, dpad_up/down/left/right
#   {"op":"axis","axis":"lx","value":-1.0}        lx ly rx ry (-1..1), lt rt (0..1)
#
# The first line out says what works: {"ready":true,"pad":true|false,"padError":...}.
import json
import os
import sys
import time

from Xlib import X, XK, display as xdisplay
from Xlib.ext import xtest

d = xdisplay.Display(os.environ.get("DISPLAY", ":0"))

pad = None
pad_error = None
try:
    from evdev import UInput, AbsInfo, ecodes as e

    BUTTONS = {
        "a": e.BTN_SOUTH, "b": e.BTN_EAST, "x": e.BTN_NORTH, "y": e.BTN_WEST, "lb": e.BTN_TL, "rb": e.BTN_TR,
        "back": e.BTN_SELECT, "start": e.BTN_START, "guide": e.BTN_MODE, "ls": e.BTN_THUMBL, "rs": e.BTN_THUMBR,
    }
    STICK = AbsInfo(value=0, min=-32768, max=32767, fuzz=16, flat=128, resolution=0)
    TRIGGER = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)
    HAT = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)
    AXES = {"lx": (e.ABS_X, STICK), "ly": (e.ABS_Y, STICK), "rx": (e.ABS_RX, STICK), "ry": (e.ABS_RY, STICK), "lt": (e.ABS_Z, TRIGGER), "rt": (e.ABS_RZ, TRIGGER)}
    DPAD = {"dpad_left": (e.ABS_HAT0X, -1), "dpad_right": (e.ABS_HAT0X, 1), "dpad_up": (e.ABS_HAT0Y, -1), "dpad_down": (e.ABS_HAT0Y, 1)}
    if not os.path.exists("/dev/uinput"):
        raise OSError("no /dev/uinput in this container")
    caps = {
        e.EV_KEY: list(BUTTONS.values()),
        e.EV_ABS: [(code, info) for code, info in AXES.values()] + [(e.ABS_HAT0X, HAT), (e.ABS_HAT0Y, HAT)],
    }
    pad = UInput(caps, name="Microsoft X-Box 360 pad", vendor=0x045E, product=0x028E, version=0x110, bustype=e.BUS_USB)
    # Without udev nobody makes the /dev/input node or opens it to the game's user: do both when we can.
    time.sleep(0.2)
    try:
        node = pad.device.path
        os.chmod(node, 0o666)
    except Exception as ex:  # the kernel made the device, but this container's /dev doesn't show it
        pad_error = "pad made, but no /dev/input node for it here (%s)" % ex
except Exception as ex:
    pad = None
    pad_error = str(ex)

BUTTON_X = {1: 1, 2: 2, 3: 3}


def keycode(name):
    sym = XK.string_to_keysym(name)
    if not sym and len(name) == 1:
        sym = ord(name)
    if not sym:
        raise ValueError("unknown key %r" % name)
    code = d.keysym_to_keycode(sym)
    if not code:
        raise ValueError("no keycode for %r on this display" % name)
    return code


def key(name, down):
    code = keycode(name)
    for state in ([True, False] if down is None else [bool(down)]):
        xtest.fake_input(d, X.KeyPress if state else X.KeyRelease, code)
        d.sync()
        if down is None:
            time.sleep(0.05)


def button(b, down):
    b = BUTTON_X.get(int(b), int(b))
    for state in ([True, False] if down is None else [bool(down)]):
        xtest.fake_input(d, X.ButtonPress if state else X.ButtonRelease, b)
        d.sync()
        if down is None:
            time.sleep(0.05)


def handle(m):
    op = m.get("op")
    if op == "key":
        key(str(m["key"]), m.get("down"))
    elif op == "move":
        xtest.fake_input(d, X.MotionNotify, x=int(m["x"]), y=int(m["y"]))
        d.sync()
    elif op == "button":
        button(m.get("button", 1), m.get("down"))
    elif op == "scroll":
        n = int(m.get("dy", 1))
        for _ in range(abs(n)):
            button(4 if n < 0 else 5, None)
    elif op in ("pad", "axis"):
        if not pad:
            raise RuntimeError("no virtual gamepad here: %s" % pad_error)
        if op == "pad":
            name = str(m["button"])
            down = m.get("down")
            for state in ([True, False] if down is None else [bool(down)]):
                if name in DPAD:
                    code, v = DPAD[name]
                    pad.write(e.EV_ABS, code, v if state else 0)
                else:
                    pad.write(e.EV_KEY, BUTTONS[name], 1 if state else 0)
                pad.syn()
                if down is None:
                    time.sleep(0.06)
        else:
            code, info = AXES[str(m["axis"])]
            v = max(-1.0, min(1.0, float(m.get("value", 0))))
            pad.write(e.EV_ABS, code, int(v * info.max) if info.min < 0 else int(max(0.0, v) * info.max))
            pad.syn()
    else:
        raise ValueError("unknown op %r" % op)


def out(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


out({"ready": True, "pad": bool(pad) and not pad_error, "padError": pad_error})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = None
    try:
        msg = json.loads(line)
        handle(msg)
        out({"ok": True, "n": msg.get("n")})
    except Exception as ex:
        out({"ok": False, "error": str(ex)[:300], "n": msg.get("n") if isinstance(msg, dict) else None})
