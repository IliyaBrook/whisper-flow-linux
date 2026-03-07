#!/usr/bin/env python3
"""Simulate Ctrl+V via /dev/uinput virtual keyboard.

Creates a temporary virtual input device, sends Ctrl+V key events,
and cleans up. Works on Wayland regardless of focused window type.
Requires: user in 'input' group or root for /dev/uinput access.
"""

import fcntl, struct, os, time, sys

UI_DEV_CREATE  = 0x5501
UI_DEV_DESTROY = 0x5502
UI_SET_EVBIT   = 0x40045564
UI_SET_KEYBIT  = 0x40045565

EV_SYN = 0x00
EV_KEY = 0x01
SYN_REPORT = 0x00
KEY_LEFTCTRL = 29
KEY_V = 47

def main():
    try:
        fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
    except PermissionError:
        print('ERROR: no access to /dev/uinput', file=sys.stderr)
        sys.exit(1)

    # Configure: EV_KEY events, register Ctrl and V keys
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    fcntl.ioctl(fd, UI_SET_KEYBIT, KEY_LEFTCTRL)
    fcntl.ioctl(fd, UI_SET_KEYBIT, KEY_V)

    # Write legacy uinput_user_dev struct (1116 bytes)
    name = b'wispr-flow-vkbd\x00' + b'\x00' * 64  # 80 bytes name
    # id: bustype=BUS_VIRTUAL(6), vendor=1, product=1, version=1
    dev_id = struct.pack('<HHHHi', 6, 1, 1, 1, 0)  # 12 bytes (id + ff_effects_max)
    abs_data = b'\x00' * (4 * 64 * 4)  # absmax, absmin, absfuzz, absflat
    os.write(fd, name + dev_id + abs_data)

    # Create the virtual device
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.05)  # Wait for compositor to register the device

    def emit(ev_type, code, value):
        # struct input_event: timeval(16 bytes) + type(2) + code(2) + value(4) = 24 bytes
        os.write(fd, struct.pack('<QQHHi', 0, 0, ev_type, code, value))

    def syn():
        emit(EV_SYN, SYN_REPORT, 0)

    # Simulate Ctrl+V
    emit(EV_KEY, KEY_LEFTCTRL, 1); syn(); time.sleep(0.01)
    emit(EV_KEY, KEY_V, 1);        syn(); time.sleep(0.01)
    emit(EV_KEY, KEY_V, 0);        syn(); time.sleep(0.01)
    emit(EV_KEY, KEY_LEFTCTRL, 0); syn()
    time.sleep(0.03)

    # Cleanup
    fcntl.ioctl(fd, UI_DEV_DESTROY)
    os.close(fd)

if __name__ == '__main__':
    main()
