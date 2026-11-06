'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../lib/metrics.cjs');
const T=Date.parse('2026-11-05T00:00:00Z');
const snap=(time,used=.2)=>({source:'work-log',kind:'month',time,used,resetAt:'2026-12-05T00:00:00Z',plan:'25',quantum:.0001});
function event(time,extra={}){return {source:'code',session:'s',agent:'main',time,requestedAt:time-1000,model:'K3.1 Pro',thinking:'high',scope:'turn',auxiliary:'none',inputOther:1000,cacheRead:8000,cacheWrite:0,output:1000,total:10000,contextBand:'<=256K',...extra};}
function sample(){return {source:'code',startedAt:T,endedAt:T+10000,baseline:snap(T-1000),exclusiveAttested:true};}
const stable=()=>[snap(T+71000,.201),snap(T+101000,.201)];
test('只计逐次 usage，不把上下文占用当累计消耗',()=>{
  assert.equal(M.parseUsage({type:'token_counting.measured',tokens:50000},{},{}),null);
  const r=M.parseUsage({type:'usage.record',model:'kimi-code/k3.1-pro',time:T,usage:{inputOther:100,inputCacheRead:900,inputCacheCreation:20,output:50}},{source:'code',session:'s',agentPath:'main',line:4});
  assert.equal(r.input,1020);assert.equal(r.total,1070);assert.equal(r.model,'K3.1 Pro');
});
test('缓存缺失不能补成零或输出完整总数',()=>{
  const r=M.parseUsage({type:'usage.record',model:'x',time:T,usage:{inputOther:100,inputCacheCreation:0,output:50}},{source:'work',session:'s',line:1});
  assert.equal(r.cacheRead,null);assert.equal(r.total,null);assert.equal(M.aggregate([r])[0].unknown,1);
  assert.equal(M.aggregate([r])[0].total,null);assert.equal(M.aggregate([r])[0].knownTotal,150);
  assert.equal(M.totals([r]).total,null);assert.equal(M.totals([r]).knownTotal,150);
});

test('缓存缺失保留实际月额度任务成本，但不能参与 token 费率拟合',()=>{
 const r=M.settlement(sample(),[event(T+5000,{cacheRead:null,total:null,contextBand:'unknown'})],stable(),T+110000);
 assert.equal(r.status,'accepted');assert.equal(r.total,null);assert.equal(r.knownTotal,2000);assert.equal(r.percentPerMillion,null);assert.equal(r.tokenComplete,false);
 assert.equal(M.fitRates([{...sample(),result:r}]).length,0);
});

test('相邻轮询略少于三十秒时可以跨多次稳定读数结算',()=>{
 const r=M.settlement(sample(),[event(T+5000)],[snap(T+71000,.201),snap(T+100990,.201),snap(T+130980,.201)],T+140000);
 assert.equal(r.status,'accepted');assert.equal(r.endSnapshot.time,T+130980);
});

test('稳定窗口之间发生变动不能用两端相同的读数伪装稳定',()=>{
 const r=M.settlement(sample(),[event(T+5000)],[snap(T+71000,.201),snap(T+91000,.202),snap(T+111000,.201)],T+120000);
 assert.equal(r.status,'settling');
});

test('结算完成后的账号切换不会污染过去已结算样本',()=>{
 const r=M.settlement(sample(),[event(T+5000)],[...stable(),{...snap(T+200000,.4),account:'later'}],T+210000);
 assert.equal(r.status,'accepted');
});

test('未到来的读数不得提前完成结算',()=>{
 assert.equal(M.settlement(sample(),[event(T+5000)],stable(),T+90000).status,'settling');
});

test('结束后先等待日志写入，超过观察期仍为空才判无效',()=>{
 assert.equal(M.settlement(sample(),[],stable(),T+11000).status,'settling');
 assert.equal(M.settlement(sample(),[],stable(),T+71000).status,'invalid');
 assert.equal(M.settlement(sample(),[event(T+5000)],stable(),T+110000).status,'accepted');
});

