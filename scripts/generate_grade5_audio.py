"""Build one Grade 5 term, reusing speech already saved for earlier courses."""
import argparse,asyncio,hashlib,json,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.private/audio-deps'))
import edge_tts,imageio_ffmpeg
from mutagen.mp3 import MP3
from generate_audio import align,CONTEXT
VOICES={'uk':'en-GB-SoniaNeural','us':'en-US-AriaNeural'}
CONTEXT={**CONTEXT,'present':('a birthday present.','present'),'subject':('My favourite subject.','subject'),'house':('a small house.','house'),'project':('a school project.','project'),'desert':('a hot desert.','desert'),'refuse':('I refuse to go.','refuse'),'direct':('Please direct the traffic.','direct'),'Ms':('Ms Green is here.','Ms'),'Mrs':('Mrs Green is here.','Mrs')}
CLIPS=ROOT/'dist/audio/clips';CLIPS.mkdir(parents=True,exist_ok=True)
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()
def duration(p):return round(MP3(p).info.length,3)
def usable(p):
    try:return p.stat().st_size>1000 and duration(p)>.12
    except Exception:return False
def saved_clip(p):return {'src':p.relative_to(ROOT/'dist').as_posix(),'start':0,'end':duration(p)}
def split_batch(audio,clips,parts,accent):
    filters=[];cmd=[FFMPEG,'-hide_banner','-loglevel','error','-xerror','-y','-i',str(audio)]
    for i,c in enumerate(clips):filters.append(f'[0:a]atrim=start={c["start"]}:end={c["end"]},asetpts=PTS-STARTPTS[a{i}]')
    cmd+=['-filter_complex',';'.join(filters)]
    paths=[]
    for i,p in enumerate(parts):
        target=CLIPS/f'{p["id"]}-{accent}-{p["part"]}.mp3';paths.append(target)
        cmd+=['-map',f'[a{i}]','-ac','1','-ar','24000','-b:a','48k','-threads','1',str(target)]
    result=subprocess.run(cmd,capture_output=True,timeout=90)
    if result.returncode:raise RuntimeError('Audio split failed')
    assert all(usable(p) for p in paths)
    return paths
