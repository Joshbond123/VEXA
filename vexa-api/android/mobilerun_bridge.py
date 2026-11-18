"""
VEXA mobilerun (droidrun) Android device bridge.

Wraps mobilerun's ``AndroidDriver`` (``mobilerun_core_local.driver.android.adb``)
in a small HTTP API so the VEXA AI agent (Node.js, on a different host) can drive
a real Android device/emulator over ADB.

Verified driver API (mobilerun-core-local 0.7.x):

    from mobilerun.tools import AndroidDriver        # full `mobilerun` install
    from mobilerun_core_local import AndroidDriver   # slim `mobilerun-core-local`
    drv = AndroidDriver(serial=None, use_tcp=False, portal_mode="auto")
    await drv.connect()
    png: bytes          = await drv.screenshot(hide_overlay=True)
    tree: dict          = await drv.get_ui_tree(filter=True)
    await drv.tap(x, y)
    await drv.swipe(x1, y1, x2, y2, duration_ms)
    ok: bool            = await drv.input_text(text, clear=False)
    await drv.press_key_code(code)
    await drv.press_button("back"|"home"|"enter")
    await drv.start_app(package, activity=None)
    await drv.stop_app(package)
    await drv.list_packages(include_system=False)
    await drv.get_apps(include_system=False)

Screenshots: ``adb exec-out screencap -p`` is the primary capture path because it
streams a complete PNG in well under a second and never writes to the device.
mobilerun's own ``screenshot()`` shells out to ``screencap -p <file>`` and pulls
the file; on a software-rendered emulator that path takes 60-90s (and on some
devices never returns), which is what left the agent blind. The driver is tried
first with a short timeout and exec-out is the reliable fallback. Every frame is
validated (PNG magic + real dimensions) before it is reported as usable.

Endpoints
    GET  /health
    GET  /device/connect
    GET  /device/screenshot      -> {ok, screenshot_base64, bytes, width, height}
    GET  /device/ui              -> {ok, ui_tree, elements:[{text,bounds,clickable}]}
    GET  /device/state           -> {ok, package, screenshot meta, ui summary}
    GET  /device/apps            -> {ok, apps, packages}
    POST /device/tap             {x,y}
    POST /device/swipe           {x1,y1,x2,y2,duration_ms}
    POST /device/scroll          {x,y,direction}
    POST /device/type            {text,clear}
    POST /device/key             {keycode}
    POST /device/press_button    {button}
    POST /device/launch_app      {package}
    POST /device/stop_app        {package}
    POST /device/install_app     {path}

Environment
    MOBILERUN_SERIAL           adb serial (e.g. emulator-5554). Auto-detected if unset.
    MOBILERUN_PORT             HTTP port (default 8765)
    MOBILERUN_HOST             bind host (default 0.0.0.0)
    MOBILERUN_CONNECT_RETRIES  connection retry count (default 30)
    MOBILERUN_CONNECT_DELAY    seconds between retries (default 5)
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# mobilerun-core-local is the slim driver package that actually ships the
# `mobilerun_core_local` namespace and needs no LLM/llama-index stack. The full
# `mobilerun` distribution provides `mobilerun.tools`; prefer it when present.
try:
    from mobilerun.tools import AndroidDriver  # type: ignore
except ImportError:  # pragma: no cover - depends on install layout
    from mobilerun_core_local import AndroidDriver  # type: ignore

SERIAL = os.environ.get('MOBILERUN_SERIAL') or None
PORT = int(os.environ.get('MOBILERUN_PORT', '8765'))
HOST = os.environ.get('MOBILERUN_HOST', '0.0.0.0')
CONNECT_RETRIES = int(os.environ.get('MOBILERUN_CONNECT_RETRIES', '30'))
CONNECT_DELAY = int(os.environ.get('MOBILERUN_CONNECT_DELAY', '5'))

# How long to wait for mobilerun's own screenshot() before falling back.
# Its implementation runs `screencap -p <file>` over the adb shell, which on a
# software-rendered emulator can take 60-90s (and on some devices never returns
# at all). `exec-out screencap -p` streams the same frame in well under a second,
# so it is the primary path and the driver is only a first attempt.
DRIVER_SCREENSHOT_TIMEOUT = float(os.environ.get('MOBILERUN_SCREENSHOT_TIMEOUT', '25'))

# A single background event loop owns the AndroidDriver so that the async adb
# client stays bound to one loop. HTTP handlers schedule coroutines onto it.
_loop = None
_loop_thread = None
_driver = None
_driver_lock = threading.Lock()
_connect_error = None
_connect_retries_left = CONNECT_RETRIES


def _start_loop():
    global _loop, _loop_thread

    def run():
        global _loop
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
        _loop.run_forever()

    _loop_thread = threading.Thread(target=run, daemon=True)
    _loop_thread.start()
    while _loop is None:
        time.sleep(0.01)


def run_async(coro, timeout=30):
    """Schedule ``coro`` on the background loop and wait for its result."""
    global _loop
    if _loop is None:
        _start_loop()
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


def get_driver():
    global _driver, _connect_error, _connect_retries_left
    with _driver_lock:
        if _driver is None:
            _driver = AndroidDriver(serial=SERIAL, use_tcp=False, portal_mode='auto')
            last_err = None
            for attempt in range(CONNECT_RETRIES):
                try:
                    run_async(_driver.connect(), timeout=25)
                    _connect_error = None
                    _connect_retries_left = 0
                    return _driver
                except Exception as exc:
                    last_err = str(exc)
                    _connect_error = f"Attempt {attempt + 1}/{CONNECT_RETRIES}: {last_err}"
                    if attempt < CONNECT_RETRIES - 1:
                        time.sleep(CONNECT_DELAY)
            _connect_retries_left = 0
            _connect_error = str(last_err)
        return _driver


def adb_binary():
    """Locate the adb executable mobilerun itself resolves (honours ADBUTILS_ADB_PATH)."""
    explicit = os.environ.get('ADBUTILS_ADB_PATH')
    if explicit and os.path.exists(explicit):
        return explicit
    found = shutil.which('adb')
    if found:
        return found
    return 'adb'


def adb_serial():
    """Best-known serial for this device: explicit env, else the driver's own."""
    if SERIAL:
        return SERIAL
    if _driver is not None:
        serial = getattr(_driver, '_serial', None) or getattr(_driver, 'serial', None)
        if serial:
            return serial
    return None


