'use strict';
const M = require('./metrics.cjs');

const FIELDS = ['inputOther', 'cacheRead', 'cacheWrite', 'output'];
const LABELS = {inputOther:'非缓存输入', cacheRead:'缓存读取', cacheWrite:'缓存写入', output:'输出'};
const EPSILON = 0.000002;
const CONFIDENCE_NOTE = '可信度以 0%–100% 显示，步长 1%，表示数据质量评分，不是统计概率；范围是精度与样本波动的敏感性范围，不是统计置信区间。';
const ASSUMPTION = '仅在本机记录覆盖对应账号全部消费、结算时间匹配且未来产品/模型/输入输出缓存构成相近时适用；并非官方固定 token 额度。单条调用不能独立分摊共享额度扣减。';

function composition(t, capacity = null) {
  return FIELDS.map(key => ({key, label:LABELS[key], tokens:t[key],
    unknownCalls:key==='cacheRead'?t.unknownCacheRead:key==='cacheWrite'?t.unknownCacheWrite:0,
    share:t.total>0?t[key]/t.total:null,
    monthlyTokens:t.total>0&&capacity!==null?capacity*t[key]/t.total:null}));
}
function tokenTotals(rows) {
  return {...M.totals(rows), unknownCacheRead:rows.filter(e=>e.cacheRead==null).length,
    unknownCacheWrite:rows.filter(e=>e.cacheWrite==null).length};
}
function contextTotals(events){
  const groups=new Map();
  for(const e of events){
    const key=JSON.stringify([e.source,e.rawModel||e.model,e.thinking||'unknown',e.contextBand||'unknown']);
    if(!groups.has(key))groups.set(key,{key,source:e.source,model:e.model,rawModel:e.rawModel||e.model,thinking:e.thinking||'unknown',band:e.contextBand||'unknown',rows:[]});
    groups.get(key).rows.push(e);
  }
  return [...groups.values()].map(({rows,...g})=>({...g,...tokenTotals(rows)}));
}
function confidence(rows, delta, uncertainty, dispersion) {
  const isolated = rows.filter(r=>r.isolated).length / rows.length;
  const components = {
    sampleSupport:20*Math.min((rows.length===1?rows[0].calls:rows.length)/12,1),
    consumptionSignal:20*Math.min(delta/.01,1),
    readingPrecision:20*Math.max(0,1-uncertainty/delta),
    consistency:rows.length>1?20*Math.max(0,1-dispersion):0,
    isolation:20*isolated
  };
  let cap=isolated===1?90:60;
  if(rows.length===1&&rows[0].calls<12)cap=isolated===1?55:35;
  if(rows.some(r=>!r.account))cap=Math.min(cap,40);
  if(rows.some(r=>r.contexts.length>1))cap=Math.min(cap,50);
  if(rows.some(r=>r.maxReadingGapMs>6*3600000))cap=Math.min(cap,40);
  const score=Math.round(Math.min(cap,Object.values(components).reduce((a,b)=>a+b,0)));
  const reasons=[];
  if(isolated<1)reasons.push('部分或全部区间未经隔离确认，无法排除其他设备消费和延迟结算');
  if(rows.length<12)reasons.push(`可用区间 ${rows.length} 条，样本支持有限`);
  if(rows.some(r=>!r.account))reasons.push('历史读数缺少账号标识');
  if(rows.some(r=>r.contexts.length>1))reasons.push('区间含不同产品、模型、思考档位或上下文构成，仅适用于混合构成');
  if(rows.some(r=>r.maxReadingGapMs>6*3600000))reasons.push('存在超过 6 小时的读数间隔');
  if(dispersion>.2)reasons.push('区间推算波动超过 20%，可能存在构成变化或结算延迟');
  return {score,percent:score,resolutionPercent:1,level:score>=70?'高':score>=40?'中':'低',components,cap,reasons,note:CONFIDENCE_NOTE};
}
function summarize(rows) {
  const t=Object.fromEntries(['calls',...FIELDS,'knownTotal','unknown','unknownCacheRead','unknownCacheWrite'].map(k=>[k,rows.reduce((sum,r)=>sum+(r[k]||0),0)]));
  t.total=t.unknown?null:t.knownTotal;
  const delta=rows.reduce((sum,r)=>sum+r.deltaUsed,0);
  const uncertainty=rows.reduce((sum,r)=>sum+r.uncertaintyUsed,0);
  const estimatedTotal=rows.reduce((sum,r)=>sum+(r.estimatedTotal??r.total??r.knownTotal),0);
  const monthlyTokens=estimatedTotal/delta;
  // Weight costs by observed tokens; summing capacities would over-weight tiny intervals.
  const cost=delta/estimatedTotal;
  const dispersion=rows.length>1?Math.sqrt(rows.reduce((sum,r)=>{const n=r.estimatedTotal??r.total??r.knownTotal;return sum+n/estimatedTotal*(r.deltaUsed/n-cost)**2;},0))/cost:0;
  const relativeSpread=dispersion;
  const lower=t.knownTotal/(delta+uncertainty+delta*relativeSpread);
  const upperDenominator=delta-uncertainty-delta*relativeSpread;
  return {...t,status:'estimated',observations:rows.length,start:rows[0].start,end:rows.at(-1).end,
    deltaUsed:delta,deltaPercent:delta*100,uncertaintyUsed:uncertainty,monthlyTokens,
    estimatedTotal,range:{lower,upper:upperDenominator>0?estimatedTotal/upperDenominator:null},relativeDispersion:dispersion,
    composition:composition(t,monthlyTokens),confidence:confidence(rows,delta,uncertainty,dispersion)};
}
function percentConfidence(value={score:0,level:'不足'}){
  const score=Math.max(0,Math.min(100,Math.round(value.score||0)));
  return {...value,score,percent:score,resolutionPercent:1,level:score>=70?'高':score>=40?'中':score>0?'低':'无基准',note:CONFIDENCE_NOTE};
}
function roughEstimate(o,events,references,now){
  if(!(o.deltaUsed>EPSILON)||o.end>now+30000||!(o.knownTotal>0)||!o.calls)return null;
  const rows=events.filter(e=>e.time>o.start&&e.time<=o.end),imputed={cacheRead:0,cacheWrite:0};let unresolved=0,referenceCalls=0;
  for(const e of rows)for(const field of ['cacheRead','cacheWrite'])if(e[field]==null){
    const peers=references.filter(r=>r.source===e.source&&(r.rawModel||r.model)===(e.rawModel||e.model)&&r.thinking===e.thinking&&
      (e.contextBand==='unknown'||!e.contextBand||r.contextBand===e.contextBand)&&Number.isFinite(r[field]));
    const input=peers.reduce((sum,r)=>sum+r.inputOther,0),cache=peers.reduce((sum,r)=>sum+r[field],0);
    if(peers.length&&input>0&&e.inputOther>0){imputed[field]+=Math.round(e.inputOther*cache/input);referenceCalls+=peers.length;}else unresolved++;
  }
  const estimatedTotal=o.knownTotal+imputed.cacheRead+imputed.cacheWrite;
  let cap=30;
  const reasons=[o.reason,'未达到严格结算条件，作为全量回退估算，不参与已结算费率拟合'];
  if(o.unknown){cap=20;reasons.push(unresolved?'缓存仍有未知项，当前为已知用量折算，实际额度可能更高':'缺失缓存按同产品、模型、档位的实测缓存/输入比例补估；原始 NULL 保留');}
  if(rows.some(e=>e.requestedAt!=null&&e.requestedAt<o.start)){cap=Math.min(cap,15);reasons.push('请求跨越起点，时间归因不完整');}
  if(!o.account)cap=Math.min(cap,15);
  if(o.deltaUsed<.0005||unresolved)cap=Math.min(cap,5);
  if(o.deltaUsed>=.25||/触顶/.test(o.reason))cap=1;
  const precision=o.deltaUsed/(o.deltaUsed+o.uncertaintyUsed);
  const score=Math.max(1,Math.min(cap,Math.round((8+12*Math.min(o.calls/20,1)+10*precision)*(1-.4*(o.unknown/o.calls)))));
  const denominator=o.deltaUsed-o.uncertaintyUsed;
  const mix=composition({...o,total:estimatedTotal,cacheRead:o.cacheRead+imputed.cacheRead,cacheWrite:o.cacheWrite+imputed.cacheWrite},estimatedTotal/o.deltaUsed)
    .map(p=>({...p,observedTokens:o[p.key],imputedTokens:imputed[p.key]||0,estimated:!!imputed[p.key]}));
  return {...o,status:'provisional',basis:'all-data-provisional',estimatedTotal,monthlyTokens:estimatedTotal/o.deltaUsed,
    valueKind:unresolved?'known-usage-only':'estimate',imputation:{...imputed,unresolvedFields:unresolved,referenceCalls},
    range:{lower:o.knownTotal/(o.deltaUsed+o.uncertaintyUsed),upper:unresolved||denominator<=0||cap===1?null:(estimatedTotal+imputed.cacheRead+imputed.cacheWrite)/denominator},
    composition:mix,confidence:percentConfidence({score,level:'低',cap,reasons}),reason:reasons.join('；')};
}
function selectEvidence(candidates){
  const high=candidates.filter(r=>r.confidence.score>=70),medium=candidates.filter(r=>r.confidence.score>=40&&r.confidence.score<70);
  const rows=high.length?high:medium.length?medium:candidates,tier=high.length?'high':medium.length?'medium':'all';
  return {rows,selection:{tier,label:tier==='high'?'仅高可信度数据':tier==='medium'?'仅中可信度数据':'全量数据回退',
    thresholds:{high:70,medium:40,resolutionPercent:1},totalWindows:candidates.length,usedWindows:rows.length,
    excludedWindows:candidates.length-rows.length,highWindows:high.length,mediumWindows:medium.length,lowWindows:candidates.length-high.length-medium.length}};
}
function selectedSummary(candidates){
  const {rows,selection}=selectEvidence(candidates);if(!rows.length)return null;
  const result=summarize(rows),provisional=rows.filter(r=>r.status==='provisional');
  result.qualitySelection=selection;result.basis=provisional.length?'all-data-provisional':'matched-consumption';
  result.evidenceAt=Math.max(...rows.map(r=>r.end));
  if(provisional.length){
    const cap=Math.max(...rows.map(r=>r.confidence.score));
    result.status='provisional';result.confidence=percentConfidence({...result.confidence,score:Math.min(cap,result.confidence.score),cap,
      reasons:[...new Set([...result.confidence.reasons,...provisional.flatMap(r=>r.confidence.reasons)])]});
    result.imputation={cacheRead:rows.reduce((s,r)=>s+(r.imputation?.cacheRead||0),0),cacheWrite:rows.reduce((s,r)=>s+(r.imputation?.cacheWrite||0),0),unresolvedFields:rows.reduce((s,r)=>s+(r.imputation?.unresolvedFields||0),0)};
    const projected={...result,total:result.estimatedTotal,cacheRead:result.cacheRead+result.imputation.cacheRead,cacheWrite:result.cacheWrite+result.imputation.cacheWrite};
    result.composition=composition(projected,result.monthlyTokens).map(p=>({...p,observedTokens:result[p.key],imputedTokens:result.imputation[p.key]||0,estimated:!!result.imputation[p.key]}));
    if(result.imputation.unresolvedFields){result.valueKind='known-usage-only';result.range.upper=null;}
  }
  return result;
}
function isIsolated(a,b,samples,rows) {
  return samples.some(s=>s.exclusiveAttested===true&&s.result?.status==='accepted'&&s.result.endSnapshot&&
    s.baseline.source===a.source&&s.baseline.account===a.account&&s.baseline.plan===a.plan&&s.baseline.resetAt===a.resetAt&&
    s.baseline.time<=a.time&&s.result.endSnapshot.time>=b.time&&rows.length>0&&
    rows.every(e=>e.time>s.startedAt&&e.time<=s.endedAt&&e.source===s.source));
}

