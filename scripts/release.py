"""Bump TestPion's version everywhere and add the changelog entry.

    python scripts/release.py OLD NEW entry.md

entry.md holds the body of the changelog entry (the "## NEW — date" heading is added). See .claude/skills/cut-release.
"""
import datetime
import os
import sys

old, new, entry_file = sys.argv[1], sys.argv[2], sys.argv[3]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + os.sep
for f in ['apps/desktop/package.json', 'docs/package.json', 'package.json', 'packages/cli/package.json', 'packages/core/package.json', 'packages/shared/package.json']:
    s = open(root + f, encoding='utf8', newline='').read()
    assert f'"version": "{old}"' in s, f'{f} is not at {old}'
    s = s.replace(f'"version": "{old}"', f'"version": "{new}"', 1)
    s = s.replace(f'"@testpion/core": "{old}"', f'"@testpion/core": "{new}"')
    s = s.replace(f'"@testpion/shared": "{old}"', f'"@testpion/shared": "{new}"')
    open(root + f, 'w', encoding='utf8', newline='').write(s)
f = 'packages/core/src/version.ts'
s = open(root + f, encoding='utf8', newline='').read()
assert old in s, f'{f} is not at {old}'
open(root + f, 'w', encoding='utf8', newline='').write(s.replace(old, new))
p = root + 'CHANGELOG.md'
s = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
body = open(entry_file, encoding='utf8').read().strip('\n')
entry = f'## {new} — {datetime.date.today().isoformat()}\n\n{body}\n\n'.replace('\n', nl)
i = s.index(f'## {old}')
s = s[:i] + entry + s[i:]
open(p, 'w', encoding='utf8', newline='').write(s)
print('ok', new)