def capture_screenshot_exec_out(timeout=25):
    """Capture a real frame with `adb exec-out screencap -p`.

    This is the reliable path. It returns the raw PNG bytes or raises with a
    message explaining exactly what went wrong.
    """
    cmd = [adb_binary()]
    serial = adb_serial()
    if serial:
        cmd += ['-s', serial]
    cmd += ['exec-out', 'screencap', '-p']
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'exec-out screencap timed out after {timeout}s')
    if proc.returncode != 0:
        err = (proc.stderr or b'').decode('utf-8', 'ignore').strip()
        raise RuntimeError(f'exec-out screencap failed (rc={proc.returncode}): {err[:200]}')
    if not proc.stdout:
        raise RuntimeError('exec-out screencap returned no data')
    return proc.stdout


def capture_screenshot():
    """Return a validated PNG frame, preferring the fast exec-out path.

    Returns (png_bytes, width, height, source). Raises if no usable frame can be
    obtained, so the caller never reports a placeholder as a live screen.
    """
    errors = []
    # exec-out streams a full PNG in well under a second; mobilerun's file-based
    # screencap can take 60-90s on a software-rendered emulator, so it is only a
    # fallback for devices where exec-out binary output is mangled.
    try:
        png = capture_screenshot_exec_out()
        width, height = validate_screenshot(png)
        return png, width, height, 'adb-exec-out'
    except Exception as exc:
        errors.append(f'adb-exec-out: {exc}')
    driver = get_driver()
    if driver is not None:
        try:
            png = run_async(driver.screenshot(hide_overlay=True),
                            timeout=DRIVER_SCREENSHOT_TIMEOUT)
            width, height = validate_screenshot(png)
            return png, width, height, 'mobilerun-driver'
        except Exception as exc:
            errors.append(f'mobilerun-driver: {exc}')
    raise RuntimeError('no usable screenshot: ' + ' | '.join(errors))


# --------------------------------------------------------------------------- #
# PNG validation - reject the 1x1 / blank captures the old pipeline accepted.
# --------------------------------------------------------------------------- #

PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
MIN_PNG_BYTES = 2000


def png_dimensions(data: bytes):
    """Return (width, height) from a PNG IHDR, or None if not a valid PNG."""
    if len(data) < 24 or data[:8] != PNG_MAGIC:
        return None
    if data[12:16] != b'IHDR':
        return None
    width, height = struct.unpack('>II', data[16:24])
    return width, height


