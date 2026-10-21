"""Checks that a signed Pocket AI agrees with itself before it is uploaded.

For the app and each extension it compares the signature's entitlements,
the embedded App Store profile and the bundle identifier: the App ID and
team match, the memory entitlements are exactly the ones asked for and only
on the app (never on the Live Activity extension, never the debugging
variant), and every entitlement the code claims is one the profile grants.
With --adhoc it checks only the entitlements sign-archive.sh wrote, before
the export. Prints check names and results only: never the team ID, the
developer's name or the profile's name, because the job log is public.
Usage: TEAM_ID=<team> BUNDLE_ID=<app identifier> check-export.py <ipa | .app> --memory <eva+iml|eva|iml|none> [--adhoc]
"""
import argparse
import datetime
import glob
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

EVA = 'com.apple.developer.kernel.extended-virtual-addressing'
IML = 'com.apple.developer.kernel.increased-memory-limit'
DEBUG_LIMIT = 'com.apple.developer.kernel.increased-debugging-memory-limit'
MEMORY = {'eva+iml': {EVA, IML}, 'eva': {EVA}, 'iml': {IML}, 'none': set()}
SHORT = {EVA: 'Extended Virtual Addressing', IML: 'Increased Memory Limit'}


def granted(profile, key, value):
    """Whether the profile's entitlements allow the code's key and value."""
    allowed = profile.get(key)
    if allowed is None:
        return False

    def matches(pattern, item):
        # Profiles grant some values as a prefix, such as "TEAM.*".
        if isinstance(pattern, str) and pattern.endswith('*') and isinstance(item, str):
            return item.startswith(pattern[:-1])
        return pattern == item

    if isinstance(allowed, list):
        items = value if isinstance(value, list) else [value]
        return all(any(matches(pattern, item) for pattern in allowed) for item in items)
    return matches(allowed, value)


def check_target(name, identifier, is_app, entitlements, team, memory, app_id, profile=None, signature=None, now=None):
    """Returns [(ok, target, check)] for one signed bundle. profile and
    signature are None for an ad hoc signature."""
    rows = []
    def add(ok, check):
        rows.append((bool(ok), name, check))

    if is_app:
        add(identifier == app_id, f'bundle identifier is {app_id}')
    else:
        add(identifier == app_id + '.activity', f'extension identifier is {app_id}.activity')
    add(entitlements.get('application-identifier') == f'{team}.{identifier}', 'application-identifier = TEAM.<bundle identifier>')
    add(entitlements.get('com.apple.developer.team-identifier') == team, 'team-identifier = TEAM')
    wanted = memory if is_app else set()
    for key in (EVA, IML):
        has = entitlements.get(key) is True
        label = SHORT[key]
        if key in wanted:
            add(has, f'{label}: on')
        else:
            add(key not in entitlements, f'{label}: off')
    add(DEBUG_LIMIT not in entitlements, 'no Increased Debugging Memory Limit')
    if profile is None:
        return rows

    add(entitlements.get('get-task-allow') in (None, False), 'get-task-allow off (not a debug build)')
    add(team in profile.get('TeamIdentifier', []), 'profile team = TEAM')
    add('ProvisionedDevices' not in profile and not profile.get('ProvisionsAllDevices'), 'App Store profile (no device list)')
    granted_entitlements = profile.get('Entitlements', {})
    add(granted_entitlements.get('beta-reports-active') is True, 'profile allows TestFlight (beta-reports-active)')
    expires = profile.get('ExpirationDate')
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if isinstance(expires, datetime.datetime):
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=datetime.timezone.utc)
        add(expires > now, 'profile not expired')
    else:
        add(False, 'profile has an expiry date')
    missing = sorted(key for key, value in entitlements.items() if not granted(granted_entitlements, key, value))
    add(not missing, 'every signed entitlement is granted by the profile' + (f' (missing: {", ".join(missing)})' if missing else ''))
    for key in sorted(wanted):
        add(granted_entitlements.get(key) is True, f'profile grants {SHORT[key]}')
    if signature is not None:
        add(signature.get('team') == team, 'signature team = TEAM')
        add(signature.get('distribution', False), 'signed with a distribution certificate')
    return rows