test('缺缓存的历史区间仅展示已知下限，不能变成精确合计',()=>{
 const r=M.candidateIntervals([event(T+5000,{cacheRead:null,total:null})],[snap(T),snap(T+10000,.201)])[0];
 assert.equal(r.total,null);assert.equal(r.knownTotal,2000);
});
test('模型显示名称改变不会重复计数',()=>{
  const r={type:'usage.record',model:'x',time:T,usage:{inputOther:100,inputCacheRead:200,inputCacheCreation:0,output:50}},meta={source:'work',session:'s',agentPath:'main',line:1};
  assert.equal(M.parseUsage(r,meta,{}, {x:'old'}).id,M.parseUsage(r,meta,{}, {x:'new'}).id);
});
test('拒绝负数、小数计数和无效时间',()=>{
  for(const inputOther of [-1,1.2,NaN])assert.equal(M.parseUsage({type:'usage.record',time:T,usage:{inputOther,output:4}},{},{}),null);
});
test('标题调用计入但单独标记，输出不保留正文',()=>{
  const r=M.parseUsage({type:'usage.record',model:'k3-agent',time:T,secret:'DO_NOT_EXPORT',usage:{inputOther:1,inputCacheRead:2,inputCacheCreation:0,output:3}},{source:'work',session:'ctitle-123',line:1});
  assert.equal(r.auxiliary,'title');assert.equal(r.total,6);assert(!JSON.stringify(r).includes('DO_NOT_EXPORT'));
});
test('会员日志是已用比例，转换北京时间并保留周期',()=>{
  const r=M.parseMonthlyLog('[2026-11-05 08:00:00.000] [info] [SubscriptionManager] refreshed(sub): level=25 isMember=true omniRatio=0.9700000286102295 exhausted=false resetAt=2026-12-05T09:46:57.000Z');
  assert.equal(r.time,T);assert.equal(r.plan,'25');assert(Math.abs(r.used-.97)<1e-7);
  assert.equal(M.parseMonthlyLog('contextUsage=0.97'),null);
  assert.equal(M.parseMonthlyLog('[2026-11-05 08:00:00.000] [info] [SubscriptionManager] refreshed(sub): level=25 isMember=true omniRatio=0.<redacted> exhausted=false resetAt=2026-12-05T09:46:57.000Z'),null);
});
test('近期读数不因过去的重置字段失效，五分钟采样要求与会员有效期分开',()=>{
  assert.equal(M.latestMonthly([snap(T)],T+121000).stale,false);
  assert.equal(M.latestMonthly([snap(T)],T+301000).stale,true);
  const r=M.latestMonthly([{...snap(T),resetAt:new Date(T-86400000).toISOString()}],T+93000);
  assert.equal(r.stale,false);assert.equal(r.resetMetadataPast,true);assert.equal(r.staleReason,null);
  assert.equal(M.latestMonthly([snap(T)],T+121000,120).stale,true);
});
test('复现截图：十一月六日新读数携带十一月五日重置字段仍可作为起点',()=>{
  const oldReset='2026-11-05T09:46:57Z',t=Date.parse('2026-11-06T08:34:12.606+08:00');
  const points=[{...snap(t,.0124),resetAt:oldReset},{...snap(t+30000,.0124),resetAt:oldReset}];
  assert.equal(M.latestMonthly(points,t+93000).stale,false);
  assert.equal(M.stableBaseline(points,t+93000).used,.0124);
});
test('日志时钟显著超前不能作为采样起点',()=>{
  assert.equal(M.latestMonthly([snap(T+60000)],T).staleReason,'clock-skew');
});
test('同一个旧重置字段下余额下降仍会隔开对照数据',()=>{
  const points=M.monthlyPoints([snap(T,.99),snap(T+86400000,.0124),snap(T+86430000,.0125)]);
  assert.notEqual(points[0].quotaSegment,points[1].quotaSegment);
  assert.equal(points[1].quotaSegment,points[2].quotaSegment);
});
test('起点需要稳定快照，临时返回零后不能开始计费实验',()=>{
  assert.equal(M.stableBaseline([snap(T,.2)],T+1000),null);
  assert.equal(M.stableBaseline([snap(T,.2),snap(T+30000,.2)],T+31000).used,.2);
  assert.equal(M.stableBaseline([snap(T,.2),snap(T+30000,0)],T+31000),null);
});
test('单入口稳定结算后计算百分点和单位用量',()=>{
  const r=M.settlement(sample(),[event(T+5000)],stable(),T+110000);
  assert.equal(r.status,'accepted');assert(Math.abs(r.deltaPercent-.1)<1e-8);assert(Math.abs(r.percentPerMillion-10)<1e-7);
});
test('旧重置字段不会使同一余额基准内的新样本结算失败',()=>{
  const oldReset=new Date(T-86400000).toISOString(),s=sample();s.baseline.resetAt=oldReset;
  const r=M.settlement(s,[event(T+5000)],stable().map(p=>({...p,resetAt:oldReset})),T+110000);
  assert.equal(r.status,'accepted');
});
test('自动会员接口的读数可完成稳定起点与结算，不依赖客户端日志刷新',()=>{
  const api=p=>({...p,source:'kimi-membership-api',account:'account-hash'});
  const points=[api(snap(T-31000)),api(snap(T-1000)),...stable().map(api)];
  const baseline=M.stableBaseline(points.slice(0,2),T);assert(baseline);
  assert.equal(M.settlement({...sample(),baseline},[event(T+5000)],points,T+110000).status,'accepted');
});
test('对照期间账号变化，不能继续用新账号的余额结算',()=>{
  const baseline={...snap(T-1000),source:'kimi-membership-api',account:'a'};
  const points=stable().map(p=>({...p,source:'kimi-membership-api',account:'b'}));
  assert.equal(M.settlement({...sample(),baseline},[event(T+5000)],points,T+110000).status,'invalid');
});
test('结算期间余额先下降再反弹，不可按最终净增量估价',()=>{
  const r=M.settlement(sample(),[event(T+5000)],[snap(T+30000,.1),...stable()],T+110000);
  assert.equal(r.status,'invalid');
});
test('只有一次读数不能宣称已结算',()=>{
  assert.equal(M.settlement(sample(),[event(T+5000)],[snap(T+71000,.201)],T+100000).status,'settling');
});
test('同时用两端与跨起点请求均被拒绝',()=>{
  assert.equal(M.settlement(sample(),[event(T+5000),event(T+6000,{source:'work'})],stable()).status,'invalid');
  assert.equal(M.settlement(sample(),[event(T+5000,{requestedAt:T-3000})],stable()).status,'invalid');
});
test('结算前的新任务不能算入旧样本',()=>{
  const r=M.settlement(sample(),[event(T+5000),event(T+30000)],stable());assert.equal(r.status,'invalid');
});
test('刷新周期、退款或赠送导致比例下降、100% 截断不能算费率',()=>{
  const e=[event(T+5000)];
  for(const points of [[{...snap(T+71000,.201),plan:'30'},{...snap(T+101000,.201),plan:'30'}],[snap(T+71000,.1),snap(T+101000,.1)],[snap(T+71000,1),snap(T+101000,1)]])assert.equal(M.settlement(sample(),e,points).status,'invalid');
});
test('零变化不能解释为免费，极小变化不足以测费率',()=>{
  for(const value of [.2,.2001])assert.equal(M.settlement(sample(),[event(T+5000)],[snap(T+71000,value),snap(T+101000,value)]).status,'invalid');
});
function fittedSamples(multiplier=1,source='code'){
 return Array.from({length:12},(_,i)=>{const x=[1+(i%3)*.3,3+((i*7)%5),.2+((i*3)%7)*.05];return {source,baseline:snap(T),result:{status:'accepted',models:['K3.1 Pro'],bands:['<=256K'],thinkingEfforts:['high'],inputOther:x[0]*1e6,cacheRead:x[1]*1e6,output:x[2]*1e6,cacheWrite:0,deltaPercent:multiplier*(x[0]+.01*x[1]+5*x[2])}};});
}
test('有足够构成变化才能恢复合成的费率，并在相同构成下比较',()=>{
  const fits=M.fitRates([...fittedSamples(),...fittedSamples(3,'work')]);assert.equal(fits.length,2);
  assert.equal(fits[0].status,'estimated');assert(Math.abs(fits[0].coefficients.cacheRead-.01)<1e-7);
  assert(Math.abs(M.compareRates(fits)[0].workOverCode-3)<1e-7);
});
test('不足样本和比例完全相同不能被拟合成可靠单价',()=>{
  assert.equal(M.fitRates(fittedSamples().slice(0,3))[0].status,'insufficient');
  const rows=fittedSamples();for(const r of rows){r.result.inputOther=1e6;r.result.cacheRead=9e6;r.result.output=1e6;}
  assert.equal(M.fitRates(rows)[0].status,'insufficient');
});
test('模型或周期不同不生成对比倍率',()=>{
  const fits=M.fitRates([...fittedSamples(),...fittedSamples(3,'work')]);fits[1].cycle='other';assert.equal(M.compareRates(fits).length,0);
});

