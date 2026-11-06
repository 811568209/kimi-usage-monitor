'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {startFixture}=require('./browser-fixture.cjs');
const {DatabaseSync}=require('node:sqlite');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('全自动采集到推算与历史明细的真实 HTTP 端到端流程',async t=>{
  const f=await startFixture();t.after(()=>f.cleanup());let nonce;
  const get=async()=>{const r=await fetch(f.base+'/api/report');assert.equal(r.status,200);const report=await r.json();nonce=report.nonce;return report;};
  const post=(url,data={})=>fetch(f.base+url,{method:'POST',headers:{'Content-Type':'application/json','x-monitor-token':nonce},body:JSON.stringify(data)});
  const near=(a,b)=>assert(Math.abs(a-b)<b*1e-8);
  let initial;
  await t.test('React 系统入口与本地静态依赖完整，禁止任意文件读取和外部脚本',async()=>{
    const index=await fetch(f.base+'/'),html=await index.text();assert.match(html,/id="root"/);assert.match(html,/\/assets\/app.js/);assert.match(index.headers.get('content-security-policy'),/script-src 'self';/);
    for(const [name,mime] of [['app.js','text/javascript'],['app.css','text/css']]){const response=await fetch(f.base+'/assets/'+name);assert.equal(response.status,200);assert(response.headers.get('content-type').startsWith(mime));assert((await response.text()).length>1000);}
    for(const name of ['monitor.cjs','config.json','../data/events.jsonl'])assert.equal((await fetch(f.base+'/assets/'+name)).status,404);
  });
  await t.test('无需手动样本，全部历史自动生成单区间和综合额度',async()=>{
    initial=await get();assert.equal(initial.schemaVersion,5);assert.equal(initial.samples.length,0);
    assert.equal(initial.monthlyCapacity.overall.observations,12);near(initial.monthlyCapacity.overall.monthlyTokens,10000000);
    assert.equal(initial.monthlyCapacity.overall.calls,12);assert(initial.monthlyCapacity.overall.confidence.score<=60);
    assert.equal(initial.monthlyCapacity.latest.status,'pending');assert.equal(initial.monthlyCapacity.latestEstimate.calls,1);
    assert.equal(initial.monthlyCapacity.modelEstimates[0].thinking,'high');near(initial.monthlyCapacity.modelEstimates[0].monthlyTokens,10000000);
    assert.equal(initial.activity.all.summary.calls,12);assert.equal(initial.activity.code.summary.knownTokens,120000);assert.equal(initial.activity.work.summary.calls,0);assert.equal(initial.activity.all.heatmap.days.length,371);
  });
  await t.test('采集新调用和额度后自动重算，不依赖开始/结束采样',async()=>{
    await wait(10);const time=Date.now();
    fs.appendFileSync(f.wire,JSON.stringify({type:'llm.request',time,thinkingEffort:'high'})+'\n'+JSON.stringify({type:'usage.record',time,model:'kimi-code/k3.1-pro',usageScope:'turn',usage:{inputOther:1000,inputCacheRead:7000,inputCacheCreation:500,output:1500}})+'\n');
    f.setState({used:.113});assert.equal((await post('/api/refresh')).status,200);
    const r=await get();assert.equal(r.coverage.records,13);assert.equal(r.samples.length,0);assert.equal(r.monthlyCapacity.overall.observations,13);assert.equal(r.monthlyCapacity.overall.calls,13);near(r.monthlyCapacity.overall.monthlyTokens,10000000);
    assert.equal(r.monthlyCapacity.latestEstimate.inputOther,1000);assert.equal(r.monthlyCapacity.latestEstimate.cacheRead,7000);
  });
  await t.test('JSON、离线报告与完整 CSV 一致，状态与构成字段完整',async()=>{
    const r=await get(),disk=JSON.parse(fs.readFileSync(f.dir+'/reports/report.json'));near(disk.monthlyCapacity.overall.monthlyTokens,r.monthlyCapacity.overall.monthlyTokens);
    const html=fs.readFileSync(f.dir+'/reports/report.html','utf8');assert.match(html,/月 token 总额度推算/);assert.match(html,/10,000,000/);assert.match(html,/缓存写入/);
    const response=await fetch(f.base+'/export/capacity.csv');assert.equal(response.status,200);const csv=await response.text();
    for(const field of ['monthlyTokens','confidenceScore','inputOtherShare','cacheReadMonthlyTokens','cacheWriteShare','outputMonthlyTokens'])assert(csv.includes(field));
    assert(csv.includes('estimated'));assert(csv.includes('pending'));assert.equal(csv.trim().split('\n').length,r.monthlyCapacity.observations.length+1);
    const models=await fetch(f.base+'/export/models.csv');assert.equal(models.status,200);const modelCsv=await models.text();assert.match(modelCsv,/rawModel,thinking,band/);assert.match(modelCsv,/K3.1 Pro/);assert.match(modelCsv,/"high"/);
    assert.match(csv,/confidencePercent/);const activityCsv=await fetch(f.base+'/export/activity.csv');assert.equal(activityCsv.status,200);assert.match(await activityCsv.text(),/date,source,calls/);
  });
  await t.test('查询失败保留最后真实额度，推算不伪造新记录',async()=>{
    const before=await get();f.setState({used:.8,fail:true});await post('/api/refresh');const r=await get();assert.equal(r.status.workQuota.ok,false);
    assert.equal(r.monthly.time,before.monthly.time);assert.equal(r.monthly.used,.113);assert.equal(r.monthlyCapacity.observations.length,before.monthlyCapacity.observations.length);
    near(r.monthlyCapacity.overall.monthlyTokens,before.monthlyCapacity.overall.monthlyTokens);f.setState({used:.113});await post('/api/refresh');
  });
  await t.test('逐次调用明细真实分页、产品和时间筛选，参数错误明确返回',async()=>{
    const response=await fetch(f.base+'/api/events?size=5&page=2&source=code&q=K3.1');assert.equal(response.status,200);const h=await response.json();assert.equal(h.total,13);assert.equal(h.records.length,5);assert.equal(h.page,2);assert(h.records.every(e=>e.source==='code'));
    assert.equal((await fetch(f.base+'/api/events?source=work').then(r=>r.json())).total,0);
    const r=await get(),from=r.coverage.first,to=r.coverage.last;
    assert.equal((await fetch(f.base+`/api/events?from=${from}&to=${to}`).then(r=>r.json())).total,13);
    const defaults=await fetch(f.base+'/api/events').then(r=>r.json());assert.equal(defaults.size,10);assert.equal(defaults.records.length,10);
    for(const query of ['size=4','size=101','page=0','source=unknown','from=2&to=1'])assert.equal((await fetch(f.base+'/api/events?'+query)).status,400);
  });
  await t.test('自选时间段真实接口返回覆盖时间、构成与用户隔离确认',async()=>{
    const first=initial.monthlyCapacity.overall.start,last=initial.monthlyCapacity.overall.end;
    const response=await fetch(f.base+`/api/capacity?from=${first}&to=${last}&exclusive=true`);assert.equal(response.status,200);const c=await response.json();assert.equal(c.selection.exclusiveAttested,true);assert.equal(c.overall.calls,12);near(c.overall.monthlyTokens,10000000);assert.equal(c.overall.composition.length,4);
    assert.equal(c.overall.start,first);assert.equal(c.overall.end,last);
    const saved=await post('/api/analysis/range',{from:first,to:last,exclusive:true});assert.equal(saved.status,200);assert((await saved.json()).savedRangeId);
    const db=new DatabaseSync(f.dir+'/data/usage.sqlite',{readOnly:true});try{const row=db.prepare('SELECT * FROM analysis_ranges').get();assert.equal(row.exclusive_attested,1);assert.equal(row.from_at,first);}finally{db.close();}
    assert.equal((await fetch(f.base+'/api/capacity')).status,400);assert.equal((await fetch(f.base+'/api/capacity?from=2&to=1')).status,400);
    const empty=await fetch(f.base+`/api/capacity?from=0&to=1`).then(r=>r.json());assert.equal(empty.overall,null);
  });
  await t.test('真实接口启动、结束并自动完成样本结算，日常自动监控继续生效',async()=>{
    // Advance only this synthetic server's clock; no wall-clock wait or real client activity.
    const base=Date.now()+40000;f.setState({used:.113,now:base});await post('/api/refresh');
    let r=await post('/api/sample/start',{source:'code',label:'自动化测试',exclusive:true});assert.equal(r.status,200);const id=(await r.json()).id;
    fs.appendFileSync(f.wire,JSON.stringify({type:'llm.request',time:base+1000,thinkingEffort:'high'})+'\n'+JSON.stringify({type:'usage.record',time:base+2000,model:'kimi-code/k3.1-pro',usage:{inputOther:1000,inputCacheRead:7000,inputCacheCreation:500,output:1500}})+'\n');
    f.setState({used:.113,now:base+10000});r=await post('/api/sample/end',{id});assert.equal(r.status,200);assert.equal((await get()).samples[0].result.status,'settling');
    f.setState({used:.114,now:base+71000});await post('/api/refresh');assert.equal((await get()).samples[0].result.status,'settling');
    f.setState({used:.114,now:base+101000});await post('/api/refresh');const settled=await get();assert.equal(settled.samples[0].result.status,'accepted');assert.equal(settled.samples[0].result.total,10000);near(settled.monthlyCapacity.overall.monthlyTokens,10000000);
  });
  await t.test('SQLite 真实会话接口关联用户与助手，并可下载完整独立分析数据库',async()=>{
    const time=Date.now()+160000;f.setState({used:.114,now:time+4});
    const rows=[{type:'turn.prompt',turnId:999,promptId:'synthetic-conversation',time,input:[{type:'text',text:'SYNTHETIC_VISIBLE_QUESTION'}]},
      {type:'llm.request',time:time+1,model:'kimi-code/k3.1-pro',thinkingEffort:'high'},
      {type:'usage.record',time:time+2,model:'kimi-code/k3.1-pro',usage:{inputOther:10,inputCacheRead:20,inputCacheCreation:0,output:5}},
      {type:'agent.message.appended',time:time+3,message:{message:{role:'assistant',content:[{type:'think',think:'SYNTHETIC_HIDDEN_REASONING'},{type:'text',text:'SYNTHETIC_VISIBLE_ANSWER'}]},meta:{messageId:'synthetic-answer'}}}];
    fs.appendFileSync(f.wire,rows.map(JSON.stringify).join('\n')+'\n');await post('/api/refresh');const report=await get();assert(report.sqlite.conversation_messages>=2);
    const h=await fetch(f.base+'/api/events').then(r=>r.json()),e=h.records[0];
    const response=await fetch(f.base+`/api/conversation?source=${e.source}&session=${e.session}&agent=${e.agent}`);assert.equal(response.status,200);const c=await response.json();assert.equal(c.messages.length,2);assert.equal(c.messages[0].turn_id,e.turnId);assert.equal(c.messages[1].request_id,e.requestId);assert(!JSON.stringify(c).includes('SYNTHETIC_HIDDEN_REASONING'));
    assert.equal((await fetch(f.base+'/api/conversation?source=other&session=x')).status,400);
    const download=await fetch(f.base+'/export/usage.sqlite');assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/usage-analysis.sqlite/);const file=f.dir+'/download.sqlite';fs.writeFileSync(file,Buffer.from(await download.arrayBuffer()));
    const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n,2);assert(db.prepare('SELECT COUNT(*) n FROM capacity_estimates').get().n>0);}finally{db.close();}
  });
  await t.test('不打开网页、不调用刷新接口，后台五秒内自动保存新增调用及 SQLite 快照',async()=>{
    const before=JSON.parse(fs.readFileSync(f.dir+'/reports/report.json')),time=Date.now()+170000;
    f.setState({used:.114,now:time});fs.appendFileSync(f.wire,JSON.stringify({type:'usage.record',time,model:'kimi-code/k3.1-pro',usage:{inputOther:10,inputCacheRead:20,inputCacheCreation:0,output:5}})+'\n');
    await wait(5500);const saved=JSON.parse(fs.readFileSync(f.dir+'/reports/report.json'));assert.equal(saved.settings.updateIntervalSeconds,5);assert.equal(saved.settings.quotaPollSeconds,30);assert.equal(saved.coverage.records,before.coverage.records+1);assert(saved.generatedAt>before.generatedAt);
    assert(saved.monthlyCapacity.coverage.pendingCalls>=1);
    const db=new DatabaseSync(f.dir+'/data/usage.sqlite',{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,saved.coverage.records);assert(db.prepare("SELECT COUNT(*) n FROM collection_runs WHERE trigger='automatic'").get().n>=1);assert(db.prepare('SELECT COUNT(*) n FROM activity_metrics').get().n>0);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
  });
});