def validate_screenshot(data: bytes):
    """Raise if ``data`` is not a usable, non-trivial screenshot."""
    dims = png_dimensions(data)
    if dims is None:
        raise ValueError('screenshot is not a valid PNG')
    width, height = dims
    if width < 64 or height < 64:
        raise ValueError(f'screenshot is a {width}x{height} placeholder, not a real frame')
    if len(data) < MIN_PNG_BYTES:
        raise ValueError(f'screenshot is only {len(data)} bytes (blank/uniform frame)')
    return width, height


# --------------------------------------------------------------------------- #
# UI hierarchy helpers - turn mobilerun's a11y tree into clickable elements.
# --------------------------------------------------------------------------- #

def _walk(node):
    if not node:
        return
    if isinstance(node, list):
        for child in node:
            yield from _walk(child)
        return
    if isinstance(node, dict):
        yield node
        for child in node.get('children') or []:
            yield from _walk(child)


def extract_elements(ui_tree, limit=120):
    """Flatten a mobilerun a11y tree into a compact list of interactive elements."""
    if not isinstance(ui_tree, dict):
        return []
    root = ui_tree.get('a11y_tree')
    elements = []
    for node in _walk(root):
        raw_text = (node.get('text') or node.get('content_description')
                    or node.get('contentDescription') or '')
        text = str(raw_text).strip()
        clickable = node.get('is_clickable', node.get('clickable'))
        # mobilerun's ADB a11y tree uses camelCase (boundsInScreen); the Portal
        # path uses snake_case (bounds_in_screen). Accept both.
        bounds = (node.get('bounds_in_screen') or node.get('boundsInScreen')
                  or node.get('bounds'))
        # Skip nodes that carry neither a usable label nor a clickable target;
        # real a11y trees are full of whitespace-only layout wrappers.
        if not text and not clickable:
            continue
        if not text and not bounds:
            continue
        elements.append({
            'text': text[:120],
            'clickable': bool(clickable),
            'bounds': bounds,
            'class': node.get('class_name') or node.get('className') or '',
        })
        if len(elements) >= limit:
            break
    return elements


def foreground_package(ui_tree):
    if not isinstance(ui_tree, dict):
        return None
    phone_state = ui_tree.get('phone_state') or {}
    return phone_state.get('packageName') or phone_state.get('package_name')


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #

