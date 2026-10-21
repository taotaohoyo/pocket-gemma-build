"""Gives the TestFlight build the paid team's App IDs.

PocketGemma-source.zip keeps app.pocketgemma.personal, which the unsigned
SideInstaller and AltStore builds use. In the archive job's checkout only,
this sets the app to the given identifier and the Live Activity extension to
<identifier>.activity, and points the source's IPA check at it. Everything
else follows from PRODUCT_BUNDLE_IDENTIFIER (the continued-download task
identifiers) or from Bundle.main at run time. Each change must match exactly
once, so a change in the source stops the build instead of passing silently.
Usage, from the source checkout: set-bundle-id.py <identifier>
"""
import re
import sys
from pathlib import Path

SOURCE_ID = 'app.pocketgemma.personal'


def replace_once(text, name, template, old, new):
    """Puts new where template holds old, once; leaves text that already has new."""
    old_pattern = template.format(re.escape(old))
    found = len(re.findall(old_pattern, text, flags=re.M))
    if found == 0 and re.search(template.format(re.escape(new)), text, flags=re.M):
        return text
    if found != 1:
        sys.exit(f'{name}: expected one {old}, found {found}')
    return re.sub(old_pattern, lambda match: match.group(0).replace(old, new), text, flags=re.M)


def main():
    identifier = sys.argv[1].strip()
    if not re.fullmatch(r'[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+', identifier):
        sys.exit(f'not a bundle identifier: {identifier!r}')

    project = Path('project.yml')
    text = project.read_text()
    for suffix in ('', '.activity'):
        text = replace_once(text, 'project.yml', r'^\s*PRODUCT_BUNDLE_IDENTIFIER:\s*{}\s*$',
                            SOURCE_ID + suffix, identifier + suffix)
    project.write_text(text)

    check = Path('scripts/check-ipa.py')
    check.write_text(replace_once(check.read_text(), 'scripts/check-ipa.py', r'== "{}"', SOURCE_ID, identifier))
    print(f'TestFlight bundle identifiers: app {identifier}, Live Activity {identifier}.activity')


if __name__ == '__main__':
    main()
