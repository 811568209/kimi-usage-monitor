'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {usageHistory,rangeParams}=require('../lib/history.cjs');
const params=o=>new URLSearchParams(o);
const events=Array.from({length:60},(_,i)=>({id:String(i),time:1000+i,source:i%2?'code':'work',model:i%3?'K3.1':'K2.8',thinking:'high',agent:'main'}));
test('完整历史按时间倒序分页，每页限制与越界页码正常',()=>{
  const first=usageHistory(events,params({}));assert.equal(first.total,60);assert.equal(first.pages,3);assert.equal(first.records[0].time,1059);
  const last=usageHistory(events,params({page:100}));assert.equal(last.page,3);assert.equal(last.records.length,10);
  assert.equal(usageHistory([],params({})).pages,1);
  for(const p of [{page:0},{page:'NaN'},{size:101},{size:0},{page:1.2}])assert.throws(()=>usageHistory(events,params(p)),/无效/);
});
test('产品、模型与起止时间组合筛选，原始记录不被修改',()=>{
  const r=usageHistory(events,params({source:'code',q:'k3.1',from:1010,to:1040}));
  assert(r.records.every(e=>e.source==='code'&&e.model==='K3.1'&&e.time>=1010&&e.time<=1040));assert.equal(events[0].time,1000);
  assert.throws(()=>usageHistory(events,params({source:'other'})),/产品来源/);
});
test('无效、缺失和倒序的时间范围不能静默退回全量',()=>{
  for(const p of [{},{from:1},{from:0,to:0},{from:3,to:2},{from:'',to:4},{from:'x',to:4}])assert.throws(()=>rangeParams(params(p),true),/起止时间/);
  assert.deepEqual(rangeParams(params({})),{});assert.deepEqual(rangeParams(params({from:0,to:1})),{from:0,to:1});
});
