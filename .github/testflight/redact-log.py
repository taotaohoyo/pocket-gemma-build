"""Prints the useful lines of an export or distribution log, redacted.

The repository is public, so its job logs are too. GitHub masks the secrets
themselves; this also hides the developer's name and Apple ID that Xcode's
signing and distribution logs print, and keeps only lines worth reading.
Usage: redact-log.py <log> [--all-errors] [--limit N]
"""
import argparse
import os
import re

KEEP = re.compile(r'error|warning|ITMS-|EXPORT (SUCCEEDED|FAILED)|[Uu]pload|[Ss]ucceeded|[Ff]ailed|Progress|denied|forbidden|not allowed|profile|certificate', re.I)
RULES = [
    (re.compile(r'(Apple (?:Distribution|Development|Worldwide Developer Relations)[^:]*): [^\n"(]*(\([^)]*\))?'), r'\1: [redacted]'),
    (re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+'), '[email]'),
    (re.compile(r'("?(?:teamName|name|firstName|lastName|fullName|email|emailAddress|appleId|providerName|accountName)"?\s*[:=]\s*)"[^"]*"', re.I), r'\1"[redacted]"'),
    (re.compile(r'/Users/[^/\s]+'), '/Users/[user]'),
]

parser = argparse.ArgumentParser()
parser.add_argument('log')
parser.add_argument('--all-errors', action='store_true', help='only error lines, for distribution logs')
parser.add_argument('--limit', type=int, default=120)
args = parser.parse_args()

extra = [value for value in (os.environ.get('APPLE_TEAM_NAME', '').strip(),) if value]
printed = 0
with open(args.log, errors='replace') as handle:
    for line in handle:
        if args.all_errors and not re.search(r'error|ITMS-|failed', line, re.I):
            continue
        if not args.all_errors and not KEEP.search(line):
            continue
        for pattern, replacement in RULES:
            line = pattern.sub(replacement, line)
        for value in extra:
            line = line.replace(value, '[redacted]')
        print(line.rstrip()[:400])
        printed += 1
        if printed >= args.limit:
            print(f'... (more lines in the runner-only log; limit {args.limit})')
            break
