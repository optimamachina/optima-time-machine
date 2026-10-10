"""Builds the release zip: releases/Optima-Time-Machine-<version>.zip and its .sha256.

Only what a user needs goes in (the extension, README, LICENSE), under one folder named
optima-time-machine/. File dates are fixed, so the same source gives the same zip and checksum.

    python tools/package.py
"""
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCLUDE = ['manifest.json', 'LICENSE', 'README.md', 'src', 'ui', 'icons']
SKIP = {'icons/icon-512.png'}  # the website's shelf image, not used by the extension

version = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
name = f'Optima-Time-Machine-{version}.zip'
out = ROOT / 'releases' / name
out.parent.mkdir(exist_ok=True)

files = []
for item in INCLUDE:
    p = ROOT / item
    files += [p] if p.is_file() else sorted(q for q in p.rglob('*') if q.is_file())

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in files:
        rel = p.relative_to(ROOT).as_posix()
        if rel in SKIP:
            continue
        info = zipfile.ZipInfo('optima-time-machine/' + rel, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, p.read_bytes())

digest = hashlib.sha256(out.read_bytes()).hexdigest()
(out.parent / (name + '.sha256')).write_text(f'{digest}  {name}\n', encoding='utf-8')
with zipfile.ZipFile(out) as z:
    count = len(z.namelist())
print(f'{name}: {out.stat().st_size} bytes, {count} files')
print(f'sha256 {digest}')
