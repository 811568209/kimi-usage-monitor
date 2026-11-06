'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite'),{Collector}=require('../lib/collector.cjs'),M=require('../lib/metrics.cjs');
const {monthlyCapacity}=require('../lib/monthly-capacity.cjs');
function fixture(t,collectConversationContent=true){
  const temp=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(temp,'kimi-sqlite-test-'));
  t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),temp);assert.match(path.basename(resolved),/^kimi-sqlite-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const config={codeHome:dir+'/code',workHome:dir+'/work',workApp:dir+'/app',collectConversationContent};
  const wire=dir+'/code/sessions/wd-test/session-one/agents/main/wire.jsonl';fs.mkdirSync(path.dirname(wire),{recursive:true});
  const time=Date.now()-10000,rows=[
    {type:'turn.prompt',turnId:42,promptId:'synthetic-prompt',agentId:'main',time,input:[{type:'text',text:'SYNTHETIC_USER_MESSAGE'}]},
    {type:'agent.turn.started',turnId:42,time:time+1},
    {type:'llm.request',time:time+2,model:'kimi-code/k3.1-pro',thinkingEffort:'high',turnStep:'synthetic-step',messageCount:1,systemPrompt:'DO_NOT_STORE_SYSTEM'},
    {type:'usage.record',time:time+3,model:'kimi-code/k3.1-pro',usage:{inputOther:10,inputCacheRead:20,inputCacheCreation:0,output:5}},
    {type:'agent.message.appended',time:time+4,message:{message:{role:'assistant',content:[{type:'think',think:'DO_NOT_STORE_REASONING'},{type:'text',text:'SYNTHETIC_ASSISTANT_REPLY'}]},meta:{messageId:'synthetic-response'}}},
    {type:'agent.message.appended',time:time+5,message:{message:{role:'tool',content:[{type:'text',text:'DO_NOT_STORE_TOOL_OUTPUT'}]}}}
  ];fs.writeFileSync(wire,rows.map(JSON.stringify).join('\n')+'\n');
  const c=new Collector(config,dir+'/data');
  const sql=fn=>{const db=new DatabaseSync(dir+'/data/usage.sqlite',{readOnly:true});try{return fn(db);}finally{db.close();}};
  return {dir,c,config,wire,rows,sql};
}
test('SQLite 自动建表、逐次用量去重、NULL 缓存与会话请求关联',async t=>{
  const f=fixture(t);await f.c.scan(false);await f.c.scan(false);
  f.sql(db=>{
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n,1);
    const row=db.prepare('SELECT * FROM usage_events').get();assert.equal(row.total_tokens,35);assert(row.request_id);assert(row.turn_id);
    const messages=db.prepare('SELECT * FROM conversation_messages ORDER BY occurred_at').all();assert.deepEqual(messages.map(m=>m.role),['user','assistant']);
    assert.equal(messages[0].turn_id,row.turn_id);assert.equal(messages[1].request_id,row.request_id);assert.match(messages[1].association_basis,/wire-request-order/);
    const serialized=JSON.stringify(messages);assert(serialized.includes('SYNTHETIC_ASSISTANT_REPLY'));
    for(const hidden of ['DO_NOT_STORE_REASONING','DO_NOT_STORE_TOOL_OUTPUT','DO_NOT_STORE_SYSTEM'])assert(!serialized.includes(hidden));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events u JOIN requests r ON u.request_id=r.id JOIN conversation_messages m ON m.request_id=r.id').get().n,1);
  });
  const e=[...f.c.events.values()][0];assert.equal(f.c.store.conversation(e.source,e.session,e.agent).messages.length,2);
});
test('SQLite 保留历史缓存 NULL，不将未知当作零',async t=>{
  const f=fixture(t);delete f.rows[3].usage.inputCacheRead;fs.writeFileSync(f.wire,f.rows.map(JSON.stringify).join('\n')+'\n');await f.c.scan(false);
  f.sql(db=>{const row=db.prepare('SELECT cache_read_tokens,total_tokens FROM usage_events').get();assert.equal(row.cache_read_tokens,null);assert.equal(row.total_tokens,null);const day=db.prepare('SELECT * FROM v_daily_usage').get();assert.equal(day.unknown_calls,1);assert.equal(day.known_total_tokens,15);assert.equal(day.total_tokens,null);});
});
test('关闭正文采集后仍保存消息元数据、长度及用量关联',async t=>{
  const f=fixture(t,false);await f.c.scan(false);f.sql(db=>{const rows=db.prepare('SELECT content_text,content_chars,content_status FROM conversation_messages').all();assert.equal(rows.length,2);assert(rows.every(r=>r.content_text===null&&r.content_chars>0&&r.content_status==='content-disabled'));});
});
test('客户端及 JSONL 被清理后，SQLite 独立恢复历史用量和会话',async t=>{
  const f=fixture(t);await f.c.scan(false);const original=[...f.c.events.values()][0];fs.unlinkSync(f.wire);fs.unlinkSync(f.dir+'/data/events.jsonl');
  const restored=new Collector(f.config,f.dir+'/data');const r=await restored.scan(false);assert.equal(r.events.length,1);assert.equal(r.events[0].id,original.id);assert(r.events[0].requestId);
  assert.equal(restored.store.conversation(original.source,original.session,original.agent).messages.length,2);
});
test('旧 JSONL 自动迁移幂等，旧记录扫描后补上请求与轮次关联',async t=>{
  const f=fixture(t),old=M.parseUsage(f.rows[3],{source:'code',session:'session-one',agentPath:'agents/main/wire.jsonl',line:3},{time:f.rows[2].time,thinkingEffort:'high'});
  fs.writeFileSync(f.dir+'/data/events.jsonl',JSON.stringify(old)+'\n');const c=new Collector(f.config,f.dir+'/data');await c.scan(false);
  f.sql(db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);assert(db.prepare('SELECT request_id FROM usage_events').get().request_id);});
});
test('数据库和 JSONL 镜像在保存异常时回滚，恢复后可重试',async t=>{
  const f=fixture(t),save=fs.appendFileSync;fs.appendFileSync=()=>{throw Error('synthetic write failure');};try{await assert.rejects(f.c.scan(false),/write failure/);}finally{fs.appendFileSync=save;}
  f.sql(db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,0));await f.c.scan(false);f.sql(db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1));
});
test('每次采集保留独立快照和推算，不重复累计逐次调用',async t=>{
  const f=fixture(t),data=await f.c.scan(false);
  const report={generatedAt:Date.now(),settings:{updateIntervalSeconds:5,quotaPollSeconds:30},coverage:{records:data.events.length},groups:M.aggregate(data.events),status:data.status,monthlyCapacity:monthlyCapacity(data.events,data.snapshots)};
  f.c.store.recordRun(report,report.generatedAt-1,'automatic',[]);report.generatedAt+=5000;f.c.store.recordRun(report,report.generatedAt-1,'automatic',[]);
  f.sql(db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_runs').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_totals').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);assert.equal(db.prepare('SELECT SUM(total_tokens) n FROM usage_events').get().n,35);});
});
test('在线一致性备份可独立读取，包含会话与用量且完整性检查通过',async t=>{
  const f=fixture(t);await f.c.scan(false);const target=f.dir+'/analysis.sqlite';await f.c.store.backupTo(target);
  const db=new DatabaseSync(target,{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);}finally{db.close();}
});
