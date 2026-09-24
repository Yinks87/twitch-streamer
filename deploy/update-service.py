#!/usr/bin/env python3
import hmac
import json
import os
import subprocess
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = '127.0.0.1'
PORT = 4010
MAX_LOG_LINES = 1_000
TOKEN = os.environ.get('UPDATE_SERVICE_TOKEN', '')
REPO_DIR = Path(os.environ.get('UPDATE_SERVICE_REPO_DIR', Path(__file__).resolve().parent.parent))

state_lock = threading.Lock()
state = {
    'running': False,
    'startedAt': None,
    'finishedAt': None,
    'exitCode': None,
    'log': [],
}


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def append_log(line):
    with state_lock:
        state['log'].append(line.rstrip())
        if len(state['log']) > MAX_LOG_LINES:
            del state['log'][:-MAX_LOG_LINES]


def run_update():
    command = [str(REPO_DIR / 'deploy' / 'install.sh'), 'update']
    try:
        process = subprocess.Popen(
            command,
            cwd=REPO_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        for line in process.stdout:
            append_log(line)
        exit_code = process.wait()
    except OSError as error:
        append_log(f'Failed to start update: {error}')
        exit_code = 1

    with state_lock:
        state['running'] = False
        state['finishedAt'] = timestamp()
        state['exitCode'] = exit_code


def start_update():
    with state_lock:
        if state['running']:
            return False
        state.update({
            'running': True,
            'startedAt': timestamp(),
            'finishedAt': None,
            'exitCode': None,
            'log': ['==> Update requested from the Twitch Streamer console'],
        })
    threading.Thread(target=run_update, daemon=True).start()
    return True


def snapshot():
    with state_lock:
        return dict(state, log=list(state['log']))


class UpdateServiceHandler(BaseHTTPRequestHandler):
    def is_authorized(self):
        provided = self.headers.get('X-Update-Service-Token', '')
        return bool(TOKEN) and hmac.compare_digest(provided, TOKEN)

    def send_json(self, status_code, body):
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if not self.is_authorized():
            return self.send_json(401, {'error': 'Unauthorized'})
        if self.path != '/status':
            return self.send_json(404, {'error': 'Not found'})
        self.send_json(200, snapshot())

    def do_POST(self):
        if not self.is_authorized():
            return self.send_json(401, {'error': 'Unauthorized'})
        if self.path != '/update':
            return self.send_json(404, {'error': 'Not found'})
        if not start_update():
            return self.send_json(409, {'error': 'An update is already running', 'status': snapshot()})
        self.send_json(202, snapshot())

    def log_message(self, format, *args):
        return


if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('UPDATE_SERVICE_TOKEN must be configured')
    ThreadingHTTPServer((HOST, PORT), UpdateServiceHandler).serve_forever()