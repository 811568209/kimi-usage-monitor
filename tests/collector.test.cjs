'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Collector}=require('../lib/collector.cjs');
test('只扫描 canonical wire，重复扫描不重复计数，截断行稍后补全',async t=>{
 const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'kimi-monitor-test-'));t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),tempRoot);assert.match(path.basename(resolved),/^kimi-monitor-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const codeHome=path.join(dir,'code'),workHome=path.join(dir,'work'),workApp=path.join(dir,'app'),data=path.join(dir,'data');
 const agent=path.join(codeHome,'sessions','wd-test','session-1','agents','main');fs.mkdirSync(agent,{recursive:true});
 const wire=path.join(agent,'wire.jsonl');
 const req={type:'llm.request',time:1793836800000,thinkingEffort:'high',prompt:'PRIVATE_BODY'};
 const usage={type:'usage.record',time:1793836801000,model:'kimi-code/k3.1-pro',usage:{inputOther:100,inputCacheRead:900,inputCacheCreation:0,output:50}};
 fs.writeFileSync(wire,JSON.stringify(req)+'\n'+JSON.stringify(usage)+'\n');
 fs.mkdirSync(path.join(codeHome,'server','events'),{recursive:true});fs.writeFileSync(path.join(codeHome,'server','events','copy.jsonl'),JSON.stringify(usage)+'\n');
 const config={codeHome,workHome,workApp,logUtcOffset:'+08:00',quotaPollSeconds:60};
 const c=new Collector(config,data);let r=await c.scan(false);assert.equal(r.events.length,1);assert.equal(r.events[0].thinking,'high');
 r=await c.scan(false);assert.equal(r.events.length,1);
 const second={...usage,time:usage.time+1000};const encoded=JSON.stringify(second);fs.appendFileSync(wire,encoded.slice(0,40));
 r=await c.scan(false);assert.equal(r.events.length,1);fs.appendFileSync(wire,encoded.slice(40)+'\n');
 r=await c.scan(false);assert.equal(r.events.length,2);assert(!fs.readFileSync(path.join(data,'events.jsonl'),'utf8').includes('PRIVATE_BODY'));
 const restored=new Collector(config,data);r=await restored.scan(false);assert.equal(r.events.length,2);
 const childWire=path.join(codeHome,'sessions','wd-test','session-1','agents','child-one','wire.jsonl');fs.mkdirSync(path.dirname(childWire),{recursive:true});fs.writeFileSync(childWire,JSON.stringify({...usage,time:usage.time+2000,agentId:'child-one'})+'\n');
 const titleWire=path.join(workHome,'sessions','wd-test','ctitle-test','agents','main','wire.jsonl');fs.mkdirSync(path.dirname(titleWire),{recursive:true});fs.writeFileSync(titleWire,JSON.stringify({...usage,time:usage.time+3000,model:'dynamic-fixture-model'})+'\n');
 fs.mkdirSync(path.join(workApp,'kimi-agent'),{recursive:true});fs.writeFileSync(path.join(workApp,'kimi-agent','kimi-work-models-cache.json'),JSON.stringify({fixture:{models:[{key:'dynamic-fixture-model',displayName:'缓存读取的测试模型名'}]}}));
 r=await restored.scan(false);assert.equal(r.events.length,4);assert(r.events.some(e=>e.agent==='child-one'));const title=r.events.find(e=>e.auxiliary==='title');assert(title);assert.equal(title.model,'缓存读取的测试模型名');
 fs.unlinkSync(childWire);fs.appendFileSync(path.join(data,'events.jsonl'),'{"interrupted');const recovered=new Collector(config,data);assert.equal((await recovered.scan(false)).events.length,4);assert(fs.readFileSync(path.join(data,'events.jsonl'),'utf8').endsWith('\n'));
});
test('额度查询失败不写入新快照，也不伪造最后成功时间',async t=>{
 const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'kimi-monitor-test-'));t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),tempRoot);assert.match(path.basename(resolved),/^kimi-monitor-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const config={workApp:path.join(dir,'app'),codeHome:path.join(dir,'code'),workHome:path.join(dir,'work')};
 const c=new Collector(config,path.join(dir,'data'));
 c.workQuota={poll:async()=>({ok:true,attemptedAt:900,snapshot:{id:'real-response-fixture',source:'kimi-membership-api',kind:'month',time:1000,used:.1,resetAt:null,plan:'test'},membership:{},provenance:{}})};
 await c.pollWork();assert.equal(c.status.workQuota.lastSuccessAt,1000);assert.equal(c.snapshots.size,1);
 c.workQuota={poll:async()=>({ok:false,attemptedAt:2000,reason:'network failure'})};await c.pollWork();
 assert.equal(c.status.workQuota.ok,false);assert.equal(c.status.workQuota.lastSuccessAt,1000);assert.equal(c.snapshots.size,1);assert.equal([...c.snapshots.values()][0].time,1000);
 const restored=new Collector(config,path.join(dir,'data'));assert.equal(restored.status.workQuota.lastSuccessAt,1000);
});

test('磁盘写入失败后不占用去重键，恢复时能再次采集',async t=>{
 const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'kimi-monitor-test-'));t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),tempRoot);assert.match(path.basename(resolved),/^kimi-monitor-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const c=new Collector({codeHome:dir+'/code',workHome:dir+'/work',workApp:dir+'/app'},dir+'/data');
 const wire=dir+'/code/sessions/wd-test/session-1/agents/main/wire.jsonl';fs.mkdirSync(path.dirname(wire),{recursive:true});fs.writeFileSync(wire,JSON.stringify({type:'usage.record',model:'x',time:Date.now(),usage:{inputOther:1,inputCacheRead:0,inputCacheCreation:0,output:1}})+'\n');
 const original=fs.appendFileSync;fs.appendFileSync=()=>{throw Error('fixture disk unavailable');};try{await assert.rejects(c.scan(false),/disk unavailable/);}finally{fs.appendFileSync=original;}
 assert.equal(c.events.size,0);assert.equal((await c.scan(false)).events.length,1);
});

test('Code 响应缺少额度不能标为成功；失败后保留原查询时间',async t=>{
 const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'kimi-monitor-test-'));t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),tempRoot);assert.match(path.basename(resolved),/^kimi-monitor-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
 fs.mkdirSync(dir+'/code/server/instances',{recursive:true});fs.writeFileSync(dir+'/code/server.token','TEST_LOCAL_SECRET');fs.writeFileSync(dir+'/code/server/instances/test.json',JSON.stringify({host:'127.0.0.1',port:12345,pid:process.pid}));
 const c=new Collector({codeHome:dir+'/code',workHome:dir+'/work',workApp:dir+'/app'},dir+'/data');const original=globalThis.fetch;
 try{globalThis.fetch=async()=>({ok:true,json:async()=>({data:{kind:'ok',quota:{usages:{limit5h:{usedRatio:.25}}}}})});await c.pollCode();const time=c.status.codeQuota.time;assert.equal(c.status.codeQuota.ok,true);
 globalThis.fetch=async()=>({ok:true,json:async()=>({data:{kind:'ok',quota:{usages:{}}}})});await c.pollCode();assert.equal(c.status.codeQuota.ok,false);assert.equal(c.status.codeQuota.time,time);assert.equal(c.snapshots.size,1);
 }finally{globalThis.fetch=original;}
});
