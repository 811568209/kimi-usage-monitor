'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {monthlyCapacity}=require('../lib/monthly-capacity.cjs');
const T=Date.parse('2026-11-06T00:00:00Z'),NOW=T+3600000;
function fixture(definitions){
 const q=[{source:'kimi-membership-api',kind:'month',time:T,used:.1,account:'account',plan:'plan',resetAt:'2026-12-06',quantum:.0001}],events=[],samples=[];
 for(const [i,d] of definitions.entries()){
   q.push({...q[0],time:T+(i+1)*60000,used:q.at(-1).used+d.delta});
   for(let j=0;j<d.calls;j++){const time=T+(i+(j+1)/(d.calls+1))*60000;events.push({source:'code',session:'s',agent:'main',time,requestedAt:time-1,model:'m',rawModel:'m',thinking:'high',contextBand:'<=256K',inputOther:d.tokens*.1,cacheRead:d.tokens*.7,cacheWrite:d.tokens*.05,output:d.tokens*.15,total:d.tokens});}
   if(d.isolated)samples.push({source:'code',exclusiveAttested:true,startedAt:q[i].time,endedAt:q[i+1].time-1,baseline:q[i],result:{status:'accepted',endSnapshot:q[i+1]}});
 }
 return {q,events,samples,run:()=>monthlyCapacity(events,q,samples,NOW)};
}
test('高可信度存在时，剔除中低可信度极值，仅使用高可信度区间',()=>{
 const f=fixture([{delta:.02,calls:12,tokens:10000,isolated:true},{delta:.01,calls:12,tokens:20000},{delta:.001,calls:1,tokens:9999999}]),r=f.run(),s=r.overall;
 assert.equal(s.qualitySelection.tier,'high');assert.equal(s.qualitySelection.highWindows,1);assert.equal(s.qualitySelection.mediumWindows,1);assert.equal(s.qualitySelection.usedWindows,1);assert.equal(s.qualitySelection.excludedWindows,2);assert.equal(s.calls,12);assert(Math.abs(s.monthlyTokens-6000000)<1);assert(s.confidence.percent>=70);assert.equal(r.observations.filter(o=>o.status==='estimated').length,3);
});
test('没有高可信度时只使用中可信度，不受低可信度极值干扰',()=>{
 const s=fixture([{delta:.02,calls:12,tokens:10000},{delta:.001,calls:1,tokens:9999999}]).run().overall;
 assert.equal(s.qualitySelection.tier,'medium');assert.equal(s.qualitySelection.usedWindows,1);assert.equal(s.calls,12);assert(Math.abs(s.monthlyTokens-6000000)<1);
});
test('没有高中可信度时按全部匹配数据计算，不能均分或平均月额度',()=>{
 const s=fixture([{delta:.001,calls:1,tokens:1000},{delta:.003,calls:1,tokens:9000}]).run().overall;
 assert.equal(s.qualitySelection.tier,'all');assert.equal(s.qualitySelection.usedWindows,2);assert.equal(s.qualitySelection.excludedWindows,0);assert(Math.abs(s.monthlyTokens-2500000)<1);
});
test('可信度为 1% 粒度的整数，包含非整十数值，JSON 可直接解释',()=>{
 const values=[];
 for(let i=0;i<12;i++){const r=fixture([{delta:.00051+i*.0002,calls:1,tokens:10000}]).run();for(const c of [r.overall.confidence,r.latestEstimate.confidence,...r.modelEstimates.map(m=>m.confidence)]){assert(Number.isInteger(c.percent));assert(c.percent>=0&&c.percent<=100);assert.equal(c.resolutionPercent,1);assert.equal(c.percent,c.score);}values.push(r.overall.confidence.percent);}
 assert(new Set(values).size>2);assert(values.some(v=>v%10!==0));
});
test('缓存缺失和跨界请求仍有低可信度估算，原始用量保持 NULL',()=>{
 const f=fixture([{delta:.001,calls:1,tokens:10000},{delta:.001,calls:1,tokens:10000}]);f.events[0].cacheRead=null;f.events[0].total=null;f.events[1].requestedAt=T-1;
 const original=JSON.stringify(f.events),r=f.run();assert(r.overall.monthlyTokens>0);assert(r.latestEstimate.monthlyTokens>0);assert.equal(r.overall.status,'provisional');assert(r.overall.confidence.percent<=20);assert.equal(r.overall.imputation.cacheRead,7000);assert.equal(JSON.stringify(f.events),original);assert.equal(r.strictGroups[0].monthlyTokens,null);
});
test('读数稳定时沿用最近估算；兼容历史可用于新周期，已知其他账号不能借用',()=>{
 const f=fixture([{delta:.001,calls:1,tokens:10000}]);f.q.push({...f.q.at(-1),time:T+120000});const r=f.run();assert(r.latestEstimate.monthlyTokens>0);assert.equal(r.latest.status,'pending');
 f.q.push({...f.q.at(-1),time:T+180000,resetAt:'2027-01-06',used:0});const next=f.run();assert.equal(next.overall.status,'reference');assert(next.overall.monthlyTokens>0);assert(next.overall.confidence.percent<=10);assert.equal(next.overall.calls,0);
 f.q.at(-1).account='different-account';assert.equal(f.run().overall.monthlyTokens,null);
});
test('很小的扣减不会产生 Infinity 或无限额度，仅给 1%–5% 估算',()=>{
 const r=fixture([{delta:.00001,calls:1,tokens:1000}]).run();assert(Number.isFinite(r.overall.monthlyTokens));assert(r.overall.confidence.percent<=5);assert.equal(r.overall.range.upper,null);assert.equal(r.overall.status,'provisional');
});
