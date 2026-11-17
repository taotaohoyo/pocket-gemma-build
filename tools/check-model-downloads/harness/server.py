#!/usr/bin/env python3
"""The app's model download in the iOS simulator, step by step (1.1.0 (293)).

A stand-in for the Hugging Face Hub on 127.0.0.1 and the scenarios that use
it. The Hub's resolve link answers 302 to a CDN link of its own, as the Hub
does (its CDN links last about an hour, run 40825923927); the CDN link
serves the real Qwen3 0.6B file (344,671,744 bytes, the app's pinned
SHA-256) with byte ranges, an ETag and a set speed, and on request breaks
the connection, answers an error once, refuses links given before (a link
that ran out) or changes bytes (a broken transfer). The harness app
(Harness.swift: the app's ModelStore, DownloadActivity, AppFiles and the
download record) takes commands from here and posts what the store shows
and keeps. Each scenario starts from a fresh install, moves the app with
simctl (to the background: the Settings app opens; back: the app opens;
ended: simctl terminate) and prints one HARNESS-RESULT line of JSON.

usage: server.py --udid UDID --bundle ID --file PATH --variant 292|293 --out DIR [--only NAME,...]
"""
import argparse
import email.utils
import http.server
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

MB = 1_000_000


class Hub:
    """What the stand-in serves and how, and what it saw."""

    def __init__(self, path):
        self.path = path
        self.size = os.path.getsize(path)
        self.etag = '"harness-%d"' % self.size
        self.modified = email.utils.formatdate(1_760_000_000, usegmt=True)
        self.lock = threading.Lock()
        self.rate = 10 * MB
        self.token = 0
        self.expired_upto = 0
        self.fail_next = None
        self.drop_now = False
        self.corrupt = None
        self.requests = []
        self.commands = []
        self.status = {}
        self.status_time = 0.0
        self.events = []
        self.log = []

    def new_token(self):
        with self.lock:
            self.token += 1
            return self.token

    def note(self, entry):
        with self.lock:
            entry['t'] = round(time.time(), 2)
            self.requests.append(entry)
            return entry

    def position(self):
        """The furthest byte of the file served so far."""
        with self.lock:
            return max([r.get('start', 0) + r.get('sent', 0) for r in self.requests if r['kind'] == 'cdn'] or [0])

    def reset(self):
        with self.lock:
            self.rate = 10 * MB
            self.expired_upto = 0
            self.fail_next = None
            self.drop_now = False
            self.corrupt = None
            self.requests = []
            self.events = []
            self.log = []
            self.status = {}
            self.status_time = 0.0


