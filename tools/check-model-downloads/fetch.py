"""Fetches one of the app's model files the way the app asks for it and
checks it end to end (1.1.0 (240)):
- the Hub's record of the pinned revision: the repo is public and not gated,
  the file is there with the pinned size and SHA-256 (its LFS oid), and
  whether the repo's newest revision still has the same file;
- every hop of the download URL's redirects: status, host, the headers that
  name the file (size, ETag, the revision the Hub served), how long a signed
  CDN link stays valid;
- the end host answers ranges (what a download resumed after a break asks);
- the whole file: received bytes and SHA-256 against the pin, taken in two
  pieces, the second asked for again from the app's URL with a Range header,
  as a resumed download is;
- a resume with If-Range (URLSession's form) against the end host.
Prints one DLCHECK line of JSON and appends a row to GITHUB_STEP_SUMMARY.
Usage: fetch.py '<one entry of pins.py --matrix as JSON>'"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AGENT = 'Fielua/1.1.0 CFNetwork (model download check)'
CHUNK = 8 * 1024 * 1024
FIRST_PIECE = 96 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)


def request(url, headers=None, method='GET'):
    req = urllib.request.Request(url, headers={'User-Agent': AGENT, **(headers or {})}, method=method)
    try:
        return opener.open(req, timeout=60)
    except urllib.error.HTTPError as error:
        return error


def api(path):
    try:
        with urllib.request.urlopen(urllib.request.Request('https://huggingface.co/api/' + path,
                                                           headers={'User-Agent': AGENT}), timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as error:
        return {'error': error.code}


def follow(url, headers=None):
    """The redirect chain to the final response, with the headers kept per hop."""
    hops = []
    for _ in range(8):
        response = request(url, headers)
        keep = {k.lower(): v for k, v in response.headers.items() if k.lower() in (
            'location', 'content-length', 'content-range', 'accept-ranges', 'etag', 'x-linked-etag',
            'x-linked-size', 'x-repo-commit', 'x-xet-hash', 'content-type', 'last-modified', 'retry-after',
            'x-error-code', 'x-error-message', 'cache-control')}
        parsed = urllib.parse.urlsplit(url)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        hop = {'status': response.status, 'host': parsed.netloc, 'path': parsed.path[:120], 'headers': keep}
        for key in ('X-Amz-Expires', 'Expires', 'X-Amz-Date'):
            if key in query:
                hop[key] = query[key]
        hops.append(hop)
        location = response.headers.get('Location')
        if response.status in (301, 302, 303, 307, 308) and location:
            response.close()
            url = urllib.parse.urljoin(url, location)
            continue
        return hops, url, response
    raise RuntimeError('more than 8 redirects')


def main():
    pin = json.loads(sys.argv[1])
    result = {'id': pin['id'], 'file': pin['file'], 'repo': pin['repo'], 'revision': pin['revision'],
              'pinned_bytes': pin['bytes'], 'pinned_sha256': pin['sha256'], 'problems': []}
    problems = result['problems']

    # The Hub's own record of the pinned revision and of the newest one.
    repo = api(f'models/{pin["repo"]}')
    result['repo_gated'] = repo.get('gated')
    result['repo_private'] = repo.get('private')
    result['repo_disabled'] = repo.get('disabled')
    result['newest_revision'] = repo.get('sha')
    if 'error' in repo:
        problems.append(f'repo api {repo["error"]}')
    if repo.get('gated') not in (None, False):
        problems.append(f'gated: {repo.get("gated")}')
    for label, revision in (('pinned', pin['revision']), ('newest', repo.get('sha'))):
        if not revision:
            continue
        tree = api(f'models/{pin["repo"]}/tree/{revision}')
        entry = next((e for e in tree if e.get('path') == pin['file']), None) if isinstance(tree, list) else None
        lfs = (entry or {}).get('lfs') or {}
        result[f'{label}_tree'] = {'found': entry is not None, 'size': (entry or {}).get('size'),
                                   'lfs_sha256': lfs.get('oid'), 'xet_hash': (entry or {}).get('xetHash')}
        if label == 'pinned':
            if entry is None:
                problems.append('file missing at the pinned revision')
            elif entry.get('size') != pin['bytes'] or lfs.get('oid') != pin['sha256']:
                problems.append('Hub record differs from the pin')

    # The app's URL, hop by hop, without downloading the body.
    hops, final_url, response = follow(pin['url'], {'Range': 'bytes=0-0'})
    response.close()
    result['hops'] = hops
    end = hops[-1]
    result['final_host'] = end['host']
    if end['status'] != 206:
        problems.append(f'range 0-0 answered {end["status"]}')
    total = end['headers'].get('content-range', '').rpartition('/')[2]
    result['range_total'] = int(total) if total.isdigit() else None
    if result['range_total'] != pin['bytes']:
        problems.append(f'content-range total {total} != {pin["bytes"]}')
    hub = next((h for h in hops if 'x-repo-commit' in h['headers']), None)
    if hub and hub['headers']['x-repo-commit'] != pin['revision']:
        problems.append('served revision differs')
    etag = end['headers'].get('etag')

    # The whole file in two pieces: the second asked for from the app's URL
    # again with a Range header, as a download resumed after a break is.
    digest = hashlib.sha256()
    received = 0
    started = time.monotonic()
    hops_a, url_a, body = follow(pin['url'])
    result['full_status'] = hops_a[-1]['status']
    while received < min(FIRST_PIECE, pin['bytes']):
        chunk = body.read(min(CHUNK, FIRST_PIECE - received))
        if not chunk:
            break
        digest.update(chunk)
        received += len(chunk)
    body.close()
    first_piece = received
    if received < pin['bytes']:
        hops_b, url_b, body = follow(pin['url'], {'Range': f'bytes={received}-'})
        result['resume_status'] = hops_b[-1]['status']
        result['resume_content_range'] = hops_b[-1]['headers'].get('content-range')
        if hops_b[-1]['status'] != 206:
            problems.append(f'resume from the app URL answered {hops_b[-1]["status"]}')
        while True:
            chunk = body.read(CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            received += len(chunk)
        body.close()
    seconds = time.monotonic() - started
    result['received_bytes'] = received
    result['first_piece_bytes'] = first_piece
    result['sha256'] = digest.hexdigest()
    result['seconds'] = round(seconds, 1)
    result['mb_per_s'] = round(received / 1e6 / max(seconds, 0.001), 1)
    if received != pin['bytes']:
        problems.append(f'received {received} bytes, pinned {pin["bytes"]}')
    if result['sha256'] != pin['sha256']:
        problems.append('SHA-256 differs from the pin')

    # URLSession resumes against the end host with If-Range (its ETag).
    if etag:
        response = request(final_url, {'Range': f'bytes={pin["bytes"] - 16}-', 'If-Range': etag})
        result['if_range_status'] = response.status
        response.close()
        if response.status != 206:
            problems.append(f'If-Range resume answered {response.status}')

    result['ok'] = not problems
    print('DLCHECK ' + json.dumps(result, ensure_ascii=False))
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as out:
            out.write(f'| {pin["id"]} | {pin["file"]} | {result["final_host"]} | {received:,} | '
                      f'{result["sha256"][:12]}… | {result["mb_per_s"]} MB/s | '
                      f'{"OK" if result["ok"] else "; ".join(problems)} |\n')
    sys.exit(0 if result['ok'] else 1)


main()
