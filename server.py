#!/usr/bin/env python3
"""현단아 퀴즈: 127.0.0.1 전용 OBS Browser Source relay (Python standard library)."""
from __future__ import annotations

import argparse
import re
import json
import mimetypes
import os
from pathlib import Path
import threading
import time
import uuid
import urllib.parse
import webbrowser
import sys
from updater import Updater, UpdateError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
HOST = '127.0.0.1'
PORT = 8765
HEARTBEAT_LIMIT = 15.0  # controller inactivity -> emergency screen
MAX_BODY = 25 * 1024 * 1024
ALLOWED_STAGES = {'waiting', 'title', 'question', 'reveal', 'summary', 'emergency', 'end'}
UPDATER = Updater(ROOT)


def safe_screen(stage='emergency'):
    return {'version': 2, 'stage': stage, 'round': '', 'image': None, 'hint': '', 'revealed': [], 'focus': None, 'revealStep': 0, 'revealTotal': 0}


def valid_image(value):
    return isinstance(value, str) and len(value) < MAX_BODY and value.startswith('data:image/png;base64,')


def sanitize_state(value):
    """Never persist or expose private project objects; strict public-field allowlist."""
    if not isinstance(value, dict):
        return safe_screen()
    stage = value.get('stage')
    if stage not in ALLOWED_STAGES:
        return safe_screen()
    if stage in {'waiting', 'title', 'emergency', 'end'}:
        # Public titles are drawn by OBS renderer, not sent as a hidden payload.
        return safe_screen(stage)
    round_label = value.get('round', '')
    hint = value.get('hint', '')
    data = {'version': 2, 'stage': stage,
            'round': str(round_label)[:100],
            'image': value.get('image') if valid_image(value.get('image')) else None,
            'hint': str(hint)[:1000] if stage != 'summary' else '',
            'revealed': [], 'focus': None, 'revealStep': 0, 'revealTotal': 0}
    people = value.get('revealed', [])
    if stage == 'question':
        people = []
    if isinstance(people, list):
        for person in people[:4]:
            if not isinstance(person, dict):
                continue
            slot = person.get('slot', '')
            image = person.get('image')
            if slot not in {'A', 'B', 'C', 'D'} or not valid_image(image):
                continue
            data['revealed'].append({'slot': slot, 'name': str(person.get('name', ''))[:120], 'source': str(person.get('source', ''))[:400], 'image': image})
    # Only an already disclosed slot may be highlighted. Never accept a raw undisclosed focus.
    if stage == 'reveal':
        focus = value.get('focus')
        if isinstance(focus, dict):
            allowed = next((p for p in data['revealed'] if p['slot'] == focus.get('slot')), None)
            if allowed:
                data['focus'] = allowed.copy()
        # Normalize progress bounds to avoid leaking unrelated client metadata.
        step = value.get('revealStep', 0)
        total = value.get('revealTotal', 0)
        if type(step) is int and type(total) is int and 0 <= step <= total <= 8:
            data['revealStep'] = step
            data['revealTotal'] = total
    if stage == 'summary':
        data['image'] = None
    return data


class RelayState:
    def __init__(self):
        self.lock = threading.RLock()
        self.payload = safe_screen('waiting')
        self.revision = 0
        self.owner = None
        self.sequence = -1
        self.last_seen = 0.0
        self.active_lease = None

    def _alive(self):
        return bool(self.owner) and (time.monotonic() - self.last_seen < HEARTBEAT_LIMIT)

    def publish(self, session, seq, screen):
        with self.lock:
            if self._alive() and self.owner != session:
                return False, '다른 진행실이 이미 OBS 송출을 제어하고 있어요.'
            if self.owner != session:
                self.owner = session
                self.sequence = -1
                self.active_lease = None
            if seq >= self.sequence:
                self.sequence = seq
                public = sanitize_state(screen)
                if public != self.payload:
                    self.payload = public
                    self.revision += 1
            self.last_seen = time.monotonic()
            return True, None

    def takeover(self, session):
        with self.lock:
            self.owner = session
            self.sequence = -1
            self.payload = safe_screen('emergency')
            self.revision += 1
            self.last_seen = time.monotonic()
            self.active_lease = None

    def touch_lease(self, session, lease_id):
        with self.lock:
            if self.owner != session or not self._alive():
                return False
            if self.active_lease not in (None, lease_id):
                return False
            self.active_lease = lease_id
            return True

    def ping(self, session):
        with self.lock:
            if self.owner != session or not self._alive():
                return False
            self.last_seen = time.monotonic()
            return True

    def release_session(self, session):
        with self.lock:
            if self.owner != session:
                return False
            self.owner = None
            self.active_lease = None
            self.payload = safe_screen('emergency')
            self.last_seen = 0.0
            self.sequence = -1
            self.revision += 1
            return True

    def release_lease(self, session, lease_id):
        with self.lock:
            if self.owner == session and self.active_lease == lease_id:
                self.active_lease = None
                # Short grace avoids flashing during automatic EventSource reconnect;
                # a truly closed controller becomes offline within ~3 seconds.
                self.last_seen = time.monotonic() - HEARTBEAT_LIMIT + 3.0

    def public_snapshot(self, since):
        with self.lock:
            online = self._alive()
            public = self.payload if online else safe_screen('emergency')
            rev = self.revision if online else f'{self.revision}-offline'
            if str(since) == str(rev):
                return {'version': 1, 'revision': rev, 'unchanged': True, 'connected': online}
            return {'version': 1, 'revision': rev, 'unchanged': False,
                    'connected': online, 'state': public}

    def status(self):
        with self.lock:
            return {'connected': self._alive(), 'revision': self.revision, 'controller_active': self._alive()}


