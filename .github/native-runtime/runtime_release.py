"""Keep the verified native runtime in a GitHub release and fetch it for builds.

Actions artifacts expire after 7 days, so builds read the runtime from the
release pinned in release.json instead of a run ID. `fetch` needs only the
Python standard library and a token that can read the repository, so it also
works on a self-hosted Mac or after the repository becomes private.
`preserve` checks an artifact that rebuild-ios-runtime.yml already uploaded and
prepares release files with the same bytes; it never rebuilds or edits them.
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNTIME = 'PocketGemma-NativeRuntime.zip'
ARTIFACT = 'PocketGemma-Rebuilt-NativeRuntime'
REBUILD_WORKFLOW = '.github/workflows/rebuild-ios-runtime.yml'
API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = os.environ.get('GITHUB_REPOSITORY', 'taotaohoyo/pocket-gemma-build')
AGENT = 'PocketGemma-native-runtime'
# Credentials block publication. The other patterns are only reported.
SECRETS = {
    'GitHub token': rb'(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})',
    'AWS access key': rb'(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])',
    'Private key': rb'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----',
    'Slack token': rb'xox[abposr]-[A-Za-z0-9-]{10,}',
    'Google API key': rb'AIza[0-9A-Za-z_\-]{35}',
    'Authorization header': rb'[Aa]uthorization: *(?:[Bb]earer|[Tt]oken) +[A-Za-z0-9_.\-]{20,}',
}
REVIEW = {
    'Home folder other than the runner': rb'/Users/(?!runner/|Shared/)[A-Za-z0-9._-]+/',
    'Apple private relay address': rb'@privaterelay\.appleid\.com',
}
SIGNING = ('.mobileprovision', '.p12', '.pfx', '.p8', '.cer', '.der', '.pem', '.key', '.keychain', '.keychain-db')


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def call(path, accept='application/vnd.github+json', method='GET', body=None):
    """Call the GitHub API; follow a storage redirect without the token."""
    headers = {'Accept': accept, 'User-Agent': AGENT, 'X-GitHub-Api-Version': '2022-11-28'}
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    url = path if path.startswith('https://') else f'{API}/{path}'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if method != 'GET' or error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers['Location']
    with urllib.request.urlopen(urllib.request.Request(location, headers={'User-Agent': AGENT}), timeout=600) as response:
        return response.read()


def output(**values):
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as file:
            for key, value in values.items():
                file.write(f'{key}={value}\n')


def find_release(tag):
    try:
        return json.loads(call(f'repos/{REPO}/releases/tags/{tag}'))
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    # A draft has no git tag yet and is listed only to tokens that can push.
    for page in range(1, 11):
        releases = json.loads(call(f'repos/{REPO}/releases?per_page=100&page={page}'))
        for release in releases:
            if release['tag_name'] == tag:
                return release
        if len(releases) < 100:
            break
    raise SystemExit(f'Release {tag} not found; a draft release is visible only with contents: write')


def download_asset(release, name, size=None, digest=None):
    assets = [a for a in release['assets'] if a['name'] == name]
    require(len(assets) == 1, f'Release {release["tag_name"]} lacks {name}')
    asset = assets[0]
    require(size is None or asset['size'] == size, f'{name} in the release has an unexpected size')
    require(digest is None or asset.get('digest') in (None, 'sha256:' + digest), f'GitHub recorded another digest for {name}')
    data = call(asset['url'], 'application/octet-stream')
    require(len(data) == asset['size'], f'{name} download is incomplete')
    return data


def fetch(args):
    lock = json.loads(args.lock.read_text())
    run_id = args.run_id.strip()
    if run_id and run_id != str(lock['source']['run']):
        # A newer rebuild under test; the caller downloads its artifact.
        require(run_id.isdecimal(), 'The native runtime run ID must be a number')
        run = json.loads(call(f'repos/{REPO}/actions/runs/{run_id}'))
        require(run['path'] == REBUILD_WORKFLOW, 'The run is not a native runtime rebuild')
        require(run['status'] == 'completed' and run['conclusion'] == 'success', 'The native runtime rebuild did not succeed')
        print('Using native runtime rebuild run', run_id, 'instead of the pinned release', lock['tag'])
        output(source='run')
        return
    release = find_release(lock['tag'])
    data = download_asset(release, lock['asset'], lock['bytes'], lock['sha256'])
    require(sha256(data) == lock['sha256'], 'Downloaded runtime differs from release.json')
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / lock['asset']).write_bytes(data)
    print(json.dumps({'release': lock['tag'], 'draft': release['draft'], 'asset': lock['asset'],
                      'bytes': len(data), 'sha256': lock['sha256'], 'buildID': lock['buildID']}, indent=2))
    output(source='release')


def scan(name, data, findings):
    for kind, pattern in [*SECRETS.items(), *REVIEW.items()]:
        matches = re.findall(pattern, data)
        if matches:
            # Logs are public: show only the start of the first match.
            findings.append({'kind': kind, 'file': name, 'count': len(matches),
                             'sample': matches[0][:6].decode('latin-1') + '…', 'blocking': kind in SECRETS})
    if name.lower().endswith(SIGNING):
        findings.append({'kind': 'Signing material', 'file': name, 'count': 1, 'sample': '', 'blocking': True})


def preserve(args):
    run = json.loads(call(f'repos/{REPO}/actions/runs/{args.run}'))
    require(run['path'] == REBUILD_WORKFLOW, 'The run is not a native runtime rebuild')
    require(run['status'] == 'completed' and run['conclusion'] == 'success', 'The native runtime rebuild did not succeed')
    artifacts = json.loads(call(f'repos/{REPO}/actions/runs/{args.run}/artifacts'))['artifacts']
    artifacts = [a for a in artifacts if a['name'] == ARTIFACT and not a['expired']]
    require(len(artifacts) == 1, 'The run has no unexpired runtime artifact')
    artifact = artifacts[0]
    digest = (artifact.get('digest') or '').removeprefix('sha256:')
    require(len(digest) == 64, 'GitHub recorded no digest for the artifact')
    jobs = json.loads(call(f'repos/{REPO}/actions/runs/{args.run}/jobs'))['jobs']
    require(len(jobs) == 1 and jobs[0]['conclusion'] == 'success', 'Expected one successful build job')
    log = call(f'repos/{REPO}/actions/jobs/{jobs[0]["id"]}/logs')
    require(f'SHA256 digest of uploaded artifact zip is {digest}'.encode() in log, 'The build log does not record this artifact digest')
    require(f'Artifact {ARTIFACT} has been successfully uploaded! Final size is {artifact["size_in_bytes"]} bytes. '
            f'Artifact ID is {artifact["id"]}'.encode() in log, 'The build log does not record this artifact')
    outer = call(f'repos/{REPO}/actions/artifacts/{artifact["id"]}/zip')
    require(len(outer) == artifact['size_in_bytes'] and sha256(outer) == digest,
            'Downloaded artifact differs from the digest GitHub recorded at upload')
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out.parent / 'artifact.zip').write_bytes(outer)
    with zipfile.ZipFile(args.out.parent / 'artifact.zip') as archive:
        names = sorted(archive.namelist())
        require(names == [RUNTIME, RUNTIME + '.sha256'], f'Unexpected artifact members: {names}')
        runtime = archive.read(RUNTIME)
        recorded = archive.read(RUNTIME + '.sha256').decode().strip()
    runtime_sha = sha256(runtime)
    require(recorded.split()[0] == runtime_sha, 'Runtime ZIP differs from the checksum build.sh recorded')
    (args.out / RUNTIME).write_bytes(runtime)
    sys.path.insert(0, 'NativeRuntime')
    from native_artifact import verify_zip
    upstream = json.loads(Path('NativeRuntime/upstream-lock.json').read_text())
    receipt = verify_zip(args.out / RUNTIME, upstream)

    findings, members, receipt_bytes = [], [], None
    with zipfile.ZipFile(args.out / RUNTIME) as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue
            data = archive.read(item)
            members.append({'name': item.filename, 'bytes': len(data), 'sha256': sha256(data)})
            scan(item.filename, data, findings)
            if item.filename == 'native-runtime-build.json':
                receipt_bytes = data
    log_name = f'native-rebuild-{args.run}.log'
    scan(log_name, log, findings)
    for path in sorted(args.out.iterdir()):
        if path.name != RUNTIME:
            scan(path.name, path.read_bytes(), findings)
    blocking = [f for f in findings if f['blocking']]

    tag = 'native-runtime-' + receipt['buildID']
    (args.out / (RUNTIME + '.sha256')).write_text(f'{runtime_sha}  {RUNTIME}\n')
    (args.out / 'native-runtime-build.json').write_bytes(receipt_bytes)
    (args.out / (log_name + '.gz')).write_bytes(gzip.compress(log, 9, mtime=0))
    lock = {'buildID': receipt['buildID'], 'tag': tag, 'asset': RUNTIME, 'bytes': len(runtime), 'sha256': runtime_sha,
            'source': {'workflow': REBUILD_WORKFLOW, 'run': int(args.run), 'job': jobs[0]['id'], 'commit': run['head_sha'],
                       'artifact': artifact['id'], 'artifactDigest': 'sha256:' + digest}}
    (args.out / 'release.json').write_text(json.dumps(lock, indent=2) + '\n')
    manifest = {**lock,
                'buildChecksumLine': recorded,
                'receipt': {k: receipt.get(k) for k in ('baseRuntime', 'buildID', 'sourceRevision', 'liteRTSourceRef', 'patchSHA256', 'originalArtifactSHA256')},
                'binaries': [{k: b[k] for k in ('name', 'slice', 'bytes', 'sha256')} for b in receipt['binaries']],
                'members': members,
                'contentCheck': {'blocking': len(blocking), 'findings': findings},
                'preservedBy': {'repository': REPO, 'run': int(os.environ.get('GITHUB_RUN_ID', '0')), 'commit': os.environ.get('GITHUB_SHA', '')},
                'assets': {p.name: {'bytes': p.stat().st_size, 'sha256': sha256(p.read_bytes())} for p in sorted(args.out.iterdir())}}
    (args.out / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')

    (args.out.parent / 'release-notes.md').write_text(f'''Pocket AI の実機ビルドが使う LiteRT-LM ネイティブランタイム（{receipt['buildID']}）を、Actions の成果物の保存期限（7日）に左右されないよう保管したものです。アプリの IPA ではなく、AltStore で入れるものでもありません。

- 中身：LiteRT-LM {upstream['upstreamTag']} に vision-runtime.patch（SHA-256 {receipt['patchSHA256'][:12]}…）を当てて作り直した LM 層 CLiteRTLM、公式 {upstream['upstreamTag']} の C ランタイムを改名した PGOriginalRuntime、制約ライブラリ PGConstraintProvider。いずれも iOS 実機とシミュレーターの arm64 です。
- 元のビルド：rebuild-ios-runtime.yml の run {args.run}（commit {run['head_sha'][:7]}）、Actions 成果物 {artifact['id']}（SHA-256 {digest[:12]}…）。タグはビルド元ではなく、公開した時点の main を指します。
- {RUNTIME}：{len(runtime):,} バイト、SHA-256 `{runtime_sha}`。成果物に入っていたものと同じバイト列です。
- manifest.json に各バイナリと全ファイルの SHA-256、native-rebuild-{args.run}.log.gz に元のビルドログがあります。
- LiteRT-LM のライセンスは Apache License 2.0 です（LiteRT-LM-LICENSE.txt）。

確認するには、同じフォルダーに落として `sha256sum -c {RUNTIME}.sha256` を実行してください。
''')
    print(json.dumps({'tag': tag, 'runtime': {'bytes': len(runtime), 'sha256': runtime_sha}, 'artifactDigest': digest,
                      'members': len(members), 'binaries': len(receipt['binaries']), 'findings': findings}, indent=2, ensure_ascii=False))
    output(tag=tag, build=receipt['buildID'], blocking=len(blocking))


def publish(args):
    lock = json.loads(args.lock.read_text())
    release = find_release(lock['tag'])
    data = download_asset(release, lock['asset'], lock['bytes'], lock['sha256'])
    require(sha256(data) == lock['sha256'], 'Release runtime differs from release.json')
    manifest = json.loads(download_asset(release, 'manifest.json'))
    require(manifest['sha256'] == lock['sha256'], 'manifest.json describes another runtime')
    require(manifest['contentCheck']['blocking'] == 0, 'The content check found credentials; not publishing')
    if release['draft']:
        call(f'repos/{REPO}/releases/{release["id"]}', method='PATCH',
             body={'draft': False, 'prerelease': True, 'make_latest': 'false'})
    print('Published', lock['tag'], 'as a prerelease (not marked latest)')


parser = argparse.ArgumentParser()
commands = parser.add_subparsers(dest='command', required=True)
command = commands.add_parser('fetch', help='download the pinned runtime for a build')
command.add_argument('out', type=Path)
command.add_argument('--lock', type=Path, default=HERE / 'release.json')
command.add_argument('--run-id', default='')
command.set_defaults(handler=fetch)
command = commands.add_parser('preserve', help='check a rebuild artifact and prepare release files')
command.add_argument('run')
command.add_argument('out', type=Path)
command.set_defaults(handler=preserve)
command = commands.add_parser('publish', help='publish the checked draft release')
command.add_argument('--lock', type=Path, default=HERE / 'release.json')
command.set_defaults(handler=publish)

if __name__ == '__main__':
    arguments = parser.parse_args()
    arguments.handler(arguments)
