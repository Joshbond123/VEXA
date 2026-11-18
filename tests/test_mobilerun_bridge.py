#!/usr/bin/env python3
"""
Unit tests for the VEXA mobilerun bridge validation + UI extraction logic.

These tests exercise the real functions in vexa-api/android/mobilerun_bridge.py
(PNG parsing, screenshot validation, a11y-tree flattening). They do not import
mobilerun itself, so they run anywhere.

Run: python3 tests/test_mobilerun_bridge.py
"""

import base64
import importlib.util
import struct
import sys
import types
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE_PATH = ROOT / 'vexa-api' / 'android' / 'mobilerun_bridge.py'

# Import the bridge module without triggering the real mobilerun import.
stub = types.ModuleType('mobilerun')
stub_tools = types.ModuleType('mobilerun.tools')


class _FakeAndroidDriver:  # pragma: no cover - never instantiated in tests
    def __init__(self, *a, **k):
        pass


stub_tools.AndroidDriver = _FakeAndroidDriver
stub.tools = stub_tools
sys.modules['mobilerun'] = stub
sys.modules['mobilerun.tools'] = stub_tools

spec = importlib.util.spec_from_file_location('mobilerun_bridge', BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

passed = 0
failed = 0


def check(cond, name):
    global passed, failed
    if cond:
        passed += 1
        print(f'PASS: {name}')
    else:
        failed += 1
        print(f'FAIL: {name}')


def make_png(width, height):
    """Build a real PNG of the given size (no PIL dependency)."""
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = bytearray()
    for _ in range(height):
        raw.append(0)  # filter type 0
        for _ in range(width):
            raw += b'\x10\x20\x30'
    idat = zlib.compress(bytes(raw), 6)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', idat) + chunk(b'IEND', b''))


# --- PNG dimension parsing ---
real = make_png(1080, 2400)
check(bridge.png_dimensions(real) == (1080, 2400), 'png_dimensions reads real 1080x2400 frame')
check(bridge.png_dimensions(b'not a png') is None, 'png_dimensions rejects non-PNG bytes')
check(bridge.png_dimensions(b'') is None, 'png_dimensions rejects empty input')

# --- Screenshot validation: the core bug was accepting 1x1 frames ---
tiny = make_png(1, 1)
try:
    bridge.validate_screenshot(tiny)
    check(False, 'validate_screenshot rejects 1x1 green-pixel frame')
except ValueError as e:
    check('1x1' in str(e), 'validate_screenshot rejects 1x1 green-pixel frame')

try:
    bridge.validate_screenshot(real)
    check(True, 'validate_screenshot accepts a real frame')
except ValueError as e:
    check(False, f'validate_screenshot accepts a real frame ({e})')

small = make_png(64, 64)
try:
    bridge.validate_screenshot(small)
    check(len(small) >= bridge.MIN_PNG_BYTES, 'small uniform frame accepted only if >= min bytes')
except ValueError:
    check(True, 'blank/small frame rejected as unusable')

# --- UI element extraction ---
ui_tree = {
    'a11y_tree': {
        'class_name': 'Root',
        'children': [
            {'text': 'Calculator', 'is_clickable': True,
             'bounds_in_screen': {'left': 0, 'top': 0, 'right': 200, 'bottom': 100}},
            {'content_description': 'Seven', 'is_clickable': True,
             'bounds_in_screen': {'left': 300, 'top': 900, 'right': 420, 'bottom': 1050}},
            {'text': '   ', 'is_clickable': False},
        ],
    },
    'phone_state': {'packageName': 'com.google.android.calculator'},
}
elements = bridge.extract_elements(ui_tree)
texts = [e['text'] for e in elements]
check('Calculator' in texts, 'extract_elements finds clickable text node')
check('Seven' in texts, 'extract_elements falls back to content_description')
check(len(elements) == 2, 'extract_elements skips non-text non-clickable nodes')
check(elements[0]['clickable'] is True, 'extract_elements marks clickable nodes')

check(bridge.foreground_package(ui_tree) == 'com.google.android.calculator',
      'foreground_package reads phone_state.packageName')
check(bridge.foreground_package({}) is None, 'foreground_package tolerates empty tree')
check(bridge.extract_elements(None) == [], 'extract_elements tolerates None')
check(bridge.extract_elements({'a11y_tree': [1, 2, 3]}) == [],
      'extract_elements tolerates non-dict nodes')

# Real mobilerun ADB trees use camelCase keys (boundsInScreen). A regression here
# silently returned bounds=None for every element, so the agent could not tap.
camel_tree = {
    'a11y_tree': {
        'text': 'Seven', 'clickable': True,
        'boundsInScreen': {'left': 300, 'top': 900, 'right': 420, 'bottom': 1050},
        'children': [
            {'contentDescription': 'Settings', 'clickable': True,
             'boundsInScreen': {'left': 10, 'top': 20, 'right': 30, 'bottom': 40}},
        ],
    },
}
camel_elements = bridge.extract_elements(camel_tree)
check(all(e['bounds'] is not None for e in camel_elements),
      'extract_elements reads camelCase boundsInScreen (regression guard)')
check(len(camel_elements) == 2, 'extract_elements walks camelCase children')
check(camel_elements[1]['text'] == 'Settings', 'extract_elements reads contentDescription label')

b64 = base64.b64encode(real).decode('ascii')
check(base64.b64decode(b64) == real, 'screenshot base64 round-trips intact')

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
