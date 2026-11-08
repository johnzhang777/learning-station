"""Cache raw dictionary candidates for editorial review; never publish this cache directly.

The reviewed source/grade5/pronunciations.json is authoritative for builds.
Candidates still require sense, part-of-speech and independent accent checks.
"""
import concurrent.futures, json, re, threading, time
from pathlib import Path
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.private/grade5-dictionary.json'
ALIASES = {'project':'project_1','matter':'matter_1','star':'star_1','show':'show_2',
           'live':'live_1','direct':'direct_2','desert':'desert_1','smoke':'smoke_2',
           'flash':'flash_1','line':'line_1','left':'left_1','note':'note_1','round':'round_1',
           'free':'free_1','fine':'fine_1','close':'close_1','wind':'wind_1','plan':'plan_1',
           'train':'train_1','ice':'ice_1','brush':'brush_2','rest':'rest_1','front':'front_1',
           'young':'young_1','both':'both','little':'little_1','common':'common_1',
           'inside':'inside_1','foot':'foot_1','ride':'ride_1','trip':'trip_1','wish':'wish_1',
           'holiday':'holiday_1','early':'early_1','earth':'earth_1','right':'right_1'}
MANUAL = {'go hiking','take care of','Labour Day','Dragon Boat Festival','CPC Founding Day',
          'PLA Day','National Day','feel like','Beijing opera','Mount Taishan','on foot'}
lock = threading.Lock()
cache = json.loads(CACHE.read_text('utf-8')) if CACHE.exists() else {}
old = Path(r'D:\Codex\2026-11-07\grade4-english-spring2027\work\dictionary_cache.json')
if old.exists():
    for w, e in json.loads(old.read_text('utf-8')).items():
        if e.get('uk') and e.get('us') and w not in ALIASES: cache.setdefault(w, e)

def fetch(word):
    if cache.get(word, {}).get('uk') and cache[word].get('us'): return
    if word in MANUAL: return
    result = {'word':word, 'attempts':[]}
    slug = ALIASES.get(word, word.lower().replace(' ', '-'))
    urls = [('Oxford', 'https://www.oxfordlearnersdictionaries.com/definition/english/'+slug),
            ('Cambridge', 'https://dictionary.cambridge.org/dictionary/english/'+word.lower().replace(' ', '-'))]
    for provider, url in urls:
        try:
            r = requests.get(url, headers={'User-Agent':'Mozilla/5.0'}, timeout=12)
            result['attempts'].append([provider,r.status_code])
            s = BeautifulSoup(r.content, 'html.parser')
            if provider=='Oxford':
                head=s.select_one('.top-container') or s
                uk=head.select_one('.phons_br .phon'); us=head.select_one('.phons_n_am .phon')
                hw=head.select_one('.headword'); pos=head.select_one('.pos')
            else:
                head=s.select_one('.pos-header') or s
                uk=head.select_one('.uk .ipa'); us=head.select_one('.us .ipa')
                hw=head.select_one('.hw'); pos=head.select_one('.pos')
            if uk and us:
                result.update(uk='/'+uk.get_text('',strip=True).strip('/')+'/',
                              us='/'+us.get_text('',strip=True).strip('/')+'/',
                              reference=r.url,provider=provider,
                              headword=hw.get_text(' ',strip=True) if hw else '',
                              pos=pos.get_text(' ',strip=True) if pos else '')
                break
        except requests.RequestException as e: result['attempts'].append([provider,type(e).__name__])
    with lock:
        cache[word]=result
        CACHE.write_text(json.dumps(cache,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    words=[l.split('|')[3] for l in (ROOT/'source/grade5/textbook.tsv').read_text('utf-8').splitlines() if l and not l.startswith('#')]
    ext=ROOT/'source/grade5/extensions.tsv'
    if ext.exists(): words += [l.split('|')[2] for l in ext.read_text('utf-8').splitlines() if l and not l.startswith('#')]
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        for i,_ in enumerate(pool.map(fetch,dict.fromkeys(words)),1):
            if i%40==0: print('Dictionary checked',i,flush=True)
    CACHE.write_text(json.dumps(cache,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Missing:',[w for w in words if w not in MANUAL and not(cache.get(w,{}).get('uk') and cache.get(w,{}).get('us'))],flush=True)