test('不同思考档位的单价拟合不可合并对照',()=>{
 const rows=[...fittedSamples(),...fittedSamples(3,'work')];for(const s of rows)s.result.thinkingEfforts=[s.source==='code'?'high':'max'];
 const fits=M.fitRates(rows);assert.equal(fits.length,2);assert.equal(M.compareRates(fits).length,0);
});

test('含多种思考档位的样本不进入单一档位费率拟合',()=>{
 const rows=fittedSamples();rows.forEach(s=>s.result.thinkingEfforts=['high','max']);assert.equal(M.fitRates(rows).length,0);
});

test('缓存写入可辨识且样本充足时恢复四类系数',()=>{
 const rows=Array.from({length:20},(_,i)=>{const x=[1+(i%3),2+(i%5),.2+(i%7)*.1,.5+(i%4)*.3];return {source:'code',baseline:snap(T),result:{status:'accepted',models:['K3.1 Pro'],bands:['<=256K'],thinkingEfforts:['high'],inputOther:x[0]*1e6,cacheRead:x[1]*1e6,output:x[2]*1e6,cacheWrite:x[3]*1e6,deltaPercent:x[0]+.01*x[1]+5*x[2]+2*x[3]}};});
 const fit=M.fitRates(rows)[0];assert.equal(fit.status,'estimated');assert(Math.abs(fit.coefficients.cacheWrite-2)<1e-6);assert.equal(M.fitRates(rows.slice(0,11))[0].status,'insufficient');
});

