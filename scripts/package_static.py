"""Package EdgeOne frontend, Edge and Node Functions without local secrets."""
import hashlib
import json
import zipfile
import subprocess
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
DIST = SITE / 'dist'
ARCHIVE = SITE.parent / 'learning-station-edgeone.zip'
subprocess.run(['node', str(SITE / 'scripts/build.mjs')], cwd=SITE, check=True)
assert (DIST / 'edge-functions/api/[[route]].js').is_file()
assert (DIST / 'cloud-functions/internal/verify-password.js').is_file()
data = json.loads((DIST / 'data.json').read_text(encoding='utf-8'))
audio = json.loads((DIST / 'audio-manifest.json').read_text(encoding='utf-8'))
assert set(audio['entries']) == {e['id'] for e in data['entries']}
for e in data['entries']:
    for accent in ['uk', 'us']:
        parts = audio['entries'][e['id']][accent]
        assert set(parts) == {'word', 'ex1', 'ex2'}
        for clip in parts.values():
            target = (DIST / clip['src']).resolve()
            assert target.is_relative_to(DIST.resolve()) and target.is_file()
paths = sorted(p for p in DIST.rglob('*') if p.is_file())
with zipfile.ZipFile(ARCHIVE, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as package:
    for p in paths:
        package.write(p, p.relative_to(DIST).as_posix())
with zipfile.ZipFile(ARCHIVE) as package:
    assert package.testzip() is None
    assert 'index.html' in package.namelist()
    assert 'edge-functions/api/[[route]].js' in package.namelist()
    assert 'cloud-functions/internal/verify-password.js' in package.namelist()
    assert not any('.private' in n or n.endswith('.env') for n in package.namelist())
    assert len(package.namelist()) == len(paths)
    assert sum(n.endswith('.mp3') for n in package.namelist()) == 3150
    for p in paths:
        assert hashlib.sha256(package.read(p.relative_to(DIST).as_posix())).digest() == hashlib.sha256(p.read_bytes()).digest()
report = {'files': len(paths), 'audioFiles': 3150, 'uncompressedBytes': sum(p.stat().st_size for p in paths),
          'zipBytes': ARCHIVE.stat().st_size, 'sha256': hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
          'entry': 'index.html', 'archive': str(ARCHIVE), 'integrity': 'passed: ZIP CRC and every file SHA-256'}
(SITE / 'source/static-package-checks.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
