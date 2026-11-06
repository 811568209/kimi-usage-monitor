'use strict';
const fs=require('node:fs'),path=require('node:path');
let DatabaseSync,backup;
try{({DatabaseSync,backup}=require('node:sqlite'));}catch{throw Error('SQLite 存储需要 Node.js 24 或以上，请更新 Node.js 后启动');}
const SCHEMA_VERSION=1;
const nullable=values=>values.map(v=>v===undefined?null:v);
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
class UsageDatabase{
  constructor(dir){
    fs.mkdirSync(dir,{recursive:true});this.file=path.join(dir,'usage.sqlite');
    this.withDb(db=>{
      db.exec('PRAGMA journal_mode=WAL');
      const version=db.prepare('PRAGMA user_version').get().user_version;
      if(version>SCHEMA_VERSION)throw Error('数据库版本比当前程序更新，请使用新版监控');
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_events(
          id TEXT PRIMARY KEY,source TEXT NOT NULL,session_id TEXT,agent_id TEXT,occurred_at INTEGER NOT NULL,
          requested_at INTEGER,request_id TEXT,turn_id TEXT,model TEXT,raw_model TEXT,thinking TEXT,context_band TEXT,
          scope TEXT,auxiliary TEXT,input_other_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,
          input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,record_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS usage_time ON usage_events(occurred_at);
        CREATE INDEX IF NOT EXISTS usage_dimensions ON usage_events(source,raw_model,thinking,context_band,occurred_at);
        CREATE INDEX IF NOT EXISTS usage_conversation ON usage_events(source,session_id,agent_id,turn_id,request_id);
        CREATE TABLE IF NOT EXISTS quota_snapshots(id TEXT PRIMARY KEY,source TEXT,kind TEXT,observed_at INTEGER,
          used_ratio REAL,reset_at TEXT,plan TEXT,account_hash TEXT,quantum REAL,record_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS quota_time ON quota_snapshots(source,kind,observed_at);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,source TEXT,session_id TEXT,agent_id TEXT,turn_id TEXT,
          requested_at INTEGER,model TEXT,thinking TEXT,turn_step TEXT,message_count INTEGER,association_basis TEXT);
        CREATE TABLE IF NOT EXISTS conversation_messages(id TEXT PRIMARY KEY,source TEXT,session_id TEXT,agent_id TEXT,
          turn_id TEXT,request_id TEXT,occurred_at INTEGER,role TEXT,content_text TEXT,content_chars INTEGER,
          association_basis TEXT,content_status TEXT);
        CREATE INDEX IF NOT EXISTS message_session ON conversation_messages(source,session_id,agent_id,occurred_at);
        CREATE TABLE IF NOT EXISTS collection_runs(id INTEGER PRIMARY KEY,started_at INTEGER,completed_at INTEGER,
          trigger TEXT,local_interval_seconds INTEGER,quota_interval_seconds INTEGER,event_count INTEGER,quota_count INTEGER,
          status_json TEXT,settings_json TEXT);
        CREATE TABLE IF NOT EXISTS usage_totals(run_id INTEGER REFERENCES collection_runs(id),source TEXT,model TEXT,
          thinking TEXT,calls INTEGER,input_other_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,
          output_tokens INTEGER,total_tokens INTEGER,known_total_tokens INTEGER,unknown_calls INTEGER,
          PRIMARY KEY(run_id,source,model,thinking));
        CREATE TABLE IF NOT EXISTS quota_intervals(id TEXT PRIMARY KEY,group_id TEXT,source TEXT,start_at INTEGER,end_at INTEGER,
          status TEXT,delta_percent REAL,total_tokens INTEGER,known_total_tokens INTEGER,monthly_tokens REAL,
          confidence_score INTEGER,record_json TEXT);
        CREATE TABLE IF NOT EXISTS capacity_estimates(run_id INTEGER REFERENCES collection_runs(id),estimate_key TEXT,
          scope TEXT,group_id TEXT,source TEXT,model TEXT,thinking TEXT,context_band TEXT,status TEXT,start_at INTEGER,end_at INTEGER,
          calls INTEGER,delta_percent REAL,monthly_tokens REAL,range_lower REAL,range_upper REAL,confidence_score INTEGER,
          confidence_level TEXT,evidence_json TEXT,PRIMARY KEY(run_id,estimate_key));
        CREATE TABLE IF NOT EXISTS samples(id TEXT PRIMARY KEY,updated_at INTEGER,record_json TEXT);
        CREATE TABLE IF NOT EXISTS analysis_ranges(id TEXT PRIMARY KEY,from_at INTEGER,to_at INTEGER,exclusive_attested INTEGER,
          created_at INTEGER,analyzed_at INTEGER,result_json TEXT);
        CREATE TABLE IF NOT EXISTS activity_metrics(run_id INTEGER REFERENCES collection_runs(id),source TEXT,summary_json TEXT,PRIMARY KEY(run_id,source));
        CREATE VIEW IF NOT EXISTS v_daily_usage AS SELECT date(occurred_at/1000,'unixepoch','+8 hours') AS local_date,
          source,model,raw_model,thinking,context_band,COUNT(*) AS calls,SUM(input_other_tokens) AS input_other_tokens,
          SUM(cache_read_tokens) AS known_cache_read_tokens,SUM(cache_write_tokens) AS known_cache_write_tokens,
          SUM(output_tokens) AS output_tokens,SUM(input_other_tokens+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+output_tokens) AS known_total_tokens,
          SUM(total_tokens IS NULL) AS unknown_calls,CASE WHEN SUM(total_tokens IS NULL)>0 THEN NULL ELSE SUM(total_tokens) END AS total_tokens
          FROM usage_events GROUP BY local_date,source,model,raw_model,thinking,context_band;
        PRAGMA user_version=1;
      `);
    });
  }
  open(readOnly=false){const db=new DatabaseSync(this.file,{readOnly});db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');return db;}
  withDb(fn,readOnly=false){const db=this.open(readOnly);try{return fn(db);}finally{db.close();}}
  insert(db,row,type,update=false){
    if(type==='events'){
      const values=nullable([row.id,row.source,row.session,row.agent,row.time,row.requestedAt,row.requestId,row.turnId,row.model,row.rawModel,row.thinking,row.contextBand,row.scope,row.auxiliary,row.inputOther,row.cacheRead,row.cacheWrite,row.input,row.output,row.total,JSON.stringify(row)]);
      db.prepare(`INSERT ${update?'OR REPLACE':'OR IGNORE'} INTO usage_events VALUES(${values.map(()=>'?').join(',')})`).run(...values);
    }else{
      db.prepare('INSERT OR IGNORE INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(...nullable([row.id,row.source,row.kind,row.time,row.used,row.resetAt,row.plan,row.account,row.quantum,JSON.stringify(row)]));
    }
  }
  importRows(events,snapshots){this.withDb(db=>transaction(db,()=>{for(const r of events)this.insert(db,r,'events');for(const r of snapshots)this.insert(db,r,'quota');}));}
  load(){return this.withDb(db=>({events:db.prepare('SELECT record_json FROM usage_events ORDER BY occurred_at').all().map(r=>JSON.parse(r.record_json)),snapshots:db.prepare('SELECT record_json FROM quota_snapshots ORDER BY observed_at').all().map(r=>JSON.parse(r.record_json))}),true);}
  save(row,type,mirror,update=false){return this.withDb(db=>transaction(db,()=>{this.insert(db,row,type,update);if(mirror)mirror();}));}
  saveConversation(requests,messages){if(!requests.length&&!messages.length)return;
    this.withDb(db=>transaction(db,()=>{
      const request=db.prepare('INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const message=db.prepare('INSERT INTO conversation_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET request_id=COALESCE(conversation_messages.request_id,excluded.request_id),turn_id=COALESCE(conversation_messages.turn_id,excluded.turn_id),content_text=COALESCE(excluded.content_text,conversation_messages.content_text),content_chars=excluded.content_chars,content_status=CASE WHEN excluded.content_text IS NULL THEN conversation_messages.content_status ELSE excluded.content_status END WHERE (conversation_messages.request_id IS NULL AND excluded.request_id IS NOT NULL) OR (conversation_messages.turn_id IS NULL AND excluded.turn_id IS NOT NULL) OR (conversation_messages.content_text IS NULL AND excluded.content_text IS NOT NULL)');
      for(const r of requests)request.run(...nullable([r.id,r.source,r.session,r.agent,r.turnId,r.time,r.model,r.thinking,r.turnStep,r.messageCount,r.associationBasis]));
      for(const m of messages)message.run(...nullable([m.id,m.source,m.session,m.agent,m.turnId,m.requestId,m.time,m.role,m.text,m.chars,m.associationBasis,m.contentStatus]));
    }));
  }
  recordRun(report,startedAt,trigger,samples){
    return this.withDb(db=>transaction(db,()=>{
      const id=Number(db.prepare('INSERT INTO collection_runs(started_at,completed_at,trigger,local_interval_seconds,quota_interval_seconds,event_count,quota_count,status_json,settings_json) VALUES(?,?,?,?,?,?,?,?,?)').run(startedAt,report.generatedAt,trigger,report.settings.updateIntervalSeconds,report.settings.quotaPollSeconds,report.coverage.records,db.prepare('SELECT COUNT(*) AS n FROM quota_snapshots').get().n,JSON.stringify(report.status),JSON.stringify(report.settings)).lastInsertRowid);
      const total=db.prepare('INSERT INTO usage_totals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const g of report.groups)total.run(...nullable([id,g.source,g.model,g.thinking,g.calls,g.inputOther,g.cacheRead,g.cacheWrite,g.output,g.total,g.knownTotal,g.unknown]));
      const interval=db.prepare('INSERT OR REPLACE INTO quota_intervals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const o of report.monthlyCapacity.observations)interval.run(...nullable([o.id,o.groupId,o.source,o.start,o.end,o.status,o.deltaPercent,o.total,o.knownTotal,o.monthlyTokens,o.confidence.score,JSON.stringify(o)]));
      const estimate=db.prepare('INSERT INTO capacity_estimates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const rows=[...(report.monthlyCapacity.overall?[{...report.monthlyCapacity.overall,scope:'overall',key:'overall',groupId:report.monthlyCapacity.overall.id}]:[]),...report.monthlyCapacity.modelEstimates.filter(m=>m.groupId===report.monthlyCapacity.overall?.id).map(m=>({...m,scope:'model',key:JSON.stringify([m.source,m.rawModel,m.thinking,m.band])}))];
      for(const r of rows)estimate.run(...nullable([id,r.key,r.scope,r.groupId,r.source,r.model,r.thinking,r.band,r.status,r.start,r.end,r.calls,r.deltaPercent,r.monthlyTokens,r.range?.lower,r.range?.upper,r.confidence.score,r.confidence.level,JSON.stringify(r)]));
      if(report.activity){const metric=db.prepare('INSERT INTO activity_metrics VALUES(?,?,?)');for(const [source,a] of Object.entries(report.activity))metric.run(id,source,JSON.stringify(a.summary));}
      const sample=db.prepare('INSERT OR REPLACE INTO samples VALUES(?,?,?)');for(const s of samples)sample.run(s.id,report.generatedAt,JSON.stringify(s));
      return {path:'data/usage.sqlite',schemaVersion:SCHEMA_VERSION,lastRunId:id,lastWrittenAt:report.generatedAt,...this.counts(db)};
    }));
  }
  counts(db){return Object.fromEntries(['usage_events','quota_snapshots','collection_runs','requests','conversation_messages','capacity_estimates'].map(table=>[table,db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));}
  saveAnalysisRange(id,range,result){const now=Date.now();this.withDb(db=>db.prepare('INSERT INTO analysis_ranges VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET analyzed_at=excluded.analyzed_at,result_json=excluded.result_json').run(id,range.from,range.to,range.exclusiveAttested?1:0,now,now,JSON.stringify(result)));return id;}
  conversation(source,session,agent){return this.withDb(db=>({
    messages:db.prepare('SELECT * FROM conversation_messages WHERE source=? AND session_id=? AND agent_id=? ORDER BY occurred_at,id').all(source,session,agent),
    requests:db.prepare('SELECT * FROM requests WHERE source=? AND session_id=? AND agent_id=? ORDER BY requested_at').all(source,session,agent),
    usage:db.prepare('SELECT record_json FROM usage_events WHERE source=? AND session_id=? AND agent_id=? ORDER BY occurred_at').all(source,session,agent).map(r=>JSON.parse(r.record_json))
  }),true);}
  async backupTo(file){const db=this.open(true);try{await backup(db,file);}finally{db.close();}return file;}
}
module.exports={UsageDatabase,SCHEMA_VERSION};
