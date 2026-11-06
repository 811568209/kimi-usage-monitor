'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {monthlyCapacity}=require('../lib/monthly-capacity.cjs');
const T=Date.parse('2026-11-05T00:00:00Z'),NOW=T+86400000;
const snap=(n,used,extra={})=>({id:'q'+n,source:'kimi-membership-api',kind:'month',account:'synthetic-account',plan:'test',resetAt:'2026-12-05T00:00:00Z',quantum:.0001,time:T+n*60000,used,...extra});
const event=(n,total=10000,extra={})=>({source:'code',time:T+n*60000,requestedAt:T+n*60000-1000,model:'test-model',thinking:'high',contextBand:'<=256K',inputOther:total*.1,cacheRead:total*.7,cacheWrite:total*.05,output:total*.15,total,...extra});
const run=(events,snapshots,samples=[])=>monthlyCapacity(events,snapshots,samples,NOW);
const near=(actual,expected)=>assert(Math.abs(actual-expected)<Math.max(1,Math.abs(expected))*1e-9,`${actual} != ${expected}`);

test('空数据、单读数及无变化均无虚构额度或无限值',()=>{
  assert.equal(run([],[]).overall,null);
  assert.equal(run([],[snap(0,.2)]).latest.status,'baseline');
  const r=run([event(.5)],[snap(0,.2),snap(1,.2)]);
  assert.equal(r.latest.status,'pending');assert.equal(r.latest.monthlyTokens,null);assert.equal(r.overall.monthlyTokens,null);assert.equal(r.coverage.pendingCalls,1);
  assert(!JSON.stringify(r).includes('Infinity'));
});
test('单区间按消费比例反推总额度，输入输出和两种缓存分别保留',()=>{
  const r=run([event(.5)],[snap(0,.2),snap(1,.201)]),s=r.latest;
  near(s.monthlyTokens,10000000);near(s.deltaPercent,.1);assert(s.range.lower<s.monthlyTokens);assert(s.range.upper>s.monthlyTokens);
  assert.equal(s.confidence.level,'低');assert(s.confidence.score<=35);
  assert.deepEqual(s.composition.map(c=>c.tokens),[1000,7000,500,1500]);
  near(s.composition.reduce((v,c)=>v+c.share,0),1);near(s.composition.reduce((v,c)=>v+c.monthlyTokens,0),s.monthlyTokens);
  assert.match(r.confidenceNote,/不是统计概率/);
});
test('综合使用全部匹配 token 与消耗之和，不平均单条额度',()=>{
  const r=run([event(.5,10000),event(1.5,90000)],[snap(0,.2),snap(1,.201),snap(2,.204)]);
  near(r.overall.monthlyTokens,25000000);assert.equal(r.overall.observations,2);assert.equal(r.overall.calls,2);
  assert.notEqual(r.overall.monthlyTokens,20000000);assert(r.overall.relativeDispersion>0);
});
test('稳定读数和小额变化累计到下一次足够变化，只结算一次',()=>{
  const r=run([event(.5),event(1.5),event(2.5)],[snap(0,.2),snap(1,.2),snap(2,.2002),snap(3,.201),snap(4,.201)]);
  assert.equal(r.overall.calls,3);near(r.overall.monthlyTokens,30000000);
  assert.equal(r.overall.observations,1);assert.equal(r.latest.status,'pending');assert.equal(r.coverage.pendingCalls,0);assert.equal(r.latestEstimate.calls,3);
  assert.equal(r.observations.filter(o=>o.status==='estimated').length,1);
});
test('迟到 token 重算同一条观察，重复刷新和重复快照不会重复统计',()=>{
  const q=[snap(0,.2),snap(1,.201)],missing=run([],q),events=[event(.5)];
  assert.equal(missing.latest.status,'excluded');
  const a=run(events,q),b=run(events,[q[0],...q]);assert.equal(a.latest.id,missing.latest.id);
  assert.deepEqual(a.overall,b.overall);assert.equal(b.overall.calls,1);
});
test('严格结算保留门槛，小额和跨起点数据可低可信度回退',()=>{
  assert.equal(run([event(.5)],[snap(0,.2),snap(1,.2001)]).latest.status,'pending');
  for(const [rows,reason] of [[[],/没有对应/],[[event(.5,0)],/总量为零/],[[event(.5,10000,{requestedAt:T-1})],/跨越/]]){
    const r=run(rows,[snap(0,.2),snap(1,.201)]);assert.equal(r.latest.status,'excluded');assert.match(r.latest.reason,reason);assert.equal(r.strictGroups[0].monthlyTokens,null);
    if(rows[0]?.total>0){assert(r.overall.monthlyTokens>0);assert(r.overall.confidence.percent<=15);}
  }
});
test('缓存原始 NULL 和严格结算不变，全量回退可用同构成记录补估',()=>{
  for(const key of ['cacheRead','cacheWrite']) {
    const r=run([event(.5,10000,{[key]:null,total:null}),event(1.5)],[snap(0,.2),snap(1,.201),snap(2,.202)]);
    const invalid=r.observations[1];assert.equal(invalid.status,'excluded');assert.equal(invalid.total,null);
    assert.equal(invalid.composition.find(c=>c.key===key).share,null);assert.equal(invalid.composition.find(c=>c.key===key).unknownCalls,1);
    assert.equal(r.strictGroups[0].calls,1);assert.equal(r.overall.calls,2);near(r.overall.monthlyTokens,10000000);assert.equal(r.coverage.excludedWindows,1);
    assert.equal(r.overall.status,'provisional');assert.equal(r.overall.qualitySelection.tier,'all');assert(r.overall.confidence.percent<=35);
  }
});
test('账号、套餐、周期变化与余额恢复各自分段，不跨边界相加',()=>{
  for(const change of [{account:'other'},{plan:'new'},{resetAt:'2027-01-05T00:00:00Z'},{used:.1}]){
    const used=change.used??.201;
    const q=[snap(0,.2),snap(1,.201),snap(2,used,change),snap(3,used+.002,change.used==null?change:{})];
    const r=run([event(.5),event(2.5,40000)],q);
    assert.equal(r.groups.length,2);assert.equal(r.groups[0].calls,1);assert.equal(r.overall.calls,1);
    near(r.overall.monthlyTokens,20000000);assert.equal(r.observations[2].status,'boundary');
  }
});
test('切换账号后再切回也不拼接原分段',()=>{
  const r=run([event(.5),event(2.5),event(4.5)],[snap(0,.2),snap(1,.201),snap(2,.3,{account:'other'}),snap(3,.301,{account:'other'}),snap(4,.201),snap(5,.202)]);
  assert.equal(r.groups.length,3);assert.equal(r.overall.observations,1);
});
test('API 与历史日志重叠时独立计算，综合优先 API，不加倍',()=>{
  const q=[snap(0,.2),snap(1,.201),snap(0,.2,{source:'work-log',account:undefined}),snap(1,.202,{source:'work-log',account:undefined})];
  const r=run([event(.5)],q);assert.equal(r.groups.length,2);assert.equal(r.overall.source,'kimi-membership-api');assert.equal(r.overall.calls,1);near(r.overall.monthlyTokens,10000000);
  const logs=run([event(.5)],q.filter(s=>s.source==='work-log'));assert.equal(logs.overall.source,'work-log');assert(logs.overall.confidence.score<=40);
});
test('超过最近 80 条的历史也参与综合，数量增长不截断计算',()=>{
  const q=Array.from({length:121},(_,i)=>snap(i,.1+i*.001)),events=Array.from({length:120},(_,i)=>event(i+.5));
  const r=run(events,q);assert.equal(r.overall.observations,120);assert.equal(r.overall.calls,120);near(r.overall.monthlyTokens,10000000);
  assert.equal(r.observations.length,121);assert(r.overall.confidence.score<=60);
});
test('综合置信度反映一致性、有效数量和隔离条件，绝非只看数据条数',()=>{
  const q=Array.from({length:13},(_,i)=>snap(i,.1+i*.001)),events=Array.from({length:12},(_,i)=>event(i+.5));
  const regular=run(events,q),single=run([event(.5)],q.slice(0,2));assert(regular.overall.confidence.score>single.overall.confidence.score);
  const isolated={source:'code',exclusiveAttested:true,startedAt:T,endedAt:T+12*60000,baseline:q[0],result:{status:'accepted',endSnapshot:q.at(-1)}};
  const verified=run(events,q,[isolated]);assert.equal(verified.overall.confidence.level,'高');assert(verified.overall.confidence.score<=90);
  const noisy=run(events.map((e,i)=>event(i+.5,i%2?1000:19000)),q);assert(noisy.overall.confidence.score<regular.overall.confidence.score);
  assert.match(noisy.overall.confidence.reasons.join('；'),/波动/);
});
test('隔离标注不能覆盖采样开始前的调用或其他产品的调用',()=>{
  const q=[snap(0,.2),snap(1,.201)],s={source:'work',exclusiveAttested:true,startedAt:T+40000,endedAt:T+60000,baseline:q[0],result:{status:'accepted',endSnapshot:q[1]}};
  assert.equal(run([event(.5)],q,[s]).latest.isolated,false);
});
test('混合产品模型和大时间间隔降低置信度，构成保留实际计数',()=>{
  const r=run([event(.3),event(.6,10000,{source:'work',model:'other'})],[snap(0,.2),snap(1,.201)]);
  assert.equal(r.latest.contexts.length,2);assert.equal(r.latest.calls,2);assert(r.overall.confidence.score<=50);
  const long=run([event(.5)],[snap(0,.2),snap(500,.201)]);assert.match(long.overall.confidence.reasons.join('；'),/6 小时/);
});
test('触顶和异常跳变仅作极低可信度回退，超前读数仍不能参与',()=>{
  for(const q of [[snap(0,.999),snap(1,1)],[snap(0,.1),snap(1,.5)],[snap(0,.2),snap(2000,.201)]]){
    const r=run([event(.5)],q);assert.equal(r.latest.status,'excluded');assert.equal(r.strictGroups[0].monthlyTokens,null);
    if(q[1].time<=NOW){assert(r.overall.monthlyTokens>0);assert.equal(r.overall.confidence.percent,1);}else assert.equal(r.overall.monthlyTokens,null);
  }
});
test('起始边界不重复计数，末端包含，待结算尾部不误计入综合',()=>{
  const r=run([event(0),event(1),event(1.5)],[snap(0,.2),snap(1,.201),snap(2,.201)]);
  assert.equal(r.overall.calls,1);assert.equal(r.coverage.pendingCalls,1);assert.equal(r.coverage.localCalls,3);
});
test('所选时间同样按可信度优先筛选，跨界低可信度记录保持可追溯',()=>{
  const events=[event(.5),event(1.5,10000,{requestedAt:T+30000})],q=[snap(0,.2),snap(1,.201),snap(2,.202)];
  const auto=run(events,q);assert.equal(auto.strictGroups[0].calls,1);assert.equal(auto.overall.calls,2);
  const selected=monthlyCapacity(events,q,[],NOW,{from:T,to:T+120000,exclusiveAttested:true});
  assert.equal(selected.overall.calls,1);near(selected.overall.monthlyTokens,10000000);assert.equal(selected.overall.observations,1);assert.equal(selected.latest.isolated,true);assert.equal(selected.overall.qualitySelection.tier,'medium');assert.equal(selected.overall.qualitySelection.excludedWindows,1);
  assert.equal(selected.selection.exclusiveAttested,true);
});
test('时间段不外推未覆盖边缘，不混合多个周期，未确认时保持保守评分',()=>{
  const q=[snap(0,.2),snap(1,.201),snap(2,.202),snap(3,.1),snap(4,.101)],events=[event(.5),event(1.5),event(3.5)];
  const r=monthlyCapacity(events,q,[],NOW,{from:T+1000,to:T+240000});
  assert.equal(r.groups.length,2);assert.equal(r.groups[0].start,T+60000);assert.equal(r.groups[0].calls,1);assert.equal(r.overall.calls,1);
  assert(r.overall.confidence.score<=35);
});
test('不同模型、思考档位、产品与上下文区间分别推算，不混在同一个额度里',()=>{
  const extras=[{model:'A',thinking:'high'},{model:'A',thinking:'low'},{model:'B',thinking:'high'},{model:'A',thinking:'high',source:'work'},{model:'A',thinking:'high',contextBand:'>256K'}];
  const q=Array.from({length:6},(_,i)=>snap(i,.1+i*.001)),events=extras.map((extra,i)=>event(i+.5,10000*(i+1),extra));
  const r=run(events,q);assert.equal(r.modelEstimates.length,5);
  for(let i=0;i<5;i++){assert.equal(r.modelEstimates[i].status,'estimated');near(r.modelEstimates[i].monthlyTokens,10000000*(i+1));assert.equal(r.modelEstimates[i].observations,1);}
  assert.equal(r.modelEstimates[1].thinking,'low');assert.equal(r.modelEstimates[3].source,'work');assert.equal(r.modelEstimates[4].band,'>256K');
  const selected=monthlyCapacity(events,q,[],NOW,{from:T,to:T+5*60000,exclusiveAttested:true});assert.equal(selected.modelEstimates.length,5);assert(selected.modelEstimates.every(m=>m.status==='estimated'));
});
test('同区间多模型或多档位的共享扣减不能按 token 比例硬拆',()=>{
  for(const extra of [{model:'other'},{thinking:'low'},{source:'work'}]){
    const r=run([event(.3),event(.6,20000,extra)],[snap(0,.2),snap(1,.201)]);
    assert.equal(r.overall.status,'estimated');assert.equal(r.modelEstimates.length,2);
    assert(r.modelEstimates.every(m=>m.monthlyTokens===null&&m.confidence.score===0));assert.equal(r.modelEstimates[1].observedTokens,20000);
  }
});
test('档位未知不能假定为 high，原始模型标识区分普通与高速模型',()=>{
  const unknown=run([event(.5,10000,{thinking:'unknown'})],[snap(0,.2),snap(1,.201)]);
  assert.equal(unknown.modelEstimates[0].monthlyTokens,null);assert.match(unknown.modelEstimates[0].reason,/未记录/);
  const models=run([event(.5,10000,{rawModel:'pro'}),event(1.5,20000,{rawModel:'highspeed'})],[snap(0,.2),snap(1,.201),snap(2,.202)]);
  assert.equal(models.modelEstimates.length,2);near(models.modelEstimates[1].monthlyTokens,20000000);
});
test('模型的全量记录与用于推算的可分离记录分别计数',()=>{
  const r=run([event(.5),event(1.2),event(1.6,10000,{model:'other'})],[snap(0,.2),snap(1,.201),snap(2,.202)]);
  const model=r.modelEstimates.find(m=>m.model==='test-model');assert.equal(model.observedCalls,2);assert.equal(model.calls,1);assert.equal(model.observations,1);
});