def handler_for(hub):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def send_json(self, value, status=200):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(length) or b'{}')
            if self.path.startswith('/app/status'):
                with hub.lock:
                    lines = body.pop('log', [])
                    hub.log.extend(lines)
                    hub.status = body
                    hub.status_time = time.time()
            elif self.path.startswith('/app/event'):
                with hub.lock:
                    body['t'] = round(time.time(), 2)
                    hub.events.append(body)
            self.send_json({'ok': True})

        def do_GET(self):
            parts = urllib.parse.urlsplit(self.path)
            if parts.path == '/app/command':
                after = int(urllib.parse.parse_qs(parts.query).get('after', ['0'])[0])
                with hub.lock:
                    pending = [c for c in hub.commands if c['id'] > after]
                return self.send_json(pending)
            if parts.path.startswith('/hub/'):
                token = hub.new_token()
                hub.note({'kind': 'hub', 'path': parts.path, 'range': self.headers.get('Range'), 'token': token})
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1:%d/cdn/%d/%s' % (self.server.server_port, token, parts.path[5:]))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if parts.path.startswith('/cdn/'):
                return self.cdn(parts.path)
            self.send_json({'error': 'not found'}, 404)

        def cdn(self, path):
            token = int(path.split('/')[2])
            header = self.headers.get('Range')
            if_range = self.headers.get('If-Range')
            entry = hub.note({'kind': 'cdn', 'token': token, 'range': header, 'if_range': if_range, 'sent': 0})
            with hub.lock:
                expired = token <= hub.expired_upto
                fail = hub.fail_next
                if fail and not expired:
                    hub.fail_next = None
            if expired or fail:
                status = 403 if expired else fail
                entry['status'] = status
                body = b'<Error><Code>AccessDenied</Code></Error>' if expired else b'busy'
                self.send_response(status)
                self.send_header('Content-Type', 'application/xml')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            start, end = 0, hub.size - 1
            partial = False
            if header and header.startswith('bytes=') and (not if_range or if_range in (hub.etag, hub.modified)):
                first, _, last = header[6:].partition('-')
                start = int(first) if first else 0
                end = int(last) if last else hub.size - 1
                partial = True
            if start >= hub.size:
                entry['status'] = 416
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % hub.size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            length = end - start + 1
            entry.update(start=start, length=length, status=206 if partial else 200)
            self.send_response(206 if partial else 200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('ETag', hub.etag)
            self.send_header('Last-Modified', hub.modified)
            if partial:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, hub.size))
            self.end_headers()
            began = time.time()
            with hub.lock:
                rate = hub.rate
            with open(hub.path, 'rb') as source:
                source.seek(start)
                sent = 0
                while sent < length:
                    with hub.lock:
                        drop = hub.drop_now
                        if drop:
                            hub.drop_now = False
                        corrupt = hub.corrupt
                    if drop:
                        entry['ended'] = 'dropped'
                        try:
                            self.connection.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        self.close_connection = True
                        return
                    # Small pieces at a low speed, so the bytes come evenly.
                    chunk = source.read(min(65536, max(4096, rate // 4), length - sent))
                    if not chunk:
                        break
                    if corrupt:
                        lo, hi = corrupt
                        offset = start + sent
                        if offset < hi and offset + len(chunk) > lo:
                            data = bytearray(chunk)
                            for i in range(max(lo, offset), min(hi, offset + len(chunk))):
                                data[i - offset] ^= 0xFF
                            chunk = bytes(data)
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        entry['ended'] = 'client closed'
                        self.close_connection = True
                        return
                    sent += len(chunk)
                    entry['sent'] = sent
                    # Wait until the set speed allows the next piece; a new
                    # speed counts from here.
                    while True:
                        with hub.lock:
                            now_rate = hub.rate
                        if now_rate != rate:
                            rate = now_rate
                            began = time.time() - sent / max(rate, 1)
                        pause = began + sent / max(rate, 1) - time.time()
                        if pause <= 0 or hub.drop_now:
                            break
                        time.sleep(min(pause, 0.25))
            entry['ended'] = 'complete'

    return Handler


class Simulator:
    def __init__(self, udid, bundle, app, out):
        self.udid, self.bundle, self.app, self.out = udid, bundle, app, out

    def run(self, *args, check=False, timeout=120):
        result = subprocess.run(['xcrun', 'simctl', *args], capture_output=True, text=True, timeout=timeout)
        if check and result.returncode != 0:
            raise RuntimeError('simctl %s: %s' % (' '.join(args), result.stderr.strip()))
        return result

    def fresh_install(self):
        self.run('terminate', self.udid, self.bundle)
        self.run('uninstall', self.udid, self.bundle)
        time.sleep(2)
        self.run('install', self.udid, self.app, check=True)

    def launch(self, server):
        return self.run('launch', self.udid, self.bundle, '--harness', server, check=True)

    def to_background(self):
        self.run('launch', self.udid, 'com.apple.Preferences')

    def to_foreground(self, server):
        self.launch(server)

    def terminate(self):
        self.run('terminate', self.udid, self.bundle)

    def container(self):
        result = self.run('get_app_container', self.udid, self.bundle, 'data')
        return pathlib.Path(result.stdout.strip()) if result.returncode == 0 else None


class Scenario:
    def __init__(self, name, hub, sim, server, variant, out):
        self.name, self.hub, self.sim, self.server, self.variant, self.out = name, hub, sim, server, variant, out
        self.timeline = []
        self.checks = {}
        self.began = time.time()

    def mark(self, text):
        line = '%6.1fs %s' % (time.time() - self.began, text)
        self.timeline.append(line)
        print('HARNESS-STEP', self.name, line, flush=True)

    def command(self, name):
        with self.hub.lock:
            self.hub.commands.append({'id': len(self.hub.commands) + 1, 'name': name})
        self.mark('command ' + name)

    def status(self):
        with self.hub.lock:
            return dict(self.hub.status), self.hub.status_time

    def wait(self, what, predicate, timeout):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if predicate():
                    self.mark('reached: ' + what)
                    return True
            except (KeyError, TypeError):
                pass
            time.sleep(0.5)
        self.mark('TIMED OUT: ' + what)
        return False

    def fraction(self):
        return self.hub.position() / self.hub.size

    def launched(self):
        return self.wait('app posts', lambda: self.status()[1] > self.began and not self.status()[0].get('restoring', True), 40)

    def start(self):
        self.hub.reset()
        self.began = time.time()
        self.sim.fresh_install()
        self.sim.launch(self.server)
        self.mark('installed and launched')
        return self.launched()

    def cdn_requests(self):
        with self.hub.lock:
            return [dict(r) for r in self.hub.requests if r['kind'] == 'cdn']

    def installed(self, timeout):
        return self.wait('installed', lambda: self.status()[0].get('installed') is True, timeout)

    def finish(self):
        status, _ = self.status()
        requests = self.cdn_requests()
        hubs = [r for r in self.hub.requests if r['kind'] == 'hub']
        # After the first request, one that starts at byte 0 began the file
        # again: what came before it was lost.
        starts = [r.get('start', 0) for r in requests if r.get('status') in (200, 206)]
        restarts_from_zero = sum(1 for s in starts[1:] if s == 0)
        container = self.sim.container()
        record = ''
        if container:
            log = container / 'Library/Application Support/download-log.txt'
            if log.exists():
                record = log.read_text(errors='replace')
        (self.out / ('%s-%s-download-log.txt' % (self.variant, self.name))).write_text(record)
        result = {
            'variant': self.variant, 'scenario': self.name,
            'installed': status.get('installed'), 'model_bytes': status.get('model_bytes'),
            'size_ok': status.get('model_bytes') == self.hub.size if status.get('installed') else None,
            'restarts_from_zero': restarts_from_zero,
            'requests': [{k: r.get(k) for k in ('t', 'token', 'range', 'status', 'start', 'sent', 'ended')} for r in requests],
            'hub_requests': len(hubs),
            'served_mb': round(sum(r.get('sent', 0) for r in requests) / MB, 1),
            'status': {k: status.get(k) for k in ('downloading', 'status_text', 'failure', 'error', 'resume_bytes',
                                                   'pending_bytes', 'record', 'kept', 'kept_progress', 'state')},
            'checks': self.checks,
            'events': [(round(e['t'] - self.began, 1), e['name'], e.get('detail', '')) for e in self.hub.events],
            'timeline': self.timeline,
            'record_tail': record.splitlines()[-60:],
        }
        print('HARNESS-RESULT ' + json.dumps(result, ensure_ascii=False), flush=True)
        return result


def scenario_background(s):
    """Away from the screen for 25 s during the download, then back."""
    s.start()
    s.command('download')
    s.wait('25%', lambda: s.fraction() >= 0.25, 120)
    at = s.hub.position()
    s.sim.to_background()
    s.mark('to the background')
    time.sleep(25)
    s.checks['mb_while_away'] = round((s.hub.position() - at) / MB, 1)
    s.sim.to_foreground(s.server)
    s.mark('back on screen')
    s.installed(180)


def scenario_background_slow(s):
    """Slow bytes (30 KB/s) while away for 80 s: iOS's continued task wants
    its progress to move about every 30 s."""
    s.start()
    s.hub.rate = 4 * MB
    s.command('download')
    s.wait('8%', lambda: s.fraction() >= 0.08, 120)
    s.hub.rate = 30_000
    s.mark('speed 30 KB/s')
    time.sleep(3)
    s.sim.to_background()
    s.mark('to the background')
    time.sleep(80)
    s.hub.rate = 10 * MB
    s.sim.to_foreground(s.server)
    s.mark('back on screen, speed 10 MB/s')
    s.installed(240)


def scenario_drop(s):
    """The connection breaks at 30%."""
    s.start()
    s.command('download')
    s.wait('30%', lambda: s.fraction() >= 0.30, 120)
    s.hub.drop_now = True
    s.mark('connection broken')
    s.installed(240)


def scenario_drop_then_error(s):
    """The connection breaks at 30% and the next answer is HTTP 503 once:
    a try that went on from resume data and failed (292 began from 0)."""
    s.start()
    s.command('download')
    s.wait('30%', lambda: s.fraction() >= 0.30, 120)
    s.hub.fail_next = 503
    s.hub.drop_now = True
    s.mark('connection broken, next answer 503')
    s.installed(240)


def scenario_kill(s):
    """The app ended by the system (simctl terminate) at 30%, opened again 10 s later."""
    s.start()
    s.command('download')
    s.wait('30%', lambda: s.fraction() >= 0.30, 120)
    at = s.hub.position()
    s.sim.terminate()
    s.mark('app ended')
    time.sleep(10)
    s.checks['mb_while_ended'] = round((s.hub.position() - at) / MB, 1)
    s.sim.launch(s.server)
    s.mark('opened again')
    s.launched()
    s.installed(240)


def stop_and_wait(s, how):
    s.command(how)
    s.wait('stopped', lambda: s.status()[0].get('downloading') is None, 30)
    time.sleep(2)
    status, _ = s.status()
    s.checks['after_stop'] = {k: status.get(k) for k in ('resume_bytes', 'record', 'kept', 'kept_progress', 'status_text')}
    s.mark('after the stop: resume data %s bytes' % status.get('resume_bytes'))


def first_start_after(s, t):
    for r in s.cdn_requests():
        if r['t'] > t and r.get('status') in (200, 206):
            return r.get('start', 0)
    return None


def scenario_stop_keep(s):
    """中止 at 40% (293: keeping what came), then ダウンロード again."""
    s.start()
    s.command('download')
    s.wait('40%', lambda: s.fraction() >= 0.40, 120)
    stop_and_wait(s, 'stop-keep')
    t = time.time()
    s.command('download')
    s.wait('a new request', lambda: first_start_after(s, t) is not None, 60)
    s.checks['next_start_mb'] = round((first_start_after(s, t) or 0) / MB, 1)
    s.installed(240)


def scenario_stop_keep_relaunch(s):
    """中止 keeping what came at 40%, the app ended and opened again, then ダウンロード."""
    s.start()
    s.command('download')
    s.wait('40%', lambda: s.fraction() >= 0.40, 120)
    stop_and_wait(s, 'stop-keep')
    s.sim.terminate()
    s.mark('app ended')
    time.sleep(3)
    s.sim.launch(s.server)
    s.mark('opened again')
    s.launched()
    time.sleep(2)
    status, _ = s.status()
    s.checks['after_relaunch'] = {k: status.get(k) for k in ('resume_bytes', 'kept', 'kept_progress', 'status_text', 'downloading')}
    t = time.time()
    s.command('download')
    s.wait('a new request', lambda: first_start_after(s, t) is not None, 60)
    s.checks['next_start_mb'] = round((first_start_after(s, t) or 0) / MB, 1)
    s.installed(240)


def scenario_stop_discard(s):
    """中止 at 30% deleting what came: the next download starts over."""
    s.start()
    s.command('download')
    s.wait('30%', lambda: s.fraction() >= 0.30, 120)
    stop_and_wait(s, 'stop-discard')
    t = time.time()
    s.command('download')
    s.wait('a new request', lambda: first_start_after(s, t) is not None, 60)
    s.checks['next_start_mb'] = round((first_start_after(s, t) or 0) / MB, 1)
    s.installed(240)


def scenario_link_expired(s):
    """中止 keeping what came at 30%, the CDN link runs out (403), ダウンロード again."""
    s.start()
    s.command('download')
    s.wait('30%', lambda: s.fraction() >= 0.30, 120)
    stop_and_wait(s, 'stop-keep')
    s.hub.expired_upto = s.hub.token
    s.mark('links so far run out')
    t = time.time()
    s.command('download')
    s.wait('a new request served', lambda: first_start_after(s, t) is not None, 90)
    s.checks['next_start_mb'] = round((first_start_after(s, t) or 0) / MB, 1)
    s.installed(240)


def scenario_wrong_bytes(s):
    """1 KB changed at 100 MB: the SHA-256 check must refuse the file, then a clean download."""
    s.start()
    s.hub.corrupt = (100 * MB, 100 * MB + 1024)
    s.command('download')
    s.wait('refused', lambda: s.status()[0].get('downloading') is None and s.status()[0].get('failure') is not None, 180)
    status, _ = s.status()
    s.checks['refused'] = {k: status.get(k) for k in ('installed', 'receipt', 'pending_bytes', 'model_bytes', 'failure')}
    s.hub.corrupt = None
    s.command('clear-error')
    s.command('download')
    s.installed(240)


SCENARIOS = {
    'background': scenario_background,
    'background-slow': scenario_background_slow,
    'drop': scenario_drop,
    'drop-then-503': scenario_drop_then_error,
    'kill': scenario_kill,
    'stop-keep': scenario_stop_keep,
    'stop-keep-relaunch': scenario_stop_keep_relaunch,
    'stop-discard': scenario_stop_discard,
    'link-expired': scenario_link_expired,
    'wrong-bytes': scenario_wrong_bytes,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--udid', required=True)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--app', required=True)
    parser.add_argument('--file', required=True)
    parser.add_argument('--variant', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--only', default='')
    args = parser.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    hub = Hub(args.file)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler_for(hub))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    server = 'http://127.0.0.1:%d' % httpd.server_port
    print('HARNESS-SERVER', server, hub.size, flush=True)
    sim = Simulator(args.udid, args.bundle, args.app, out)
    names = [n for n in args.only.split(',') if n] or list(SCENARIOS)
    results = []
    for name in names:
        scenario = Scenario(name, hub, sim, server, args.variant, out)
        try:
            SCENARIOS[name](scenario)
        except Exception as error:  # noqa: BLE001 - one scenario's trouble is its result
            scenario.mark('ERROR %r' % error)
        results.append(scenario.finish())
    (out / ('%s-results.json' % args.variant)).write_text(json.dumps(results, ensure_ascii=False, indent=1))
    sim.terminate()
    httpd.shutdown()


if __name__ == '__main__':
    main()