async def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--jobs',type=int,default=4)
    ap.add_argument('--term',choices=['autumn','spring'],required=True)
    ap.add_argument('--grade',type=int,choices=[5,6],default=5)
    args=ap.parse_args()
    work=ROOT/f'source/grade{args.grade}-audio-work'
    work.mkdir(parents=True,exist_ok=True)
    basename=f'grade{args.grade}-{args.term}'
    data_file=ROOT/f'dist/{basename}-data.json'
    data=json.loads(data_file.read_text(encoding='utf-8'))
    manifest_file=ROOT/f'dist/{basename}-audio-manifest.json'
    previous=json.loads(manifest_file.read_text('utf-8')) if manifest_file.exists() else {}
    previous_hashes=previous.get('sourceHashes',{})
    source_hashes={}
    context_hashes={}
    lookup={}
    earlier_prefixes=['','spring-','grade5-autumn-']
    if args.grade==6:
        earlier_prefixes.append('grade5-spring-')
        if args.term=='spring':earlier_prefixes.append('grade6-autumn-')
    for prefix in earlier_prefixes:
        filename=prefix+'data.json'
        old_manifest=ROOT/f'dist/{prefix}audio-manifest.json'
        if filename==data_file.name or not old_manifest.exists():continue
        old=json.loads((ROOT/'dist'/filename).read_text(encoding='utf-8'))
        oldmap=json.loads(old_manifest.read_text(encoding='utf-8'))
        for e in old['entries']:
            for a in VOICES:
                if not e.get('wordAudioContext'):
                    lookup[(a,'word',e['word'])]=oldmap['entries'][e['id']][a]['word']
                for i,ex in enumerate(e['examples'],1):lookup[(a,'example',ex['en'])]=oldmap['entries'][e['id']][a][f'ex{i}']
    manifest={'source':'Microsoft 在线语音合成，预先生成并保存','voices':VOICES,'format':'individual-mp3','version':3,'entries':{}}
    jobs=[];reuse=0
    for accent in VOICES:
        missing=[]
        for e in data['entries']:
            for part,text in [('word',e['word'])]+[(f'ex{i}',x['en']) for i,x in enumerate(e['examples'],1)]:
                content_key=e['id']+'/'+part;source_hashes[content_key]=hashlib.sha256(text.encode()).hexdigest()
                dest=manifest['entries'].setdefault(e['id'],{}).setdefault(accent,{})
                context=e.get('wordAudioContext') if part=='word' else None
                if context:context_hashes[content_key]=hashlib.sha256(context.encode()).hexdigest()
                reused=None if context else lookup.get((accent,'word' if part=='word' else 'example',text))
                if reused and usable(ROOT/'dist'/reused['src']):dest[part]=reused;reuse+=1;continue
                path=CLIPS/f'{e["id"]}-{accent}-{part}.mp3'
                context_matches=previous.get('wordContextHashes',{}).get(content_key)==context_hashes.get(content_key)
                if usable(path) and context_matches and previous_hashes.get(content_key)==source_hashes[content_key]:dest[part]=saved_clip(path);continue
                spoken,focus=CONTEXT.get(text,(text+'.',text)) if part=='word' else (text,text)
                if context:spoken=context
                missing.append({'id':e['id'],'part':part,'spoken':spoken,'focus':focus})
        for i in range(0,len(missing),15):jobs.append({'accent':accent,'parts':missing[i:i+15]})
        for s in data['stories']:
            parts=[{'id':x['id'],'part':'sentence','spoken':x['text'],'focus':x['text']} for x in s['sentences']]
            source_hashes[s['id']+'/passage']=hashlib.sha256(' '.join(s['paragraphs']).encode()).hexdigest()
            for p in parts:source_hashes[p['id']+'/sentence']=hashlib.sha256(p['spoken'].encode()).hexdigest()
            passage=CLIPS/f'{s["id"]}-{accent}-passage.mp3'
            if usable(passage) and previous_hashes.get(s['id']+'/passage')==source_hashes[s['id']+'/passage'] and all(usable(CLIPS/f'{p["id"]}-{accent}-sentence.mp3') and previous_hashes.get(p['id']+'/sentence')==source_hashes[p['id']+'/sentence'] for p in parts):
                manifest['entries'].setdefault(s['id'],{}).setdefault(accent,{})['passage']=saved_clip(passage)
                for p in parts:manifest['entries'].setdefault(p['id'],{}).setdefault(accent,{})['sentence']=saved_clip(CLIPS/f'{p["id"]}-{accent}-sentence.mp3')
            else:jobs.append({'accent':accent,'parts':parts,'story':s['id']})
    stats={'reusedClips':reuse,'jobs':len(jobs),'done':0,'failed':[]};sem=asyncio.Semaphore(args.jobs)
    async def run(job):
        accent=job['accent'];parts=job['parts'];voice=VOICES[accent];spoken='\n'.join(p['spoken'] for p in parts)
        signature=hashlib.sha256((voice+'\n-5%\n'+spoken).encode()).hexdigest();audio=work/(signature+'.mp3');meta=work/(signature+'.json')
        async with sem:
            try:
                cached=json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
                if not usable(audio) or cached.get('signature')!=signature:
                    for attempt in range(4):
                        try:
                            buf=bytearray();bounds=[]
                            async for message in edge_tts.Communicate(spoken,voice,rate='-5%',boundary='WordBoundary').stream():
                                if message['type']=='audio':buf.extend(message['data'])
                                elif message['type']=='WordBoundary':bounds.append(message)
                            clips=align(parts,bounds);assert len(buf)>1000 and len(clips)==len(parts)
                            audio.write_bytes(buf);cached={'signature':signature,'clips':clips,'voice':voice};meta.write_text(json.dumps(cached),encoding='utf-8');break
                        except Exception:
                            if attempt==3:raise
                            await asyncio.sleep(2+attempt*2)
                paths=await asyncio.to_thread(split_batch,audio,cached['clips'],parts,accent)
                for p,path in zip(parts,paths):manifest['entries'].setdefault(p['id'],{}).setdefault(accent,{})[p['part']]=saved_clip(path)
                if job.get('story'):
                    passage=CLIPS/f'{job["story"]}-{accent}-passage.mp3';shutil.copyfile(audio,passage)
                    manifest['entries'].setdefault(job['story'],{}).setdefault(accent,{})['passage']=saved_clip(passage)
                stats['done']+=1
                if stats['done']%5==0:print(f'Grade {args.grade} {args.term} {stats["done"]}/{len(jobs)} batches; reused {reuse} clips',flush=True)
            except Exception as error:
                stats['failed'].append({'accent':accent,'first':parts[0]['id'],'kind':type(error).__name__});print('Audio batch failed: '+type(error).__name__,flush=True)
    print(json.dumps({'pendingBatches':len(jobs),'reusedClips':reuse}),flush=True)
    await asyncio.gather(*(run(job) for job in jobs))
    checks_file=ROOT/f'source/grade{args.grade}/{args.term}-audio-checks.json'
    checks_file.write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8')
    if stats['failed']:raise SystemExit('Some audio batches need retry; the public manifest was not replaced.')
    for e in data['entries']:
        for accent in VOICES:assert set(manifest['entries'][e['id']][accent])=={'word','ex1','ex2'}
    expected={e['id'] for e in data['entries']}|{s['id'] for s in data['stories']}|{x['id'] for s in data['stories'] for x in s['sentences']}
    assert set(manifest['entries'])==expected
    allpaths={ROOT/'dist'/c['src'] for accs in manifest['entries'].values() for parts in accs.values() for c in parts.values()}
    assert all(usable(p) for p in allpaths)
    manifest['sourceHashes']=source_hashes
    if context_hashes:manifest['wordContextHashes']=context_hashes
    manifest['sourceDataSha256']=hashlib.sha256(data_file.read_bytes()).hexdigest()
    manifest_file.write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    stats.update(logicalWords=len(data['entries']),stories=len(data['stories']),sentences=sum(len(s['sentences']) for s in data['stories']),mappedEntries=len(expected),logicalClips=sum(len(parts) for accents in manifest['entries'].values() for parts in accents.values()),uniqueAudioFiles=len(allpaths))
    checks_file.write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(stats),flush=True)
if __name__=='__main__':asyncio.run(main())