RELAY = RelayState()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'HyundanaQuizOBS/1.2'

    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/public?'):
            print('[local]', fmt % args)

    def _response(self, status, body, mime='application/json; charset=utf-8'):
        if isinstance(body, (dict, list)):
            raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
        elif isinstance(body, str):
            raw = body.encode('utf-8')
        else:
            raw = body
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _path(self):
        return urllib.parse.urlsplit(self.path).path

    def _file(self, name, mime):
        path = ROOT / name
        if not path.is_file():
            self._response(404, {'error': 'file not found'})
            return
        if mime == 'video/mp4':
            self._video_file(path)
        else:
            self._response(200, path.read_bytes(), mime)

    def _video_file(self, path):
        # Chromium/OBS video playback may request byte ranges for mp4 seeking.
        content = path.read_bytes()
        total = len(content)
        range_value = self.headers.get('Range', '').strip()
        start, end, status = 0, total - 1, 200
        if range_value:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_value)
            if not match or (not match.group(1) and not match.group(2)):
                self._response(416, {'error': 'invalid range'})
                return
            try:
                if not match.group(1):
                    suffix = int(match.group(2))
                    start = max(0, total - suffix)
                else:
                    start = int(match.group(1))
                end = min(total - 1, int(match.group(2))) if match.group(1) and match.group(2) else total - 1
            except ValueError:
                self._response(416, {'error': 'invalid range'})
                return
            if start >= total or start < 0 or end < start:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */' + str(total))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            status = 206
        chunk = content[start:end + 1]
        self.send_response(status)
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(len(chunk)))
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{total}')
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.end_headers()
        try:
            self.wfile.write(chunk)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def do_GET(self):
        path = self._path()
        if path == '/':
            self.send_response(302)
            self.send_header('Location', '/studio')
            self.send_header('Content-Length', '0')
            self.end_headers()
        elif path == '/studio':
            self._file('studio.html', 'text/html; charset=utf-8')
        elif path == '/obs':
            self._file('obs.html', 'text/html; charset=utf-8')
        elif path == '/bridge.js':
            self._file('bridge.js', 'text/javascript; charset=utf-8')
        elif path == '/assets/question.webp':
            self._file('assets/question.webp', 'image/webp')
        elif path == '/assets/answer.webp':
            self._file('assets/answer.webp', 'image/webp')
        elif path == '/assets/next.mp4':
            self._file('assets/next.mp4', 'video/mp4')
        elif path == '/assets/end.webp':
            self._file('assets/end.webp', 'image/webp')
        elif path == '/assets/standby.webp':
            self._file('assets/standby.webp', 'image/webp')
        elif path == '/assets/intro.webp':
            self._file('assets/intro.webp', 'image/webp')
        elif path == '/api/public':
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            since = params.get('rev', [''])[0]
            self._response(200, RELAY.public_snapshot(since))
        elif path == '/api/lease':
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            session = params.get('session', [''])[0]
            lease_id = str(uuid.uuid4())
            if not session or not RELAY.touch_lease(session, lease_id):
                self._response(409, {'error': '다른 진행실이 제어 중이거나 진행실 준비 전'})
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache, no-transform')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            try:
                while RELAY.touch_lease(session, lease_id):
                    self.wfile.write(b'data: ping\n\n')
                    self.wfile.flush()
                    time.sleep(2.0)
            except (ConnectionError, OSError):
                pass
            finally:
                RELAY.release_lease(session, lease_id)
        elif path == '/api/status':
            self._response(200, RELAY.status())
        elif path == '/api/update/status':
            self._response(200, {'version': UPDATER.current(), 'configured': bool(UPDATER.config().get('manifest_url')), 'has_rollback': UPDATER.history.exists() and any(p.is_dir() for p in UPDATER.history.iterdir())})
        elif path == '/health':
            self._response(200, {'status': 'ok', 'application': 'hyundana-face-quiz', 'version': UPDATER.current()})
        else:
            self._response(404, {'error': 'page not found'})

    def _restart_server(self):
        def request_shutdown():
            time.sleep(0.7)
            self.server.restart_requested = True
            self.server.shutdown()
        threading.Thread(target=request_shutdown, daemon=True).start()

    def _validate_write(self):
        origin = self.headers.get('Origin')
        if origin not in (None, f'http://{HOST}:{PORT}'):
            self._response(403, {'error': '외부 페이지에서 송출 제어 불가'})
            return None
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            self._response(415, {'error': 'JSON 전송만 지원'})
            return None
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            length = -1
        if length < 1 or length > MAX_BODY:
            self._response(413, {'error': '송출 데이터 크기 제한 초과 또는 잘못된 본문'})
            return None
        try:
            body = json.loads(self.rfile.read(length))
        except (UnicodeError, ValueError):
            self._response(400, {'error': 'JSON을 읽지 못했어요'})
            return None
        if not isinstance(body, dict):
            self._response(400, {'error': '객체형 JSON 필요'})
            return None
        return body

    def do_POST(self):
        path = self._path()
        if path not in {'/api/public', '/api/takeover', '/api/ping', '/api/release', '/api/update/check', '/api/update/apply', '/api/update/rollback'}:
            self._response(404, {'error': '알 수 없는 API'})
            return
        body = self._validate_write()
        if body is None:
            return
        if path.startswith('/api/update/'):
            # Never update while a live broadcast may be controlling OBS.
            if RELAY._alive() and RELAY.payload.get('stage') not in ('waiting', 'emergency'):
                self._response(409, {'error': '방송 중에는 업데이트할 수 없습니다. 안전 화면으로 바꾸고 진행실을 닫은 뒤 시도하세요.'})
                return
            try:
                if path == '/api/update/check':
                    info = UPDATER.check()
                    self._response(200, {k:v for k,v in info.items() if k!='manifest'})
                elif path == '/api/update/apply':
                    result = UPDATER.apply()
                    self._response(200, result)
                    if result.get('updated'): self._restart_server()
                else:
                    result = UPDATER.rollback()
                    self._response(200, result)
                    self._restart_server()
            except UpdateError as exc:
                self._response(400, {'error': str(exc)})
            except Exception as exc:
                self._response(500, {'error': '업데이트 처리 오류: '+str(exc)})
            return
        session = body.get('session')
        if not isinstance(session, str) or not 8 <= len(session) <= 100:
            self._response(400, {'error': '올바른 진행실 세션이 필요해요'})
            return
        if path == '/api/ping':
            ok = RELAY.ping(session)
            self._response(200 if ok else 409, {'ok': ok})
            return
        if path == '/api/release':
            ok = RELAY.release_session(session)
            self._response(200, {'ok': ok})
            return
        if path == '/api/takeover':
            RELAY.takeover(session)
            self._response(200, {'ok': True, 'message': '새 진행실 제어권을 가져왔어요. 안전 화면으로 초기화했습니다.'})
            return
        seq = body.get('seq')
        if not isinstance(seq, int) or seq < 0:
            self._response(400, {'error': '순서 번호 오류'})
            return
        ok, reason = RELAY.publish(session, seq, body.get('state'))
        if not ok:
            self._response(409, {'ok': False, 'error': reason})
        else:
            self._response(200, {'ok': True})