test('负系数和过大拟合误差不会显示成可用价格',()=>{
 const negative=fittedSamples();negative.forEach(s=>{s.result.deltaPercent=10*s.result.inputOther/1e6-s.result.cacheRead/1e6+5*s.result.output/1e6;});assert.equal(M.fitRates(negative)[0].status,'unstable');
 const noisy=fittedSamples();noisy.forEach((s,i)=>{s.result.deltaPercent=i%2?.1:20;});assert.equal(M.fitRates(noisy)[0].status,'unstable');
});
test('同标签任务可以比较成本，但不同周期不能拼接',()=>{
 const a={...sample(),label:'same-task',startedAt:T,result:{status:'accepted',deltaPercent:1,models:['K3.1 Pro'],cacheShare:.9}};
 const b={...a,source:'work',result:{...a.result,deltaPercent:3}};
 assert.equal(M.compareTasks([a,b])[0].workOverCode,3);
 assert.equal(M.compareTasks([a,{...b,baseline:{...b.baseline,resetAt:'other'}}]).length,0);
});
test('历史候选区间带未确认说明，触顶区间明确排除',()=>{
  const result=M.candidateIntervals([event(T+5000)],[snap(T,.9),snap(T+10000,1)]);
  assert(result[0].flags.some(x=>x.includes('触顶')));assert(result[0].flags.some(x=>x.includes('不用于费率拟合')));
});
test('没有对应调用显示未记录；额度恢复不是负的消费',()=>{
  const r=M.candidateIntervals([],[snap(T,.99),snap(T+10000,.01)])[0];
  assert.equal(r.total,null);assert.equal(r.eventType,'baseline-change');assert(r.deltaPercent<0);
});
test('计费倍率的参考构成来自实际样本，而非固定的缓存比例',()=>{
  const fits=M.fitRates([...fittedSamples(),...fittedSamples(3,'work')]);const r=M.compareRates(fits)[0];
  assert.notEqual(r.mix.cacheRead,.97);assert.equal(r.mix.cacheWrite,0);assert(Math.abs(Object.values(r.mix).reduce((a,b)=>a+b,0)-1)<1e-10);
});
