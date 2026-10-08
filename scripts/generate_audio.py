"""Pre-render both accents. WordBoundary metadata gives independently playable clips.

The public site plays saved MP3 assets; it never calls a synthesis API.
Context is used for ambiguous isolated words, with only the target word played.
"""
import asyncio
import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

SITE=Path(__file__).resolve().parents[1]
WORKSPACE=SITE.parents[1]
sys.path.insert(0,str(WORKSPACE/'tmp/audio_deps'))
import edge_tts

VOICES={'uk':'en-GB-SoniaNeural','us':'en-US-AriaNeural'}
CONTEXT={
    'record':('a record.','record'),
    'close':('Close the door.','close'),
    'live':('I live here.','live'),
    'wind':('The wind is strong.','wind'),
    'read':('I read every day.','read'),
    'use':('We use it every day.','use'),
    'minute':('Wait one minute.','minute'),
    'can':('a metal can.','can'),
}
def normalize(s):return re.sub(r'[^a-z0-9]','',s.lower())

def segments(entries):
    out=[]
    for e in entries:
        spoken,focus=CONTEXT.get(e['word'],(e['word']+'.',e['word']))
        out.append({'id':e['id'],'part':'word','spoken':spoken,'focus':focus})
        for n,ex in enumerate(e['examples']):
            out.append({'id':e['id'],'part':f'ex{n+1}','spoken':ex['en'],'focus':ex['en']})
    return out

def align(parts,boundaries):
    expected=normalize(' '.join(p['spoken'] for p in parts))
    actual=''.join(normalize(b['text']) for b in boundaries)
    if actual!=expected:
        raise ValueError(f'Boundary text does not match source: {actual[:100]} / {expected[:100]}')
    annotated=[];char=0
    for b in boundaries:
        s=normalize(b['text'])
        if not s:continue
        annotated.append((char,char+len(s),b));char+=len(s)
    cursor=0; result=[]
    for p in parts:
        source=normalize(p['spoken']); target=normalize(p['focus'])
        # Context phrases have a unique focus word; ordinary segments use all text.
        local=source.index(target); a=cursor+local; z=a+len(target)
        selected=[x for x in annotated if x[0]<z and x[1]>a]
        assert selected and selected[0][0]==a and selected[-1][1]==z,(p,selected)
        first,last=selected[0][2],selected[-1][2]
        start=max(0,first['offset']/1e7-.055)
        end=(last['offset']+last['duration'])/1e7+.13
        next_words=[x for x in annotated if x[0]>=z]
        if next_words:end=min(end,next_words[0][2]['offset']/1e7-.035)
        assert end>start,(p,start,end)
        result.append({'entry':p['id'],'part':p['part'],'start':round(start,3),'end':round(end,3)})
        cursor+=len(source)
    return result

async def main():
    ap=argparse.ArgumentParser();ap.add_argument('--sample',action='store_true');ap.add_argument('--jobs',type=int,default=4)
    args=ap.parse_args()
    data=json.loads((SITE/'dist/data.json').read_text(encoding='utf-8'))
    byid={e['id']:e for e in data['entries']}
    days=[d for d in data['days'] if d['kind']=='learn' and (not args.sample or d['id']==32)]
    batches=SITE/'source/audio-boundaries';batches.mkdir(parents=True,exist_ok=True)
    (SITE/'source/batch-audio').mkdir(exist_ok=True)
    sem=asyncio.Semaphore(args.jobs); stats={'done':0,'cached':0,'failed':[]}; total=len(days)*2
    async def render(d,accent,voice):
        key=f'day-{d["id"]:03d}-{accent}'
        parts=segments([byid[i] for i in d['entryIds']]);spoken='\n'.join(p['spoken'] for p in parts)
        signature=hashlib.sha256((voice+'\n-5%\n'+spoken).encode()).hexdigest()
        audio=SITE/f'source/batch-audio/{key}.mp3'; meta=batches/f'{key}.json'
        async with sem:
            try:
                cached=json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
                if audio.exists() and audio.stat().st_size>1024 and cached.get('signature')==signature:
                    stats['cached']+=1
                else:
                    for attempt in range(4):
                        try:
                            boundaries=[]; buf=bytearray()
                            async for msg in edge_tts.Communicate(spoken,voice,rate='-5%',boundary='WordBoundary').stream():
                                if msg['type']=='audio':buf.extend(msg['data'])
                                elif msg['type']=='WordBoundary':boundaries.append(msg)
                            clips=align(parts,boundaries)
                            assert len(buf)>1024 and len(clips)==15
                            audio.write_bytes(buf)
                            meta.write_text(json.dumps({'signature':signature,'voice':voice,'clips':clips,
                                                        'boundaries':boundaries},ensure_ascii=False),encoding='utf-8')
                            break
                        except Exception:
                            if attempt==3:raise
                            await asyncio.sleep(2+attempt*3)
                stats['done']+=1
                if stats['done']%10==0 or args.sample:print(f'Audio batches {stats["done"]}/{total}, cached {stats["cached"]}',flush=True)
            except Exception as err:
                stats['failed'].append({'batch':key,'error':str(err)});print(f'Failed {key}: {err}',flush=True)
    await asyncio.gather(*(render(d,a,v) for d in days for a,v in VOICES.items()))
    manifest={'source':'Microsoft 在线语音合成','voices':VOICES,'entries':{},'format':'timed-mp3-batches','version':1}
    for d in [d for d in data['days'] if d['kind']=='learn']:
        for accent in VOICES:
            key=f'day-{d["id"]:03d}-{accent}';meta=batches/f'{key}.json'
            if not meta.exists():continue
            details=json.loads(meta.read_text(encoding='utf-8'))
            for clip in details['clips']:
                entry=manifest['entries'].setdefault(clip['entry'],{})
                accent_data=entry.setdefault(accent,{})
                accent_data[clip['part']]={'src':f'audio/{key}.mp3','start':clip['start'],'end':clip['end']}
    (SITE/'dist/audio-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    report={**stats,'totalBatches':total,'mappedEntries':len(manifest['entries']),
            'bytes':sum(p.stat().st_size for p in (SITE/'source/batch-audio').glob('*.mp3')),
            'clips':sum(len(a) for e in manifest['entries'].values() for a in e.values())}
    (SITE/'source/audio-generation-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False),flush=True)
    if stats['failed']:raise SystemExit(1)
    if not args.sample:assert report['clips']==3150 and report['mappedEntries']==525

if __name__=='__main__':asyncio.run(main())
