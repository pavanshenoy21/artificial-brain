#!/usr/bin/env python3
"""Ask an X11 window to close (WM_DELETE_WINDOW), the way a window manager's
close button does. Used by desktop-smoke.sh, where Xvfb has no WM.
Usage: wm-close.py <window-id>   (needs python-xlib)"""
import sys
from Xlib import X, display, protocol

d = display.Display()
w = d.create_resource_object("window", int(sys.argv[1]))
proto, delete = d.intern_atom("WM_PROTOCOLS"), d.intern_atom("WM_DELETE_WINDOW")
w.send_event(protocol.event.ClientMessage(window=w, client_type=proto, data=(32, [delete, X.CurrentTime, 0, 0, 0])))
d.flush()
