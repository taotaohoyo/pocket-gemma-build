"""Checks the address-space test IPA against the unsigned IPA it was signed from.

The app must carry exactly the two entitlements, the extension none of them,
and nothing but signatures may differ from the unsigned build.
"""
import plistlib
import struct
import sys
import zipfile

KEYS = {'com.apple.developer.kernel.extended-virtual-addressing',
        'com.apple.developer.kernel.increased-memory-limit'}
BASE = 'Payload/PocketGemma.app/'
MACHO = b'\xcf\xfa\xed\xfe'
LC_CODE_SIGNATURE = 0x1D
CSSLOT_ENTITLEMENTS = 5


def entitlements(binary):
    """The XML entitlements in a thin 64-bit Mach-O's embedded signature."""
    assert binary[:4] == MACHO, 'Expected a 64-bit Mach-O'
    commands = struct.unpack_from('<I', binary, 16)[0]
    offset = 32
    for _ in range(commands):
        command, size = struct.unpack_from('<II', binary, offset)
        if command == LC_CODE_SIGNATURE:
            start, length = struct.unpack_from('<II', binary, offset + 8)
            blob = binary[start:start + length]
            magic, _, count = struct.unpack_from('>III', blob)
            assert magic == 0xFADE0CC0, 'Not an embedded signature'
            for index in range(count):
                slot, at = struct.unpack_from('>II', blob, 12 + 8 * index)
                if slot == CSSLOT_ENTITLEMENTS:
                    magic, size = struct.unpack_from('>II', blob, at)
                    assert magic == 0xFADE7171, 'Not an entitlements blob'
                    return plistlib.loads(blob[at + 8:at + size])
            return {}
        offset += size
    raise AssertionError('Not signed')


def files(archive):
    return {item.filename: item for item in archive.infolist()
            if not item.is_dir() and not item.filename.startswith('__MACOSX/') and '/._' not in item.filename}


def check(unsigned_path, signed_path):
    with zipfile.ZipFile(unsigned_path) as unsigned, zipfile.ZipFile(signed_path) as signed:
        assert signed.testzip() is None, 'Corrupt IPA'
        old, new = files(unsigned), files(signed)
        assert set(old) <= set(new), f'Missing after signing: {sorted(set(old) - set(new))}'
        added = sorted(set(new) - set(old))
        assert all('/_CodeSignature/' in name for name in added), f'Unexpected files: {added}'
        for name, item in old.items():
            assert new[name].external_attr >> 16 == item.external_attr >> 16, f'Permissions changed: {name}'
            data = signed.read(name)
            if data[:4] != MACHO:
                assert data == unsigned.read(name), f'Changed by signing: {name}'
        info = plistlib.loads(signed.read(BASE + 'Info.plist'))
        assert info['CFBundleIdentifier'] == 'app.pocketgemma.personal'
        version = (info['CFBundleShortVersionString'], info['CFBundleVersion'])
        assert version == ('1.0.112', '113'), version
        granted = entitlements(signed.read(BASE + info['CFBundleExecutable']))
        assert set(granted) == KEYS and all(granted[key] is True for key in KEYS), granted
        extensions = [name for name in new if name.startswith(BASE + 'PlugIns/') and name.endswith('.appex/Info.plist')]
        assert extensions, 'Live Activity extension missing'
        for plist in extensions:
            extension = plistlib.loads(signed.read(plist))
            assert (extension['CFBundleShortVersionString'], extension['CFBundleVersion']) == version
            binary = signed.read(plist.removesuffix('Info.plist') + extension['CFBundleExecutable'])
            assert not KEYS & set(entitlements(binary)), 'The extension must not carry the entitlements'
        signatures = sum(name.endswith('/_CodeSignature/CodeResources') for name in added)
        print(f'Address-space test IPA OK: {version[0]} ({version[1]}), {sorted(granted)}, {signatures} sealed bundles')


if __name__ == '__main__':
    check(sys.argv[1], sys.argv[2])
