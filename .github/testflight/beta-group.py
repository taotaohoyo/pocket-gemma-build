"""Puts an uploaded build into a TestFlight group (testflight.yml).

check: lists the app's TestFlight groups (name, internal or external) and
  makes sure the chosen group exists and can take the build, before anything
  is signed or uploaded. With no group it only lists them.
add: waits until App Store Connect has processed the uploaded build, then
  adds it to the chosen group. An internal group that already gets every
  build is left as it is. An external group still needs TestFlight App
  Review, which the workflow never submits; App Store Connect does that.

Signs in with the App Store Connect API key (ES256, signed by openssl), so it
needs nothing outside Python's standard library. The job log is public: it
prints group names and the build's state only, never testers or emails.
Usage:
  ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 beta-group.py check --bundle-id ID --testers T [--group NAME]
  ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 beta-group.py add --bundle-id ID --group NAME --version V --build B [--wait-minutes M]
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.appstoreconnect.apple.com/v1'


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def der_to_raw(der, size=32):
    """ECDSA signature from DER (SEQUENCE of two INTEGERs) to r || s, as JWS wants."""
    def read_length(data, at):
        length = data[at]
        at += 1
        if length & 0x80:
            count = length & 0x7f
            length = int.from_bytes(data[at:at + count], 'big')
            at += count
        return length, at

    if der[0] != 0x30:
        raise ValueError('not a DER sequence')
    _, at = read_length(der, 1)
    parts = []
    for _ in range(2):
        if der[at] != 0x02:
            raise ValueError('not a DER integer')
        length, at = read_length(der, at + 1)
        value = der[at:at + length].lstrip(b'\0')
        if len(value) > size:
            raise ValueError('integer too long')
        parts.append(value.rjust(size, b'\0'))
        at += length
    return parts[0] + parts[1]


class Client:
    def __init__(self, key_id, issuer_id, key_text):
        self.key_id = key_id
        self.issuer_id = issuer_id
        folder = os.path.join(os.environ.get('RUNNER_TEMP') or tempfile.gettempdir(), 'private_keys')
        os.makedirs(folder, mode=0o700, exist_ok=True)
        handle, self.key_path = tempfile.mkstemp(prefix='beta-group-', suffix='.p8', dir=folder)
        with os.fdopen(handle, 'w') as out:
            out.write(key_text.strip() + '\n')
        os.chmod(self.key_path, 0o600)

    def close(self):
        try:
            os.remove(self.key_path)
        except FileNotFoundError:
            pass

    def token(self):
        now = int(time.time())
        header = b64url(json.dumps({'alg': 'ES256', 'kid': self.key_id, 'typ': 'JWT'}).encode())
        claims = b64url(json.dumps({'iss': self.issuer_id, 'iat': now, 'exp': now + 600,
                                    'aud': 'appstoreconnect-v1'}).encode())
        signing_input = f'{header}.{claims}'.encode()
        der = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', self.key_path],
                             input=signing_input, capture_output=True, check=True).stdout
        return f'{header}.{claims}.{b64url(der_to_raw(der))}'

    def request(self, method, path, query=None, body=None):
        url = API + path
        if query:
            url += '?' + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.token(),
            'Content-Type': 'application/json',
        })
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read()
                return response.status, (json.loads(text) if text else {})
        except urllib.error.HTTPError as error:
            text = error.read()
            try:
                return error.code, json.loads(text)
            except ValueError:
                return error.code, {}


def errors_of(payload):
    found = []
    for item in payload.get('errors', []):
        line = ' '.join(part for part in (item.get('code'), item.get('title'), item.get('detail')) if part)
        found.append(re.sub(r'[\w.+-]+@[\w-]+(\.[\w-]+)+', '[email]', line)[:300])
    return '; '.join(found) or 'no details'


def need(status, payload, what):
    if status >= 300:
        print(f'{what} failed: HTTP {status}: {errors_of(payload)}')
        if status in (401, 403):
            print('The API key could not do this. testflight.yml expects a team key with Admin access.')
        sys.exit(1)
    return payload


def same_name(a, b):
    return unicodedata.normalize('NFC', a).strip() == unicodedata.normalize('NFC', b).strip()


def find_app(client, bundle_id):
    payload = need(*client.request('GET', '/apps', {'filter[bundleId]': bundle_id, 'fields[apps]': 'bundleId,name', 'limit': 10}),
                   'Finding the app')
    for app in payload.get('data', []):
        if app['attributes'].get('bundleId') == bundle_id:
            return app['id']
    print(f'No App Store Connect app has the bundle ID {bundle_id}')
    sys.exit(1)


def list_groups(client, app_id):
    payload = need(*client.request('GET', f'/apps/{app_id}/betaGroups', {
        'fields[betaGroups]': 'name,isInternalGroup,hasAccessToAllBuilds', 'limit': 200}), 'Listing the TestFlight groups')
    groups = payload.get('data', [])
    print('TestFlight groups of the app:')
    for group in groups:
        attributes = group['attributes']
        kind = 'internal' if attributes.get('isInternalGroup') else 'external'
        every = ', gets every build by itself' if attributes.get('isInternalGroup') and attributes.get('hasAccessToAllBuilds') else ''
        print(f"  - {attributes.get('name')} ({kind}{every})")
    if not groups:
        print('  (none)')
    return groups


def pick_group(groups, name):
    matches = [group for group in groups if same_name(group['attributes'].get('name') or '', name)]
    if len(matches) != 1:
        print(f"{'No' if not matches else 'More than one'} TestFlight group is named '{name}'")
        sys.exit(1)
    return matches[0]


def check(client, args):
    app_id = find_app(client, args.bundle_id)
    groups = list_groups(client, app_id)
    if not args.group:
        print('No group chosen: the build is only uploaded.')
        return
    group = pick_group(groups, args.group)
    internal = group['attributes'].get('isInternalGroup')
    if not internal and args.testers == 'internal-only':
        print(f"'{args.group}' is an external group, and an internal-only build can never join one. Upload with testers internal-and-external.")
        sys.exit(1)
    print(f"The build will go to '{args.group}' ({'internal' if internal else 'external'}) once App Store Connect has processed it.")


def wait_for_build(client, app_id, version, build, minutes):
    deadline = time.time() + minutes * 60
    last = None
    while True:
        status, payload = client.request('GET', '/builds', {
            'filter[app]': app_id, 'filter[version]': build, 'filter[preReleaseVersion.version]': version,
            'fields[builds]': 'version,processingState,expired', 'limit': 5})
        if status >= 500 or status == 429:
            state = f'HTTP {status}'
        else:
            payload = need(status, payload, 'Looking up the build')
            found = [item for item in payload.get('data', []) if item['attributes'].get('version') == build]
            state = found[0]['attributes'].get('processingState') if found else 'not listed yet'
            if found and state == 'VALID':
                print(f'{version} ({build}) is processed.')
                return found[0]['id']
            if found and state in ('FAILED', 'INVALID'):
                print(f'App Store Connect could not process {version} ({build}): {state}')
                sys.exit(1)
        if state != last:
            print(f'{version} ({build}): {state}')
            last = state
        if time.time() > deadline:
            print(f'{version} ({build}) was not processed within {minutes} minutes; add it to the group in App Store Connect.')
            sys.exit(1)
        time.sleep(30)


def add(client, args):
    app_id = find_app(client, args.bundle_id)
    group = pick_group(list_groups(client, app_id), args.group)
    attributes = group['attributes']
    internal = attributes.get('isInternalGroup')
    build_id = wait_for_build(client, app_id, args.version, args.build, args.wait_minutes)
    if internal and attributes.get('hasAccessToAllBuilds'):
        print(f"'{args.group}' gets every build by itself, so {args.version} ({args.build}) is already there.")
        return
    status, payload = client.request('POST', f"/betaGroups/{group['id']}/relationships/builds",
                                     body={'data': [{'type': 'builds', 'id': build_id}]})
    if status == 409 and 'already' in errors_of(payload).lower():
        print(f"{args.version} ({args.build}) was already in '{args.group}'.")
    else:
        need(status, payload, f"Adding the build to '{args.group}'")
        print(f"Added {args.version} ({args.build}) to '{args.group}'.")
    if not internal:
        print('External testers get it after TestFlight App Review approves it; submit it in App Store Connect (the workflow never does).')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'add'])
    parser.add_argument('--bundle-id', required=True)
    parser.add_argument('--group', default='')
    parser.add_argument('--testers', default='internal-and-external')
    parser.add_argument('--version')
    parser.add_argument('--build')
    parser.add_argument('--wait-minutes', type=int, default=45)
    args = parser.parse_args()
    args.group = args.group.strip()
    if args.action == 'add' and not (args.group and args.version and args.build):
        parser.error('add needs --group, --version and --build')
    for name in ('ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8'):
        if not os.environ.get(name):
            print(f'The {name} secret is missing')
            sys.exit(64)
    client = Client(os.environ['ASC_KEY_ID'], os.environ['ASC_ISSUER_ID'], os.environ['ASC_KEY_P8'])
    try:
        (check if args.action == 'check' else add)(client, args)
    finally:
        client.close()


if __name__ == '__main__':
    main()
