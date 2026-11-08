"""Package EdgeOne frontend, Edge and Node Functions without local secrets."""
import hashlib
import json
import zipfile
import subprocess
import argparse
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
DIST = SITE / 'dist'
parser = argparse.ArgumentParser()
parser.add_argument('--output',type=Path,default=SITE.parent / 'learning-station-edgeone.zip')
ARCHIVE = parser.parse_args().output
ARCHIVE.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['node', str(SITE / 'scripts/build.mjs')], cwd=SITE, check=True)
assert (DIST / 'edge-functions/api/[[route]].js').is_file()
assert (DIST / 'cloud-functions/internal/verify-password.js').is_file()
assert (DIST / 'cloud-functions/auth/login.js').is_file()
assert (DIST / 'cloud-functions/auth/feedback-login.js').is_file()
audio_paths = set()
for data_file, audio_file in [('data.json', 'audio-manifest.json'), ('spring-data.json', 'spring-audio-manifest.json'),
                              ('grade5-autumn-data.json', 'grade5-autumn-audio-manifest.json'),
                              ('grade5-spring-data.json', 'grade5-spring-audio-manifest.json')]:
    data = json.loads((DIST / data_file).read_text(encoding='utf-8'))
    audio = json.loads((DIST / audio_file).read_text(encoding='utf-8'))
    expected = {e['id']: {'word', 'ex1', 'ex2'} for e in data['entries']}
    for story in data.get('stories', []):
        expected[story['id']] = {'passage'}
        expected.update({sentence['id']: {'sentence'} for sentence in story['sentences']})
    assert set(audio['entries']) == set(expected)
    for entry_id, expected_parts in expected.items():
        for accent in ['uk', 'us']:
            parts = audio['entries'][entry_id][accent]
            assert set(parts) == expected_parts
            for clip in parts.values():
                target = (DIST / clip['src']).resolve()
                assert target.is_relative_to(DIST.resolve()) and target.is_file()
                audio_paths.add(clip['src'])
paths = sorted(p for p in DIST.rglob('*') if p.is_file())
with zipfile.ZipFile(ARCHIVE, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as package:
    for p in paths:
        package.write(p, p.relative_to(DIST).as_posix())
with zipfile.ZipFile(ARCHIVE) as package:
    assert package.testzip() is None
    assert 'index.html' in package.namelist()
    assert 'edge-functions/api/[[route]].js' in package.namelist()
    assert 'cloud-functions/internal/verify-password.js' in package.namelist()
    assert 'cloud-functions/auth/login.js' in package.namelist()
    assert 'cloud-functions/auth/feedback-login.js' in package.namelist()
    assert not any('.private' in n or n.endswith('.env') for n in package.namelist())
    assert len(package.namelist()) == len(paths)
    assert {n for n in package.namelist() if n.endswith('.mp3')} == audio_paths
    for p in paths:
        assert hashlib.sha256(package.read(p.relative_to(DIST).as_posix())).digest() == hashlib.sha256(p.read_bytes()).digest()
report = {'files': len(paths), 'audioFiles': len(audio_paths), 'uncompressedBytes': sum(p.stat().st_size for p in paths),
          'zipBytes': ARCHIVE.stat().st_size, 'sha256': hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
          'entry': 'index.html', 'archive': str(ARCHIVE), 'integrity': 'passed: ZIP CRC and every file SHA-256'}
(SITE / 'source/static-package-checks.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
