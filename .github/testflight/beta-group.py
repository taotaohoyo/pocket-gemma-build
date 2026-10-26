"""Writes What to Test on an uploaded build and puts it into a TestFlight group (testflight.yml).

notes: checks the What to Test text (the WHATS_NEW environment variable)
  before anything is built: at most 4000 characters, no emoji and no '<',
  which App Store Connect does not take. Needs no key.
check: lists the app's TestFlight groups (name, internal or external) and
  makes sure the chosen group exists and can take the build, before anything
  is signed or uploaded. With no group it only lists them.
finish: waits for the uploaded build. As soon as App Store Connect lists it,
  writes What to Test in every language the build has, so testers see it with
  the build; then waits until the build is processed, writes any language
  App Store Connect added meanwhile, and adds the build to the chosen group.
  An internal group that already gets every build is left as it is. An
  external group still needs TestFlight App Review, which the workflow never
  submits; App Store Connect does that.

Signs in with the App Store Connect API key (ES256, signed by openssl), so it
needs nothing outside Python's standard library. The job log is public: it
prints group names, the What to Test text and the build's state only, never
testers or emails.
Usage:
  WHATS_NEW beta-group.py notes
  ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 [WHATS_NEW] beta-group.py check --bundle-id ID --testers T [--group NAME]
  ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 [WHATS_NEW] beta-group.py finish --bundle-id ID --version V --build B [--group NAME] [--wait-minutes M]
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
# App Store Connect's limit for What to Test.
MAX_NOTES = 4000
# Characters iOS draws as emoji by default that sit outside the emoji planes.
BMP_EMOJI = set('⌚⌛⏩⏪⏫⏬⏰⏳◽◾☔☕♈♉♊♋♌♍♎♏♐♑♒♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽'
                '✅✊✋✨❌❎❓❔❕❗➕➖➗➰➿⬛⬜⭐⭕')


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


def clean_notes(text):
    """What to Test as App Store Connect will show it. A \\n typed in the run form starts a new line."""
    text = text.replace('\r\n', '\n').replace('\r', '\n').replace('\\n', '\n')
    return '\n'.join(line.rstrip() for line in text.split('\n')).strip()


def is_emoji(char):
    code = ord(char)
    return (0x1F000 <= code <= 0x1FAFF or 0xE0020 <= code <= 0xE007F
            or code in (0x200D, 0x20E3, 0xFE0F) or char in BMP_EMOJI)


def notes_problems(notes):
    problems = []
    if len(notes) > MAX_NOTES:
        problems.append(f'it has {len(notes)} characters; App Store Connect takes up to {MAX_NOTES}')
    if '<' in notes:
        problems.append("it has '<', which App Store Connect does not take (write ＜ instead)")
    emoji = sorted({char for char in notes if is_emoji(char)})
    if emoji:
        problems.append('it has emoji, which App Store Connect does not take: '
                        + ', '.join(f'U+{ord(char):04X}' for char in emoji))
    return problems


def require_notes(notes):
    if not notes:
        print('No What to Test given: the build is left without one.')
        return
    problems = notes_problems(notes)
    if problems:
        print('What to Test cannot be written as given: ' + '; '.join(problems) + '.')
        print('Nothing was built or uploaded. Fix whats_new and run again.')
        sys.exit(1)
    print(f'What to Test ({len(notes)} characters), written to the build once App Store Connect lists it:')
    for line in notes.split('\n'):
        print('  | ' + line)


def same_name(a, b):
    return unicodedata.normalize('NFC', a).strip() == unicodedata.normalize('NFC', b).strip()


def find_app(client, bundle_id):
    payload = need(*client.request('GET', '/apps', {'filter[bundleId]': bundle_id, 'fields[apps]': 'bundleId,name,primaryLocale',
                                                    'limit': 10}), 'Finding the app')
    for app in payload.get('data', []):
        if app['attributes'].get('bundleId') == bundle_id:
            return app
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
    require_notes(args.notes)
    groups = list_groups(client, find_app(client, args.bundle_id)['id'])
    if not args.group:
        print('No group chosen: the build is only uploaded.')
        return
    group = pick_group(groups, args.group)
    internal = group['attributes'].get('isInternalGroup')
    if not internal and args.testers == 'internal-only':
        print(f"'{args.group}' is an external group, and an internal-only build can never join one. Upload with testers internal-and-external.")
        sys.exit(1)
    print(f"The build will go to '{args.group}' ({'internal' if internal else 'external'}) once App Store Connect has processed it.")


def wait_for_build(client, app_id, version, build, minutes, on_listed=None):
    """Returns the build's id once it is processed. Calls on_listed(id) once, as soon as App Store Connect lists it."""
    deadline = time.time() + minutes * 60
    last = None
    listed = False
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
            if found and state in ('FAILED', 'INVALID'):
                print(f'App Store Connect could not process {version} ({build}): {state}')
                sys.exit(1)
            if found and not listed:
                listed = True
                print(f'{version} ({build}): {state}')
                last = state
                if on_listed:
                    on_listed(found[0]['id'])
            if found and state == 'VALID':
                print(f'{version} ({build}) is processed.')
                return found[0]['id']
        if state != last:
            print(f'{version} ({build}): {state}')
            last = state
        if time.time() > deadline:
            print(f'{version} ({build}) was not processed within {minutes} minutes; add it to the group in App Store Connect.')
            sys.exit(1)
        time.sleep(30)