def run(command):
    return subprocess.run(command, capture_output=True, text=True)


def read_entitlements(bundle):
    result = run(['codesign', '-d', '--entitlements', '-', '--xml', bundle])
    if result.returncode != 0 or not result.stdout.strip():
        result = run(['codesign', '-d', '--entitlements', ':-', bundle])
    text = result.stdout.strip()
    return plistlib.loads(text.encode()) if text else {}


def read_signature(bundle):
    details = run(['codesign', '-d', '--verbose=2', bundle]).stderr
    team = re.search(r'^TeamIdentifier=(\S+)', details, re.M)
    authority = re.search(r'^Authority=([^:\n]+)', details, re.M)
    return {
        'team': team.group(1) if team else None,
        'distribution': bool(authority and authority.group(1).strip() in ('Apple Distribution', 'iPhone Distribution')),
        'adhoc': 'Signature=adhoc' in details,
    }


def read_profile(bundle):
    path = os.path.join(bundle, 'embedded.mobileprovision')
    if not os.path.exists(path):
        return None
    result = run(['security', 'cms', '-D', '-i', path])
    return plistlib.loads(result.stdout.encode()) if result.returncode == 0 else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('path', help='a signed .ipa, or an .app inside an archive')
    parser.add_argument('--memory', choices=sorted(MEMORY), required=True)
    parser.add_argument('--adhoc', action='store_true', help='check the ad hoc signature from sign-archive.sh')
    args = parser.parse_args()
    team = os.environ.get('TEAM_ID', '').strip()
    if not team:
        sys.exit('the APPLE_TEAM_ID secret is missing')
    app_id = os.environ.get('BUNDLE_ID', '').strip()
    if not app_id:
        sys.exit('BUNDLE_ID (the app\'s App ID) is missing')
    memory = MEMORY[args.memory]

    work = None
    app = args.path
    if args.path.endswith('.ipa'):
        work = tempfile.mkdtemp()
        subprocess.run(['ditto', '-x', '-k', args.path, work], check=True)
        apps = glob.glob(os.path.join(work, 'Payload', '*.app'))
        if len(apps) != 1:
            sys.exit('the IPA does not hold exactly one app')
        app = apps[0]
    try:
        rows = []
        targets = [(app, True)] + [(path, False) for path in sorted(glob.glob(os.path.join(app, 'PlugIns', '*.appex')))]
        if len(targets) < 2:
            rows.append((False, 'PocketGemma.app', 'Live Activity extension present'))
        for bundle, is_app in targets:
            with open(os.path.join(bundle, 'Info.plist'), 'rb') as handle:
                identifier = plistlib.load(handle)['CFBundleIdentifier']
            name = os.path.basename(bundle)
            signature = read_signature(bundle)
            if args.adhoc:
                rows.append((signature['adhoc'], name, 'ad hoc signature (before export)'))
                rows += check_target(name, identifier, is_app, read_entitlements(bundle), team, memory, app_id)
            else:
                profile = read_profile(bundle)
                rows.append((profile is not None, name, 'embedded App Store profile'))
                rows += check_target(name, identifier, is_app, read_entitlements(bundle), team, memory, app_id,
                                     profile or {}, signature)
        verify = run(['codesign', '--verify', '--deep', '--strict', app])
        rows.append((verify.returncode == 0, os.path.basename(app), 'codesign --verify --deep --strict'))
    finally:
        if work:
            shutil.rmtree(work, ignore_errors=True)

    stage = 'ad hoc, before export' if args.adhoc else 'signed for App Store Connect'
    lines = [f'Signing check ({stage}); memory entitlements asked for: {args.memory}']
    lines += [f'{"OK" if ok else "NG"}  {target}: {check}' for ok, target, check in rows]
    failed = [row for row in rows if not row[0]]
    lines.append('All checks passed' if not failed else f'{len(failed)} check(s) failed')
    text = '\n'.join(line.replace(team, 'TEAM') for line in lines)
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary and not args.adhoc:
        with open(summary, 'a') as handle:
            handle.write('```\n' + text + '\n```\n')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