def main():
    parser = argparse.ArgumentParser(description='현단아 합성 퀴즈 OBS 로컬 연결 서버')
    parser.add_argument('--no-browser', action='store_true', help='브라우저를 자동으로 열지 않음')
    args = parser.parse_args()
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
        httpd.daemon_threads = True
    except OSError as exc:
        print(f'서버 실행 실패: {exc}\n다른 현단아 서버가 열려 있으면 먼저 종료해주세요.')
        raise SystemExit(1)
    print('\n===============================================')
    print('현단아 퀴즈 · OBS 로컬 서버 실행됨')
    print(f'진행실: http://{HOST}:{PORT}/studio')
    print(f'OBS용: http://{HOST}:{PORT}/obs')
    print('방송 중 이 창을 닫으면 OBS 출력이 안전 화면으로 전환됩니다.')
    print('===============================================\n')
    if not args.no_browser:
        try:
            webbrowser.open(f'http://{HOST}:{PORT}/studio')
        except Exception:
            pass
    try:
        httpd.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        print('\n서버 종료')
    finally:
        restart_requested = bool(getattr(httpd, 'restart_requested', False))
        httpd.server_close()
    if restart_requested:
        print('업데이트 적용 완료 · 로컬 서버를 같은 주소로 다시 시작합니다.')
        os.execv(sys.executable, [sys.executable, str(ROOT / 'server.py'), '--no-browser'])


if __name__ == '__main__':
    main()
