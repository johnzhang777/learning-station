"""Apply a private password verifier; never accepts or writes a plaintext password."""
import argparse,hashlib,hmac,json,subprocess,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--origin',required=True);args=parser.parse_args()
assert args.origin.startswith('https://') and args.origin.rstrip('/')==args.origin
env=json.loads((root/'.private/account.json').read_text(encoding='utf-8-sig'))
source=json.loads((root/'.private/feedback-password-verifier.json').read_text(encoding='utf-8-sig'))
credential={k:source[k] for k in ['salt','hash','iterations','version']};credential['updatedAt']=int(time.time()*1000)
body=json.dumps(credential,separators=(',',':'))
signature=hmac.new(bytes.fromhex(env['SESSION_SECRET']),('learning-station:feedback-password-config:v1\n'+body).encode(),hashlib.sha256).hexdigest()
proxy=subprocess.run(['git','config','--get','http.proxy'],cwd=root,capture_output=True,text=True).stdout.strip()
client=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy} if proxy else {}))
request=urllib.request.Request(args.origin+'/api/feedback/admin-password',data=body.encode(),headers={'Origin':args.origin,'Content-Type':'application/json','X-Feedback-Config-Signature':signature},method='POST')
with client.open(request,timeout=25) as response:
    result=json.load(response);assert result.get('ok') and result.get('version')==credential['version']
print('Developer password verifier configured; no plaintext password was transmitted or printed.')
