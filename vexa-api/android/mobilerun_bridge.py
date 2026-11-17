"""
VEXA mobilerun (droidrun) Android device bridge.

Wraps mobilerun's AndroidDriver (async_adbutils backend) in a small HTTP API
so the VEXA AI agent (Node.js) can perform genuine Android operations:

  connect / state / screenshot / tap / swipe / scroll / type / key / launch_app / install_app

The bridge runs on the same host as the Android emulator (or with a real
device via adb). All adb state stays on this host — nothing is exposed to the
frontend.

Environment:
  MOBILERUN_SERIAL   adb serial (e.g. emulator-5554). Auto-detected if unset.
  MOBILERUN_PORT     HTTP port (default 8765)
  MOBILERUN_HOST     bind host (default 127.0.0.1)
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mobilerun.tools import AndroidDriver

SERIAL = os.environ.get('MOBILERUN_SERIAL') or None
PORT = int(os.environ.get('MOBILERUN_PORT', '8765'))
HOST = os.environ.get('MOBILERUN_HOST', '127.0.0.1')

# A single background event loop owns the AndroidDriver so that adb async state
# (the async_adbutils client) stays on one loop. HTTP handlers schedule
# coroutines onto it and block for the result.
_loop = None
_loop_thread = None
_driver = None
_driver_lock = threading.Lock()
_connect_error = None


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
        pass


def run_async(coro, timeout=30):
    """Schedule `coro` on the background loop and wait for its result."""
    global _driver
    if _loop is None:
        _start_loop()
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


def get_driver():
    global _driver, _connect_error
    with _driver_lock:
        if _driver is None:
            _driver = AndroidDriver(serial=SERIAL, use_tcp=False)
            try:
                run_async(_driver.connect(), timeout=20)
            except Exception as exc:
                # Report per-request rather than crash at startup: the device
                # may not be booted yet when the bridge starts.
                _connect_error = str(exc)
        return _driver


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #

def _respond(handler, status, payload):
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler):
    length = int(handler.headers.get('Content-Length', 0) or 0)
    return handler.rfile.read(length) if length else b''


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = 'VEXA-mobilerun-bridge/1.0'

    def log_message(self, format, *args):  # noqa: A002
        return

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        try:
            if path == '/health':
                drv_ok = _driver is not None
                return _respond(self, 200, {'ok': True, 'service': 'vexa-mobilerun-bridge', 'driver': drv_ok, 'connect_error': _connect_error, 'serial': SERIAL or 'auto'})
            if path == '/device/connect':
                drv = get_driver()
                return _respond(self, 200, {'ok': True, 'connected': True, 'serial': SERIAL or 'auto', 'platform': getattr(drv, 'platform', 'android'), 'error': _connect_error})
            if path == '/device/screenshot':
                drv = get_driver()
                png = run_async(drv.screenshot(hide_overlay=True), timeout=20)
                return _respond(self, 200, {'ok': True, 'screenshot_base64': base64.b64encode(png).decode('ascii'), 'bytes': len(png)})
            if path == '/device/state':
                drv = get_driver()
                apps, packages, ui = [], [], {}
                try:
                    apps = run_async(drv.get_apps(include_system=False), timeout=20) or []
                except Exception:
                    apps = []
                try:
                    packages = run_async(drv.list_packages(include_system=False), timeout=20) or []
                except Exception:
                    packages = []
                try:
                    ui = run_async(drv.get_ui_tree(filter=True), timeout=20) or {}
                except Exception:
                    ui = {}
                return _respond(self, 200, {'ok': True, 'apps': apps, 'packages': packages[:50], 'ui_tree': ui, 'package_count': len(packages)})
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
            if path == '/device/tap':
                drv = get_driver()
                run_async(drv.tap(int(data.get('x', 540)), int(data.get('y', 1200))), timeout=20)
                return _respond(self, 200, {'ok': True, 'action': 'tap', 'x': data.get('x'), 'y': data.get('y')})
            if path == '/device/swipe':
                drv = get_driver()
                run_async(drv.swipe(int(data.get('x1', 540)), int(data.get('y1', 1500)), int(data.get('x2', 540)), int(data.get('y2', 500)), float(data.get('duration_ms', 300))), timeout=20)
                return _respond(self, 200, {'ok': True, 'action': 'swipe', 'x1': data.get('x1'), 'y1': data.get('y1'), 'x2': data.get('x2'), 'y2': data.get('y2')})
            if path == '/device/scroll':
                drv = get_driver()
                x = int(data.get('x', 540)); y = int(data.get('y', 1200))
                direction = str(data.get('direction', 'down')).lower()
                if direction in ('down', 'desc'):
                    run_async(drv.swipe(x, 1700, x, 700, 300), timeout=20)
                else:
                    run_async(drv.swipe(x, 700, x, 1700, 300), timeout=20)
                return _respond(self, 200, {'ok': True, 'action': 'scroll', 'direction': direction})
            if path == '/device/type':
                drv = get_driver()
                ok = run_async(drv.input_text(str(data.get('text', '')), clear=bool(data.get('clear', False))), timeout=20)
                return _respond(self, 200, {'ok': True, 'action': 'type', 'text': data.get('text', ''), 'accepted': bool(ok)})
            if path == '/device/key':
                drv = get_driver()
                run_async(drv.press_key_code(int(data.get('keycode', 66))), timeout=20)
                return _respond(self, 200, {'ok': True, 'action': 'key', 'keycode': data.get('keycode')})
            if path == '/device/press_button':
                drv = get_driver()
                run_async(drv.press_button(str(data.get('button', 'home'))), timeout=20)
                return _respond(self, 200, {'ok': True, 'action': 'press_button', 'button': data.get('button')})
            if path == '/device/launch_app':
                drv = get_driver()
                result = run_async(drv.start_app(str(data.get('package', ''))), timeout=30)
                return _respond(self, 200, {'ok': True, 'action': 'launch_app', 'package': data.get('package'), 'result': result})
            if path == '/device/stop_app':
                drv = get_driver()
                result = run_async(drv.stop_app(str(data.get('package', ''))), timeout=30)
                return _respond(self, 200, {'ok': True, 'action': 'stop_app', 'package': data.get('package'), 'result': result})
            if path == '/device/install_app':
                drv = get_driver()
                result = run_async(drv.install_app(str(data.get('path', ''))), timeout=60)
                return _respond(self, 200, {'ok': True, 'action': 'install_app', 'path': data.get('path'), 'result': result})
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
