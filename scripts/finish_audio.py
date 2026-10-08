"""Decode every batch and save each logical segment as its own playable MP3."""
import concurrent.futures
import json
import shutil
import subprocess
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SITE.parents[1] / 'tmp/audio_deps'))
import imageio_ffmpeg

exe = imageio_ffmpeg.get_ffmpeg_exe()
manifest_path = SITE / 'dist/audio-manifest.json'
backup = SITE / 'source/audio-batch-manifest.json'
original = json.loads(manifest_path.read_text(encoding='utf-8'))
if original['format'] == 'timed-mp3-batches':
    backup.write_text(json.dumps(original, ensure_ascii=False), encoding='utf-8')
else:
    original = json.loads(backup.read_text(encoding='utf-8'))

outdir = SITE / 'dist/audio/clips'
outdir.mkdir(parents=True, exist_ok=True)
batches = {}
for entry, accents in original['entries'].items():
    for accent, parts in accents.items():
        for part, clip in parts.items():
            batches.setdefault(clip['src'], []).append((entry, accent, part, clip))
assert len(batches) == 210

def split(item):
    src, parts = item
    input_path = SITE / 'dist' / src
    if not input_path.exists():
        input_path = SITE / 'source/batch-audio' / Path(src).name
    assert input_path.is_file()
    filters = []
    cmd = [exe, '-hide_banner', '-loglevel', 'error', '-xerror', '-y', '-i', str(input_path)]
    for i, (entry, accent, part, clip) in enumerate(parts):
        filters.append(f"[0:a]atrim=start={clip['start']}:end={clip['end']},asetpts=PTS-STARTPTS[a{i}]")
    cmd += ['-filter_complex', ';'.join(filters)]
    for i, (entry, accent, part, clip) in enumerate(parts):
        path = outdir / f'{entry}-{accent}-{part}.mp3'
        cmd += ['-map', f'[a{i}]', '-ac', '1', '-ar', '24000', '-b:a', '48k', '-threads', '1', str(path)]
    result = subprocess.run(cmd, capture_output=True, timeout=90)
    assert result.returncode == 0, (src, result.stderr.decode('utf-8', errors='replace'))
    for entry, accent, part, clip in parts:
        path = outdir / f'{entry}-{accent}-{part}.mp3'
        assert path.stat().st_size > 1000, path
    return src

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for n, src in enumerate(pool.map(split, batches.items()), 1):
        if n % 30 == 0:
            print(f'Decoded and split {n}/210 batches', flush=True)

manifest = {k: v for k, v in original.items() if k != 'entries'}
manifest.update(format='individual-mp3', version=2, entries={})
for entry, accents in original['entries'].items():
    manifest['entries'][entry] = {}
    for accent, parts in accents.items():
        manifest['entries'][entry][accent] = {}
        for part, clip in parts.items():
            path = outdir / f'{entry}-{accent}-{part}.mp3'
            # The MP3 ends naturally. Allow encoder padding before the ended event.
            manifest['entries'][entry][accent][part] = {
                'src': f'audio/clips/{path.name}', 'start': 0,
                'end': round(clip['end'] - clip['start'] + .12, 3)
            }
assert len(list(outdir.glob('*.mp3'))) == 3150
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
saved = SITE / 'source/batch-audio'
saved.mkdir(exist_ok=True)
for src in batches:
    old = SITE / 'dist' / src
    target = saved / Path(src).name
    if old.exists():
        # Both resolved paths are confined to this project; keep original audio for maintenance.
        assert old.resolve().is_relative_to(SITE.resolve())
        assert target.resolve().is_relative_to(SITE.resolve())
        shutil.move(str(old), str(target))
report = {'decodedBatches': 210, 'individualFiles': 3150, 'entries': 525,
          'accents': ['uk', 'us'], 'bytes': sum(p.stat().st_size for p in outdir.glob('*.mp3'))}
(SITE / 'source/audio-file-checks.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