function monthlyCapacity(events,snapshots,samples=[],now=Date.now(),options={}) {
  const selection=Number.isFinite(options.from)&&Number.isFinite(options.to)?{from:options.from,to:options.to,exclusiveAttested:options.exclusiveAttested===true}:null;
  if(selection){events=events.filter(e=>e.time>=selection.from&&e.time<=selection.to);snapshots=snapshots.filter(s=>s.time>=selection.from&&s.time<=selection.to);}
  const sortedEvents=[...events].sort((a,b)=>a.time-b.time);
  const streams=new Map();
  // Membership API and client log observations remain independent; overlapping streams are never summed.
  const unique=new Set();
  for(const s of [...snapshots].sort((a,b)=>a.time-b.time)) {
    if(s.kind!=='month'||!['kimi-membership-api','work-log'].includes(s.source)||!Number.isFinite(s.time)||
      !Number.isFinite(s.used)||s.used<0||s.used>1)continue;
    const key=JSON.stringify([s.source,s.account,s.time,s.used,s.plan,s.resetAt]);
    if(unique.has(key))continue;unique.add(key);
    if(!streams.has(s.source))streams.set(s.source,[]);streams.get(s.source).push(s);
  }
  const observations=[],groups=new Map();
  for(const [source,points] of streams) {
    let anchor=null,previous=null,segment=null,cursor=0,anchorIndex=0,maxReadingGapMs=0;
    for(let pointIndex=0;pointIndex<points.length;pointIndex++) {
      const b=points[pointIndex];
      while(cursor<sortedEvents.length&&sortedEvents[cursor].time<=b.time)cursor++;
      const changed=previous&&(b.account!==previous.account||b.plan!==previous.plan||b.resetAt!==previous.resetAt||b.used<previous.used-EPSILON);
      if(!anchor||changed) {
        segment=M.id(JSON.stringify([source,b.account,b.plan,b.resetAt,b.time,b.used]));
        const group={id:segment,source,account:b.account||null,plan:b.plan,resetAt:b.resetAt,first:b.time,last:b.time,rows:[],recordCount:0};groups.set(segment,group);
        observations.push({id:M.id('capacity|'+segment+'|'+b.time),groupId:segment,source,account:b.account||null,plan:b.plan,resetAt:b.resetAt,start:b.time,end:b.time,status:changed?'boundary':'baseline',reason:changed?'账号、套餐、周期或余额基准变化，开始新分段':'起始读数，等待后续额度变化',monthlyTokens:null,confidence:{score:0,level:'不足',note:CONFIDENCE_NOTE},composition:[]});
        anchor=b;anchorIndex=cursor;previous=b;maxReadingGapMs=0;continue;
      }
      if(b.time<=previous.time)continue;
      maxReadingGapMs=Math.max(maxReadingGapMs,b.time-previous.time);
      const a=anchor,rows=sortedEvents.slice(anchorIndex,cursor),t=tokenTotals(rows);
      const delta=b.used-a.used,uncertainty=2*Math.max(a.quantum||.0001,b.quantum||.0001);
      const contextUsage=contextTotals(rows),contexts=contextUsage.map(c=>[c.source,c.model,c.thinking,c.band].join(' / '));
      const observation={id:M.id('capacity|'+segment+'|'+b.time),groupId:segment,source,account:b.account||null,plan:b.plan,resetAt:b.resetAt,start:a.time,end:b.time,
        ...t,deltaUsed:delta,deltaPercent:delta*100,uncertaintyUsed:uncertainty,contexts,contextUsage,maxReadingGapMs,
        isolated:options.exclusiveAttested===true||isIsolated(a,b,samples,rows),
        isolationBasis:options.exclusiveAttested===true?'用户确认所选时间仅在本机消费':'已结算隔离样本或未经确认',
        status:'pending',reason:'额度尚未变化，累计等待结算；不能视为免费或无限额度',monthlyTokens:null,composition:composition(t),confidence:{score:0,level:'不足',note:CONFIDENCE_NOTE}};
      if(b.time>now+30000) {observation.status='excluded';observation.reason='读数时间晚于本机时间，不能推算';}
      else if(a.used>=.999999||b.used>=.999999) {observation.status='excluded';observation.reason='月额度触顶，扣减可能被截断';}
      else if(delta<.0005-EPSILON) {observation.reason=delta>EPSILON?'额度消耗不足 0.05 个百分点，继续累计，避免读数精度误差':'额度尚未变化，累计等待结算；不能视为免费或无限额度';}
      else if(delta>=.25) {observation.status='excluded';observation.reason='额度跳变达到 25 个百分点，需核对余额基准或缺失消费';}
      else if(!rows.length) {observation.status='excluded';observation.reason='没有对应本机调用，无法归因额度消耗';}
      else if(t.unknown) {observation.status='excluded';observation.reason='输入缓存字段缺失，仅有 token 下限，不能推算完整月额度';}
      else if(!t.total) {observation.status='excluded';observation.reason='对应 token 总量为零，不能推算';}
      else if(rows.some(e=>e.requestedAt!=null&&e.requestedAt<a.time)) {observation.status='excluded';observation.reason='存在跨越区间起点的请求，扣减与 token 时间范围不匹配';}
      else {
        Object.assign(observation,summarize([observation]),{reason:'对应区间 token ÷ 月额度消耗比例；按本区间构成折算'});
        groups.get(segment).rows.push(observation);
      }
      // Keep the latest identical idle/pending reading; raw polling timestamps remain in quota.jsonl.
      const last=observations.at(-1);
      if(observation.status==='pending'&&last?.status==='pending'&&last.groupId===segment&&last.start===observation.start&&
        last.calls===observation.calls&&last.knownTotal===observation.knownTotal&&last.deltaUsed===observation.deltaUsed)observations[observations.length-1]=observation;
      else observations.push(observation);
      const group=groups.get(segment);group.recordCount++;group.last=b.time;
      // Flat/tiny readings accumulate into a later, non-overlapping consumption window.
      if(observation.status!=='pending') {anchor=b;anchorIndex=cursor;maxReadingGapMs=0;}
      previous=b;
    }
  }
  observations.sort((a,b)=>a.end-b.end||a.source.localeCompare(b.source));
  for(const o of observations)o.confidence=percentConfidence(o.confidence);
  const strictGroups=[...groups.values()].map(({rows,...g})=>({...g,...(rows.length?summarize(rows):{status:'insufficient',monthlyTokens:null,observations:0,confidence:percentConfidence(),composition:[]}),
    excluded:observations.filter(o=>o.groupId===g.id&&o.status==='excluded').length}));
  const candidatesByGroup=new Map(),selectedByGroup=new Map();
  const summaries=strictGroups.map(g=>{
    const references=sortedEvents.filter(e=>e.time>g.first&&e.time<=g.last),windows=new Map();
    for(const o of observations.filter(o=>o.groupId===g.id&&o.end<=now+30000&&o.deltaUsed>EPSILON&&o.calls>0)){
      const prior=windows.get(o.start);if(!prior||o.end>prior.end)windows.set(o.start,o);
    }
    const candidates=[...windows.values()].map(o=>o.status==='estimated'?{...o,basis:'matched-consumption'}:roughEstimate(o,sortedEvents,references,now)).filter(Boolean);
    for(const candidate of candidates)if(candidate.status==='provisional'){
      const original=observations.find(o=>o.id===candidate.id);if(original)original.provisionalEstimate=candidate;
    }
    candidatesByGroup.set(g.id,candidates);selectedByGroup.set(g.id,selectEvidence(candidates).rows);
    return {...g,...(selectedSummary(candidates)||{}),qualitySelection:selectEvidence(candidates).selection};
  });
  // Carry a compatible earlier estimate through a flat/new cycle; never borrow a different known account or plan.
  for(let i=0;i<summaries.length;i++){
    const g=summaries[i];if(g.monthlyTokens!=null||!g.account)continue;
    const prior=summaries.slice(0,i).filter(p=>p.source===g.source&&p.account===g.account&&p.plan===g.plan&&p.monthlyTokens>0).at(-1);
    if(!prior)continue;
    const age=Math.max(0,now-(prior.evidenceAt||prior.end));
    Object.assign(g,{status:'reference',basis:'history-reference',monthlyTokens:prior.monthlyTokens,range:prior.range,
      referenceGroupId:prior.id,evidenceAt:prior.evidenceAt||prior.end,start:prior.start,end:prior.end,calls:0,observations:0,
      composition:prior.composition,confidence:percentConfidence({score:Math.min(10,Math.round(prior.confidence.score*Math.exp(-age/(7*86400000)))),
        reasons:['当前分段尚无有效扣减，沿用同账号、同套餐的历史估算；不混算历史 token 或额度',...prior.confidence.reasons]})});
  }
  const modelEstimates=[];
  for(const g of summaries){
    const contexts=contextTotals(sortedEvents.filter(e=>e.time>g.first&&e.time<=g.last));
    for(const c of contexts){
      const rows=(candidatesByGroup.get(g.id)||[]).filter(o=>o.contextUsage.length===1&&o.contextUsage[0].key===c.key);
      const identifiable=c.thinking!=='unknown'&&c.rawModel!=='unknown';
      const estimate=rows.length&&identifiable?selectedSummary(rows):null;
      const reason=!identifiable?'日志未记录模型或思考档位，不能推算指定档位':estimate?.status==='provisional'?'低可信度估算；缓存缺失时参考同产品、模型、档位和上下文的已知构成补估，未能补齐时仅折算已知下限':c.unknown?'存在缓存缺失；当前结果仅使用可匹配且可区分的区间，原始缺失字段保留未知':'仅使用该产品、模型、档位和上下文区间独占的额度变化；混用扣减无法精确分摊';
      modelEstimates.push({groupId:g.id,quotaSource:g.source,plan:g.plan,resetAt:g.resetAt,source:c.source,model:c.model,rawModel:c.rawModel,thinking:c.thinking,band:c.band,
        observedCalls:c.calls,observedTokens:c.total,observedKnownTokens:c.knownTotal,unknownCalls:c.unknown,observedComposition:composition(c),
        ...(estimate||{status:'insufficient',monthlyTokens:null,observations:0,calls:0,composition:composition(c),confidence:percentConfidence()}),reason});
    }
  }
  // Prefer the membership stream. Fall back to historical logs only when no membership record exists.
  const primary=streams.has('kimi-membership-api')?'kimi-membership-api':streams.has('work-log')?'work-log':null;
  const current=summaries.filter(g=>g.source===primary).at(-1)||null;
  const currentRows=observations.filter(o=>o.groupId===current?.id);
  const latest=currentRows.at(-1)||null,selected=selectedByGroup.get(current?.id)||[];
  const lastSelected=selected.at(-1);
  const latestEstimate=lastSelected?{...lastSelected,qualitySelection:current.qualitySelection,evidenceAt:lastSelected.end}:(current?.monthlyTokens!=null?current:null);
  return {method:'sum-matched-tokens / sum-used-ratio-deltas',formula:'月 token 总额度 = 对应 token 总量 ÷ (月额度消耗百分点 / 100)',assumption:ASSUMPTION,confidenceNote:CONFIDENCE_NOTE,
    generatedAt:now,selection,latest,latestEstimate,overall:current,groups:summaries,strictGroups,observations,
    modelEstimates,
    coverage:{localCalls:events.length,matchedCalls:current?.calls||0,strictMatchedCalls:strictGroups.find(g=>g.id===current?.id)?.calls||0,provisionalWindows:selected.filter(r=>r.status==='provisional').length,pendingCalls:(latest?.status==='pending'?latest.calls:0)+(latest?events.filter(e=>e.time>latest.end&&e.time<=now+30000).length:0),excludedWindows:current?.excluded||0},
    compositionNote:'非缓存输入、缓存读取、缓存写入和输出分别展示。月 token 分配仅表示保持该构成时的组成数量，不能据此确定各类 token 的独立费率。'};
}

module.exports={monthlyCapacity,composition};
