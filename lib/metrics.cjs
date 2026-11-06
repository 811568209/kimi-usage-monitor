'use strict';
const crypto = require('node:crypto');
const id = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => finite(value) && Number.isSafeInteger(value);
const MODEL_NAMES = {
  'k3d1-agent': 'K3.1 Pro', 'k3d1-agent-highspeed': 'K3.1 Pro Highspeed',
  'k3.1-pro': 'K3.1 Pro', 'k3.1-pro-highspeed': 'K3.1 Pro Highspeed',
  'k3-agent': 'K3', 'k3': 'K3', 'k3-256k': 'K3 (256K)',
  'k2d8-preview': 'K2.8 Preview', 'k2.8-preview': 'K2.8 Preview'
};
function modelName(raw, catalog = {}) {
  const short = raw.split('/').at(-1);
  return catalog[raw] || catalog[short] || MODEL_NAMES[short] || raw;
}
function parseUsage(record, meta, request = {}, catalog = {}) {
  if (record?.type !== 'usage.record') return null;
  const u = record.usage;
  if (!u || !integer(u.inputOther) || !integer(u.output) || !finite(record.time)) return null;
  if (u.inputCacheRead !== undefined && !integer(u.inputCacheRead)) return null;
  if (u.inputCacheCreation !== undefined && !integer(u.inputCacheCreation)) return null;
  const cache = u.inputCacheRead ?? null, creation = u.inputCacheCreation ?? null;
  const input = cache === null || creation === null ? null : u.inputOther + cache + creation;
  const rawModel = typeof record.model === 'string' ? record.model : 'unknown';
  const session = meta.session;
  const safe = {
    source: meta.source, session: id(session), agent: String(record.agentId || meta.agent || 'main'),
    time: record.time, requestedAt: finite(request.time) ? request.time : null,
    requestId:request.id||null,turnId:request.turnId||null,associationBasis:request.id?'same-agent-canonical-wire-order':null,
    rawModel, model: modelName(rawModel, catalog), thinking: request.thinkingEffort || 'unknown',
    scope: typeof record.usageScope === 'string' ? record.usageScope : 'unknown',
    auxiliary: /^ctitle-/.test(session) ? 'title' : 'none',
    inputOther: u.inputOther, cacheRead: cache, cacheWrite: creation,
    input, output: u.output, total: input === null ? null : input + u.output,
    contextBand: input === null ? 'unknown' : input > 256000 ? '>256K' : '<=256K'
  };
  safe.origin = id(JSON.stringify([meta.source, session, meta.agentPath]));
  safe.recordLine = meta.line;
  safe.id = id(JSON.stringify([safe.origin,meta.line,record.time,rawModel,record.agentId,record.usageScope,u]));
  return safe;
}
function parseMonthlyLog(line, utcOffset = '+08:00') {
  const match = line.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\].*\[SubscriptionManager\].*refreshed\(sub\):.*level=(\d+).*omniRatio=(\S+).*resetAt=(\S+)/);
  if (!match) return null;
  const time = Date.parse(match[1].replace(' ', 'T') + utcOffset), used = Number(match[3]);
  const reset = Date.parse(match[4]);
  if (!finite(time) || !finite(used) || used > 1 || !finite(reset)) return null;
  const result = {source: 'work-log', time, kind: 'month', used, resetAt: new Date(reset).toISOString(), plan: match[2], quantum: 0.0001};
  result.id = id(JSON.stringify(result));
  return result;
}
function aggregate(events) {
  const groups = new Map();
  for (const e of events) {
    const key = `${e.source}|${e.model}|${e.thinking}`;
    if (!groups.has(key)) groups.set(key, {source:e.source,model:e.model,thinking:e.thinking,calls:0,inputOther:0,cacheRead:0,cacheWrite:0,output:0,total:0,knownTotal:0,unknown:0,unknownCacheRead:0,unknownCacheWrite:0,auxiliaryCalls:0,first:e.time,last:e.time});
    const g = groups.get(key); g.calls++; g.inputOther += e.inputOther; g.output += e.output;
    g.cacheRead += e.cacheRead ?? 0; g.cacheWrite += e.cacheWrite ?? 0;
    g.knownTotal += e.inputOther + (e.cacheRead ?? 0) + (e.cacheWrite ?? 0) + e.output;
    if (e.total === null) g.unknown++;
    if (e.cacheRead == null) g.unknownCacheRead++;
    if (e.cacheWrite == null) g.unknownCacheWrite++;
    g.total = g.unknown ? null : g.knownTotal;
    g.auxiliaryCalls += e.auxiliary !== 'none' ? 1 : 0;
    g.first = Math.min(g.first,e.time); g.last = Math.max(g.last,e.time);
  }
  return [...groups.values()].sort((a,b)=>a.source.localeCompare(b.source)||b.knownTotal-a.knownTotal);
}
function totals(events) {
  const t=events.reduce((a,e)=>{a.calls++;a.inputOther+=e.inputOther;a.cacheRead+=e.cacheRead??0;a.cacheWrite+=e.cacheWrite??0;a.output+=e.output;a.unknown+=e.total===null?1:0;return a;}, {calls:0,inputOther:0,cacheRead:0,cacheWrite:0,output:0,unknown:0});
  t.knownTotal=t.inputOther+t.cacheRead+t.cacheWrite+t.output;t.total=t.unknown?null:t.knownTotal;return t;
}
function monthlyPoints(snapshots) {
  const prior=new Map();
  return snapshots.filter(s=>s.kind==='month').sort((a,b)=>a.time-b.time).map(s=>{
    const stream=s.source+'|'+(s.account||'unknown'),last=prior.get(stream);
    const changed=!last||s.plan!==last.plan||s.resetAt!==last.resetAt||s.used<last.used-0.0002;
    const quotaSegment=changed?(s.quotaSegment||id(JSON.stringify([s.source,s.account,s.time,s.plan,s.resetAt,s.used]))):last.quotaSegment;
    const point={...s,quotaSegment};prior.set(stream,point);return point;
  });
}
function comparisonPeriod(snapshot) {
  return snapshot.quotaSegment||snapshot.resetAt||'unknown';
}
function intervalFlags(a,b,events) {
  const reasons=[];
  if(a.source!==b.source)reasons.push('读数来源切换，不直接归因为消费');
  if(a.account&&b.account&&a.account!==b.account)reasons.push('登录账号变化');
  if (a.resetAt !== b.resetAt || a.plan !== b.plan || a.used > b.used + 0.000002 || (a.quotaSegment&&b.quotaSegment&&a.quotaSegment!==b.quotaSegment)) reasons.push('额度周期、套餐或余额基准变化');
  if (a.used >= 0.999999 || b.used >= 0.999999) reasons.push('月额度触顶，扣减可能被截断');
  const sources = new Set(events.map(e=>e.source));
  if(sources.size>1)reasons.push('Code 与 Work 同时产生用量');
  if(!events.length)reasons.push('没有对应的本机调用，可能来自其他入口或延迟结算');
  if(events.some(e=>e.requestedAt !== null && e.requestedAt<a.time))reasons.push('存在跨越起点的调用');
  if(events.some(e=>e.total===null))reasons.push('部分调用缺少缓存用量');
  if(Math.abs(b.used-a.used) <= 0.000002)reasons.push('额度未变化，不能解释为免费');
  if(Math.abs(b.used-a.used) >= 0.25)reasons.push('额度跳变超过 25 个百分点，需核对账号、刷新或临时空值');
  return reasons;
}
function candidateIntervals(events,snapshots) {
  const points = monthlyPoints(snapshots).filter(s=>['work-log','kimi-membership-api'].includes(s.source));
  const output=[];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i];
    if(b.time<=a.time || Math.abs(b.used-a.used)<0.000002)continue;
    const rows=events.filter(e=>e.time>a.time&&e.time<=b.time);
    const t=totals(rows),eventType=b.used<a.used||a.resetAt!==b.resetAt||a.plan!==b.plan?'baseline-change':a.source!==b.source?'source-change':'usage-observation';
    output.push({start:a.time,end:b.time,startSource:a.source,endSource:b.source,eventType,deltaPercent:(b.used-a.used)*100,sources:[...new Set(rows.map(e=>e.source))],...t,total:rows.length?t.total:null,flags:[...intervalFlags(a,b,rows),'未经隔离确认，仅用于核对读数，不用于费率拟合']});
  }
  return output.slice(-80);
}
function latestMonthly(snapshots, now=Date.now(), maxAgeSeconds=300) {
  const limit=Number.isFinite(maxAgeSeconds)&&maxAgeSeconds>=30?maxAgeSeconds:300;
  const points=monthlyPoints(snapshots),api=points.filter(s=>s.source==='kimi-membership-api').at(-1);
  const point=api&&now-api.time<=limit*1000?api:points.at(-1);
  if(!point)return null;
  const ageSeconds=Math.max(0,(now-point.time)/1000),clockSkew=point.time-now>30000;
  return {...point,ageSeconds,maxAgeSeconds:limit,stale:ageSeconds>limit||clockSkew,staleReason:clockSkew?'clock-skew':ageSeconds>limit?'record-age':null,resetMetadataPast:Number.isFinite(Date.parse(point.resetAt))&&Date.parse(point.resetAt)<=point.time};
}
function stableBaseline(snapshots,now=Date.now(),maxAgeSeconds=300){
  const points=monthlyPoints(snapshots).filter(s=>['work-log','kimi-membership-api'].includes(s.source));
  const latest=latestMonthly(points,now,maxAgeSeconds);if(!latest||latest.stale)return null;
  const stream=points.filter(s=>s.source===latest.source&&s.account===latest.account&&s.time<=latest.time);
  for(let i=stream.length-2;i>=0;i--){const previous=stream[i];
    if(previous.resetAt!==latest.resetAt||previous.plan!==latest.plan||Math.abs(previous.used-latest.used)>0.000002)return null;
    if(latest.time-previous.time>=30000)return latest;
  }
  return null;
}
function settlement(sample, events, snapshots, now=Date.now()) {
  if(!sample.endedAt)return {status:'running',reason:'等待结束任务'};
  const rows=events.filter(e=>e.time>sample.startedAt&&e.time<=sample.endedAt);
  if(!rows.length)return now<sample.endedAt+60000?{status:'settling',reason:'等待调用记录写入，至少观察任务结束后 60 秒'}:{status:'invalid',reason:'样本期间没有完整的模型用量记录'};
  if(rows.some(e=>e.source!==sample.source))return {status:'invalid',reason:'检测到另一产品的用量，不能归因'};
  if(rows.some(e=>e.requestedAt!==null&&e.requestedAt<sample.startedAt))return {status:'invalid',reason:'任务在采样开始前已发出请求'};
  const settleAfter=Math.max(sample.endedAt,...rows.map(e=>e.time))+60000;
  const monthly=monthlyPoints([sample.baseline,...snapshots]);
  const baseline=monthly.find(s=>s.source===sample.baseline.source&&s.time===sample.baseline.time&&s.used===sample.baseline.used)||sample.baseline;
  const points=monthly.filter(s=>s.source===sample.baseline.source&&s.time>=settleAfter&&s.time<=now);
  for(let i=1;i<points.length;i++) {
    const b=points[i];let j=i-1,stable=false;
    while(j>=0&&points[j].account===b.account&&points[j].plan===b.plan&&points[j].resetAt===b.resetAt&&Math.abs(points[j].used-b.used)<=0.000002){if(b.time-points[j].time>=30000){stable=true;break;}j--;}
    if(!stable)continue;
    const history=monthly.filter(s=>s.source===baseline.source&&s.time>sample.startedAt&&s.time<=b.time);
    if(history.some(s=>s.account!==baseline.account))return {status:'invalid',reason:'采样期间登录账号发生变化'};
    if(history.some(s=>s.quotaSegment!==baseline.quotaSegment))return {status:'invalid',reason:'采样期间额度周期、套餐或余额基准变化'};
    if(events.some(e=>e.time>sample.endedAt&&e.time<=b.time))return {status:'invalid',reason:'结束后、结算确认前还有调用；请在所有任务停止后重新采样'};
    const flags=intervalFlags(baseline,b,rows).filter(f=>f!=='部分调用缺少缓存用量');
    if(flags.length)return {status:'invalid',reason:flags.join('；')};
    const delta=b.used-sample.baseline.used;
    if(delta<0.0005)return {status:'invalid',reason:'消耗小于 0.05 个百分点，额度显示精度不足以稳定估算'};
    const t=totals(rows), models=[...new Set(rows.map(e=>e.model))],bands=[...new Set(rows.map(e=>e.contextBand))];
    const reason=t.unknown?'月额度成本已结算；'+t.unknown+' 条调用缺少缓存计数，token 仅能给出已知下限，不用于 token 单价拟合':models.length>1?'已记录任务成本；含多个模型（可能包括标题生成），不用于单模型费率拟合':'隔离条件由用户确认；使用稳定月额度差值，仍可能受服务器延迟影响';
    return {status:'accepted',reason,endSnapshot:b,deltaPercent:delta*100,uncertaintyPercent:0.02,models,bands,thinkingEfforts:[...new Set(rows.map(e=>e.thinking||'unknown'))],...t,tokenComplete:!t.unknown,cacheShare:t.total?t.cacheRead/t.total:null,outputShare:t.total?t.output/t.total:null,percentPerMillion:t.total?delta*100/(t.total/1e6):null};
  }
  return {status:'settling',reason:now<settleAfter?'等待任务结束后至少 60 秒，系统将自动查询结算读数':'正在自动查询月额度，等待两次间隔至少 30 秒且一致的读数'};
}
function solve(A,b) {
  const m=A.map((r,i)=>[...r,b[i]]),n=b.length;let min=Infinity,max=0;
  for(let c=0;c<n;c++){
    let p=c;for(let r=c+1;r<n;r++)if(Math.abs(m[r][c])>Math.abs(m[p][c]))p=r;
    [m[c],m[p]]=[m[p],m[c]];const v=Math.abs(m[c][c]);if(v<1e-8)return null;
    min=Math.min(min,v);max=Math.max(max,v);const pivot=m[c][c];for(let j=c;j<=n;j++)m[c][j]/=pivot;
    for(let r=0;r<n;r++)if(r!==c){const f=m[r][c];for(let j=c;j<=n;j++)m[r][j]-=f*m[c][j];}
  }
  if(max/min>10000)return null;
  return m.map(r=>r[n]);
}
function fitRates(samples) {
  const groups=new Map();
  for(const sample of samples){const r=sample.result;
    if(r?.status!=='accepted'||r.unknown||r.tokenComplete===false||r.models.length!==1||r.bands.length!==1)continue;
    const thinking=r.thinkingEfforts||['unknown'];if(thinking.length!==1||thinking[0]==='unknown')continue;
    const key=[sample.source,r.models[0],comparisonPeriod(sample.baseline),sample.baseline.plan,r.bands[0],thinking[0]].join('|');
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(sample);
  }
  return [...groups].map(([key,rows])=>{
    const [source,model,cycle,plan,band,thinking]=key.split('|');
    const fields=['inputOther','cacheRead','output'];if(rows.some(s=>s.result.cacheWrite>0))fields.push('cacheWrite');
    const base={source,model,cycle,plan,band,thinking,samples:rows.length};
    if(rows.length<fields.length*3)return {...base,status:'insufficient',reason:`至少需要 ${fields.length*3} 个已结算且同模型、同周期的隔离样本`};
    const X=rows.map(s=>fields.map(k=>s.result[k]/1e6)),y=rows.map(s=>s.result.deltaPercent);
    const scales=fields.map((_,j)=>Math.sqrt(X.reduce((v,r)=>v+r[j]*r[j],0)));
    if(scales.some(s=>s===0))return {...base,status:'insufficient',reason:'样本缺少某类 token，无法拆出单价'};
    const Z=X.map(r=>r.map((v,j)=>v/scales[j]));
    const A=fields.map((_,i)=>fields.map((_,j)=>Z.reduce((v,r)=>v+r[i]*r[j],0)));
    const b=fields.map((_,i)=>Z.reduce((v,r,j)=>v+r[i]*y[j],0));
    const solution=solve(A,b);if(!solution)return {...base,status:'insufficient',reason:'缓存与输入比例过于相似，无法可靠区分系数'};
    const beta=solution.map((v,j)=>v/scales[j]);
    if(beta.some(v=>v<0))return {...base,status:'unstable',reason:'拟合出现负系数；样本不足、结算延迟或计费并非固定线性'};
    const error=Math.sqrt(X.reduce((v,r,i)=>v+(r.reduce((p,x,j)=>p+x*beta[j],0)-y[i])**2,0)/rows.length)/(y.reduce((a,b)=>a+b,0)/y.length);
    if(error>0.2)return {...base,status:'unstable',reason:'拟合误差超过 20%，不报告单价',relativeError:error};
    const observedTokens=Object.fromEntries(['inputOther','cacheRead','cacheWrite','output'].map(k=>[k,rows.reduce((sum,s)=>sum+s.result[k],0)]));
    return {...base,status:'estimated',coefficients:Object.fromEntries(fields.map((k,i)=>[k,beta[i]])),observedTokens,relativeError:error,unit:'月额度百分点 / 百万 token（经验估计，非官方费率）'};
  });
}
function compareRates(rates) {
  const comparisons=[];
  for(const work of rates.filter(r=>r.source==='work'&&r.status==='estimated')){
    const code=rates.find(r=>r.source==='code'&&r.status==='estimated'&&r.model===work.model&&r.cycle===work.cycle&&r.plan===work.plan&&r.band===work.band&&r.thinking===work.thinking);
    if(!code)continue;
    const fields=['inputOther','cacheRead','cacheWrite','output'];
    if(!work.observedTokens||!code.observedTokens)continue;
    const observed=Object.fromEntries(fields.map(k=>[k,work.observedTokens[k]+code.observedTokens[k]]));
    const total=Object.values(observed).reduce((a,b)=>a+b,0);if(!total)continue;
    const mix=Object.fromEntries(fields.map(k=>[k,observed[k]/total]));
    if(fields.some(k=>mix[k]>0&&(!Number.isFinite(work.coefficients[k])||!Number.isFinite(code.coefficients[k]))))continue;
    const score=r=>Object.entries(mix).reduce((sum,[k,w])=>sum+(r.coefficients[k]??0)*w,0);
    if(score(code)>0)comparisons.push({model:work.model,cycle:work.cycle,band:work.band,thinking:work.thinking,mix,mixSource:'两端已结算样本的实际 token 构成合并',workOverCode:score(work)/score(code),warning:'参考构成来自实测样本；不代表任务完成质量'});
  }
  return comparisons;
}
function compareTasks(samples){
  const groups=new Map();
  for(const s of samples){if(s.result?.status!=='accepted'||!s.label||s.label==='未命名任务')continue;
    const key=JSON.stringify([s.label,comparisonPeriod(s.baseline),s.baseline.plan]);if(!groups.has(key))groups.set(key,{});
    const g=groups.get(key);if(!g[s.source]||s.startedAt>g[s.source].startedAt)g[s.source]=s;
  }
  return [...groups.values()].filter(g=>g.code&&g.work&&g.code.result.deltaPercent>0).map(g=>({label:g.code.label,code:g.code.result.deltaPercent,work:g.work.result.deltaPercent,workOverCode:g.work.result.deltaPercent/g.code.result.deltaPercent,codeModels:g.code.result.models,workModels:g.work.result.models,codeCacheShare:g.code.result.cacheShare,workCacheShare:g.work.result.cacheShare,warning:'这是同标签任务的观察值；起始代码、要求与验收完成程度仍需由用户核对，不是统一 token 单价'}));
}
module.exports={id,parseUsage,parseMonthlyLog,aggregate,totals,intervalFlags,candidateIntervals,monthlyPoints,latestMonthly,stableBaseline,settlement,fitRates,compareRates,compareTasks,modelName};
