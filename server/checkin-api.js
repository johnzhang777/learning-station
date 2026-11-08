const CK_ID=/^[a-f0-9]{32}$/;
const ckToday=now=>new Date(now+8*3600000).toISOString().slice(0,10);
function ckDate(value){
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
async function ckGet(kv,key,ctx){const raw=await ctx.cloudOperation('CHECKIN_READ',()=>kv.get(key));return raw?ctx.cloudOperation('CHECKIN_PARSE',()=>JSON.parse(raw)):null;}
export async function handleCheckins(request,env,kv,ctx){
  const today=ckToday(ctx.now),url=new URL(request.url);
  const prefix='checkin_'+(await ctx.digest(ctx.user.sub)).slice(0,32)+'_';
  if(request.method==='GET'){
    const month=url.searchParams.get('month')||today.slice(0,7);
    if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>today.slice(0,7))ctx.fail('请选择已经到来的月份。',400);
    const records=new Map();let cursor;
    do{
      const page=await ctx.cloudOperation('CHECKIN_LIST',async()=>{
        const result=await kv.list({prefix:prefix+month.replace('-',''),limit:256,...(cursor?{cursor}:{})});
        const keys=result?.keys??[];
        if(!result||!Array.isArray(keys)||typeof result.complete!=='boolean'||(!result.complete&&(typeof result.cursor!=='string'||!result.cursor||result.cursor===cursor)))throw TypeError('Invalid check-in pagination');
        return {...result,keys};
      });
      for(let i=0;i<page.keys.length;i+=8){
        const values=await Promise.all(page.keys.slice(i,i+8).map(x=>ckGet(kv,x.key,ctx)));
        for(const record of values){
          if(!record||record.owner!==ctx.user.sub||!ckDate(record.date)||record.date.slice(0,7)!==month||!['normal','makeup'].includes(record.kind)||!Number.isSafeInteger(record.createdAt))continue;
          const old=records.get(record.date);
          if(!old||record.createdAt<old.createdAt||(record.createdAt===old.createdAt&&record.id<old.id))records.set(record.date,record);
        }
      }
      if(page.complete)break;cursor=page.cursor;
    }while(true);
    return ctx.json({today,month,records:[...records.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(({id,date,kind,createdAt})=>({id,date,kind,createdAt})),consistencyDelaySeconds:60});
  }
  if(request.method==='POST'){
    const input=await ctx.body(request,1024);
    if(!input||!CK_ID.test(input.id||'')||!ckDate(input.date)||input.date>today)ctx.fail('签到日期无效，不能签到未来日期。',400);
    const key=prefix+input.date.replaceAll('-','')+'_'+input.id;
    let record=await ckGet(kv,key,ctx);
    if(!record){record={id:input.id,date:input.date,kind:input.date===today?'normal':'makeup',createdAt:ctx.now,owner:ctx.user.sub};await ctx.cloudOperation('CHECKIN_WRITE',()=>kv.put(key,JSON.stringify(record)));}
    return ctx.json({ok:true,today,record:{id:record.id,date:record.date,kind:record.kind,createdAt:record.createdAt}});
  }
  return ctx.json({error:'签到接口不存在。'},405);
}