def test_info_locales(client, app):
    """The languages of the app's TestFlight test information, else its primary language."""
    status, payload = client.request('GET', f"/apps/{app['id']}/betaAppLocalizations", {
        'fields[betaAppLocalizations]': 'locale', 'limit': 50})
    locales = [item['attributes'].get('locale') for item in payload.get('data', [])] if status < 300 else []
    return [locale for locale in locales if locale] or [app['attributes'].get('primaryLocale') or 'ja']


def write_notes(client, app, build_id, notes, early):
    """Writes What to Test in every language the build has. Returns False when App Store Connect refused."""
    later = ' (tried again once the build is processed)' if early else ''
    status, payload = client.request('GET', f'/builds/{build_id}/betaBuildLocalizations', {
        'fields[betaBuildLocalizations]': 'locale,whatsNew', 'limit': 50})
    if status >= 300:
        print(f"Reading the build's What to Test failed: HTTP {status}: {errors_of(payload)}{later}")
        return False
    written = True
    localizations = payload.get('data', [])
    for item in localizations:
        locale = item['attributes'].get('locale')
        if clean_notes(item['attributes'].get('whatsNew') or '') == notes:
            if not early:
                print(f'What to Test ({locale}) is in place.')
            continue
        status, payload = client.request('PATCH', f"/betaBuildLocalizations/{item['id']}", body={'data': {
            'type': 'betaBuildLocalizations', 'id': item['id'], 'attributes': {'whatsNew': notes}}})
        if status >= 300:
            print(f'Writing What to Test ({locale}) failed: HTTP {status}: {errors_of(payload)}{later}')
            written = False
        else:
            print(f'What to Test ({locale}) written.')
    if not localizations:
        for locale in test_info_locales(client, app):
            status, payload = client.request('POST', '/betaBuildLocalizations', body={'data': {
                'type': 'betaBuildLocalizations', 'attributes': {'locale': locale, 'whatsNew': notes},
                'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}})
            if status >= 300:
                print(f'Writing What to Test ({locale}) failed: HTTP {status}: {errors_of(payload)}{later}')
                written = False
            else:
                print(f'What to Test ({locale}) written.')
    return written


def add_to_group(client, group, args, build_id):
    attributes = group['attributes']
    internal = attributes.get('isInternalGroup')
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


def finish(client, args):
    if not (args.group or args.notes):
        print('No group and no What to Test: nothing to do after the upload.')
        return
    app = find_app(client, args.bundle_id)
    group = pick_group(list_groups(client, app['id']), args.group) if args.group else None

    def on_listed(build_id):
        # Early, so that testers who get every build see the text with it.
        if args.notes:
            write_notes(client, app, build_id, args.notes, early=True)

    build_id = wait_for_build(client, app['id'], args.version, args.build, args.wait_minutes, on_listed)
    # App Store Connect can add a language while it processes the build, and
    # an early write can be refused; go over every language again.
    notes_written = not args.notes or write_notes(client, app, build_id, args.notes, early=False)
    if group:
        add_to_group(client, group, args, build_id)
    if not notes_written:
        print(f'What to Test is missing on {args.version} ({args.build}); enter it in App Store Connect (TestFlight, the build, テスト内容).')
        sys.exit(1)


def main():
    # The runner's log is not a terminal; without this the lines show only at the end.
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['notes', 'check', 'finish'])
    parser.add_argument('--bundle-id')
    parser.add_argument('--group', default='')
    parser.add_argument('--testers', default='internal-and-external')
    parser.add_argument('--version')
    parser.add_argument('--build')
    parser.add_argument('--wait-minutes', type=int, default=45)
    args = parser.parse_args()
    args.group = args.group.strip()
    args.notes = clean_notes(os.environ.get('WHATS_NEW', ''))
    if args.action == 'notes':
        require_notes(args.notes)
        return
    if not args.bundle_id:
        parser.error(f'{args.action} needs --bundle-id')
    if args.action == 'finish' and not (args.version and args.build):
        parser.error('finish needs --version and --build')
    for name in ('ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8'):
        if not os.environ.get(name):
            print(f'The {name} secret is missing')
            sys.exit(64)
    client = Client(os.environ['ASC_KEY_ID'], os.environ['ASC_ISSUER_ID'], os.environ['ASC_KEY_P8'])
    try:
        (check if args.action == 'check' else finish)(client, args)
    finally:
        client.close()


if __name__ == '__main__':
    main()
