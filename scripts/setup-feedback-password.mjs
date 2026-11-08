import {pbkdf2,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Buffer} from 'node:buffer';
export async function createFeedbackVerifier(password){
  if(typeof password!=='string'||password.length<10||password.length>128)throw Error('Password must contain 10–128 characters.');
  const salt=randomBytes(32).toString('hex');
  const hash=await new Promise((resolve,reject)=>pbkdf2(password,Buffer.from(salt,'hex'),600000,32,'sha256',(error,value)=>error?reject(error):resolve(value)));
  const result={salt,hash:hash.toString('hex'),iterations:600000,version:randomUUID().replaceAll('-','')};hash.fill(0);return result;
}
if(typeof process!=='undefined'&&process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log('Enter the new developer password on hidden stdin:');
  if(process.stdin.isTTY)process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');let input='';
  try{
    for await(const chunk of process.stdin){input+=chunk;if(/[\r\n]/.test(input))break;if(input.length>128)throw Error();}
    const verifier=await createFeedbackVerifier(input.replace(/[\r\n].*$/s,''));input='';
    await mkdir(new URL('../.private/',import.meta.url),{recursive:true});
    await writeFile(new URL('../.private/feedback-password-verifier.json',import.meta.url),JSON.stringify(verifier)+'\n',{mode:0o600});
    console.log('Saved salted verifier only; no plaintext password was saved.');
  }catch{console.error('Password setup failed. Check the password length.');process.exitCode=1;}
  finally{input='';if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.destroy();}
}