def _respond(handler, status, payload):
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler):
    length = int(handler.headers.get('Content-Length', 0) or 0)
    return handler.rfile.read(length) if length else b''


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = 'VEXA-mobilerun-bridge/2.0'

    def log_message(self, fmt, *args):  # noqa: A002
        return

    def _capture(self):
        png, width, height, source = capture_screenshot()
        return png, width, height, source

    def _ui(self):
        drv = get_driver()
        last_err = None
        # uiautomator dump occasionally fails while the UI is mid-animation;
        # retry a couple of times before giving up.
        for attempt in range(3):
            try:
                tree = run_async(drv.get_ui_tree(filter=True), timeout=30)
                if isinstance(tree, dict) and tree.get('a11y_tree'):
                    return tree
                last_err = RuntimeError('ui tree empty')
            except Exception as exc:
                last_err = exc
            time.sleep(1.0)
        if last_err:
            raise last_err
        return {}

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        try:
            if path == '/health':
                return _respond(self, 200, {
                    'ok': True,
                    'service': 'vexa-mobilerun-bridge',
                    'driver': _driver is not None,
                    'connected': bool(getattr(_driver, '_connected', False)),
                    'connect_error': _connect_error,
                    'serial': SERIAL or 'auto',
                    'retries_left': _connect_retries_left,
                })

            if path == '/device/connect':
                drv = get_driver()
                return _respond(self, 200, {
                    'ok': _connect_error is None,
                    'connected': _connect_error is None,
                    'serial': SERIAL or 'auto',
                    'platform': getattr(drv, 'platform', 'Android'),
                    'portal': bool(getattr(drv, 'portal_available', False)),
                    'error': _connect_error,
                })

            if path == '/device/screenshot':
                png, width, height, source = self._capture()
                return _respond(self, 200, {
                    'ok': True,
                    'screenshot_base64': base64.b64encode(png).decode('ascii'),
                    'bytes': len(png),
                    'width': width,
                    'height': height,
                    'source': source,
                    'captured_at': time.time(),
                })

            if path == '/device/ui':
                ui = self._ui()
                return _respond(self, 200, {
                    'ok': True,
                    'package': foreground_package(ui),
                    'elements': extract_elements(ui),
                    'ui_tree': ui,
                })

            if path == '/device/state':
                try:
                    ui = self._ui()
                except Exception as exc:
                    ui = {'error': str(exc)}
                try:
                    png, width, height, source = self._capture()
                    shot = {
                        'screenshot_base64': base64.b64encode(png).decode('ascii'),
                        'bytes': len(png),
                        'width': width,
                        'height': height,
                        'source': source,
                    }
                except Exception as exc:
                    shot = {'error': str(exc)}
                return _respond(self, 200, {
                    'ok': True,
                    'package': foreground_package(ui),
                    'elements': extract_elements(ui),
                    'screenshot': shot,
                    'ui_tree': ui,
                })

            if path == '/device/apps':
                drv = get_driver()
                try:
                    apps = run_async(drv.get_apps(include_system=False), timeout=25) or []
                except Exception:
                    apps = []
                try:
                    packages = run_async(drv.list_packages(include_system=False), timeout=25) or []
                except Exception:
                    packages = []
                return _respond(self, 200, {
                    'ok': True,
                    'apps': apps,
                    'packages': packages[:200],
                    'package_count': len(packages),
                })

            return _respond(self, 404, {'ok': False, 'error': 'unknown endpoint'})
        except Exception as exc:
            return _respond(self, 500, {'ok': False, 'error': str(exc)})

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        try:
            body = _read_body(self)
            data = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            data = {}
        try:
            drv = get_driver()

            if path == '/device/tap':
                x, y = int(data.get('x', 540)), int(data.get('y', 1200))
                run_async(drv.tap(x, y), timeout=25)
                return _respond(self, 200, {'ok': True, 'action': 'tap', 'x': x, 'y': y})

            if path == '/device/swipe':
                x1, y1 = int(data.get('x1', 540)), int(data.get('y1', 1500))
                x2, y2 = int(data.get('x2', 540)), int(data.get('y2', 500))
                ms = float(data.get('duration_ms', 300))
                run_async(drv.swipe(x1, y1, x2, y2, ms), timeout=30)
                return _respond(self, 200, {'ok': True, 'action': 'swipe', 'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2})

            if path == '/device/scroll':
                x = int(data.get('x', 540))
                y = int(data.get('y', 1200))
                direction = str(data.get('direction', 'down')).lower()
                if direction in ('down', 'desc'):
                    run_async(drv.swipe(x, 1700, x, 700, 300), timeout=25)
                else:
                    run_async(drv.swipe(x, 700, x, 1700, 300), timeout=25)
                return _respond(self, 200, {'ok': True, 'action': 'scroll', 'direction': direction})

            if path == '/device/type':
                ok = run_async(
                    drv.input_text(str(data.get('text', '')), clear=bool(data.get('clear', False))),
                    timeout=25,
                )
                return _respond(self, 200, {'ok': True, 'action': 'type', 'text': data.get('text', ''), 'accepted': bool(ok)})

            if path == '/device/key':
                keycode = int(data.get('keycode', 66))
                run_async(drv.press_key_code(keycode), timeout=25)
                return _respond(self, 200, {'ok': True, 'action': 'key', 'keycode': keycode})

            if path == '/device/press_button':
                button = str(data.get('button', 'home')).lower()
                run_async(drv.press_button(button), timeout=25)
                return _respond(self, 200, {'ok': True, 'action': 'press_button', 'button': button})

            if path == '/device/launch_app':
                package = str(data.get('package', ''))
                if not package:
                    return _respond(self, 400, {'ok': False, 'error': 'package is required'})
                result = run_async(drv.start_app(package), timeout=30)
                return _respond(self, 200, {'ok': True, 'action': 'launch_app', 'package': package, 'result': result})

            if path == '/device/stop_app':
                package = str(data.get('package', ''))
                result = run_async(drv.stop_app(package), timeout=30)
                return _respond(self, 200, {'ok': True, 'action': 'stop_app', 'package': package, 'result': result})

            if path == '/device/install_app':
                apk_path = str(data.get('path', ''))
                result = run_async(drv.install_app(apk_path), timeout=180)
                return _respond(self, 200, {'ok': True, 'action': 'install_app', 'path': apk_path, 'result': result})

            return _respond(self, 404, {'ok': False, 'error': 'unknown endpoint'})
        except Exception as exc:
            return _respond(self, 500, {'ok': False, 'error': str(exc)})


def main():
    _start_loop()

    class ReuseThreadingHTTPServer(ThreadingHTTPServer):
        allow_reuse_address = True

    server = ReuseThreadingHTTPServer((HOST, PORT), BridgeHandler)
    print(f'[VEXA mobilerun bridge] Listening on http://{HOST}:{PORT} (serial={SERIAL or "auto"})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if _loop:
            _loop.call_soon_threadsafe(_loop.stop)


if __name__ == '__main__':
    main()
