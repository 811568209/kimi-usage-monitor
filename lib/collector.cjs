'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const M=require('./metrics.cjs');
const {WorkQuotaClient}=require('./work-quota.cjs');
const {UsageDatabase}=require('./database.cjs');
const C=require('./conversations.cjs');
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function list(dir){try{return fs.readdirSync(dir,{withFileTypes:true});}catch{return [];}}
function wireFiles(root){const found=[];function walk(dir,depth){if(depth>8)return;for(const e of list(dir)){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isFile()&&e.name==='wire.jsonl')found.push(p);else if(e.isDirectory()&&!['tasks','file-history','logs','notify','.index-cache'].includes(e.name))walk(p,depth+1);}}walk(root,0);return found;}
function defaultConfig(){const roaming=process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming');return {codeHome:process.env.KIMI_CODE_HOME||path.join(os.homedir(),'.kimi-code'),workHome:path.join(roaming,'kimi-desktop','daimon-share','daimon','runtime','kimi-code','home'),workApp:path.join(roaming,'kimi-desktop'),logUtcOffset:'+08:00',intervalSeconds:5,quotaPollSeconds:30,sampleMaxAgeSeconds:300,port:17891};}
class Collector{
  constructor(config,dir){this.config=config;this.dir=dir;fs.mkdirSync(dir,{recursive:true});this.events=new Map();this.snapshots=new Map();this.files=new Map();this.status={};this.lastPoll=0;this.lastWorkPoll=0;this.workQuota=new WorkQuotaClient(config.workApp);
    for(const [file,target] of [['events.jsonl',this.events],['quota.jsonl',this.snapshots]]){try{let text=fs.readFileSync(path.join(dir,file),'utf8');
      if(text&&!text.endsWith('\n')){const boundary=text.lastIndexOf('\n')+1;try{JSON.parse(text.slice(boundary));text+='\n';}catch{text=text.slice(0,boundary);}fs.writeFileSync(path.join(dir,file),text);}
      for(const line of text.split('\n')){try{const row=JSON.parse(line);if(row.id)target.set(row.id,row);}catch{}}}catch{}}
    this.store=new UsageDatabase(dir);this.store.importRows([...this.events.values()],[...this.snapshots.values()]);
    const saved=this.store.load();for(const e of saved.events)this.events.set(e.id,e);for(const s of saved.snapshots)this.snapshots.set(s.id,s);
    const lastMonth=[...this.snapshots.values()].filter(s=>s.source==='kimi-membership-api').sort((a,b)=>a.time-b.time).at(-1);
    if(lastMonth)this.status.workQuota={ok:false,lastSuccessAt:lastMonth.time,reason:'等待本轮会员接口查询'};
    const lastCode=[...this.snapshots.values()].filter(s=>s.source==='code-local-api').sort((a,b)=>a.time-b.time).at(-1);
    if(lastCode)this.status.codeQuota={ok:false,time:lastCode.time,reason:'等待本轮 Code 额度查询'};
  }
  save(row,type){const map=type==='events'?this.events:this.snapshots,previous=map.get(row.id);
    if(previous){if(type==='events'&&((!previous.requestId&&row.requestId)||(!previous.turnId&&row.turnId))){const enriched={...previous,requestId:previous.requestId||row.requestId,turnId:previous.turnId||row.turnId,associationBasis:row.associationBasis};this.store.save(enriched,type,null,true);map.set(row.id,enriched);}return;}
    this.store.save(row,type,()=>fs.appendFileSync(path.join(this.dir,`${type}.jsonl`),JSON.stringify(row)+'\n'));map.set(row.id,row);
  }
  changed(file){try{const s=fs.statSync(file),key=`${s.size}:${s.mtimeMs}`;if(this.files.get(file)===key)return false;if(s.size>512*1024*1024){this.status.largeFile=true;return false;}this.files.set(file,key);return true;}catch{return false;}}
  catalog(){const cache=readJson(path.join(this.config.workApp,'kimi-agent','kimi-work-models-cache.json'))||{},result={};for(const entry of Object.values(cache)){for(const model of [...(entry.models||[]),...(entry.moreModels||[])]){if(typeof model.displayName!=='string')continue;for(const key of [model.key,model.modelId,model.modelAlias])if(typeof key==='string')result[key]=model.displayName;}}return result;}
  scanWires(source,home,catalog){const root=path.join(home,'sessions'),files=wireFiles(root);let invalid=0;
    for(const file of files){if(!this.changed(file))continue;let text;try{text=fs.readFileSync(file,'utf8');}catch{this.files.delete(file);continue;}
      const parts=path.relative(root,file).split(path.sep),session=parts[1]||parts[0],agentPath=parts.slice(2).join('/');
      const lines=text.split('\n');if(!text.endsWith('\n'))lines.pop();let request={},currentTurn=null;const requests=[],messages=[],fileAgent=path.basename(path.dirname(file));
      for(let line=0;line<lines.length;line++){let r;try{r=JSON.parse(lines[line]);}catch{if(lines[line].trim())invalid++;continue;}
        const agent=String(r.agentId||fileAgent||'main'),meta={source,session,agent,agentPath,line};
        if(['turn.prompt','agent.turn.started'].includes(r.type)){currentTurn=C.turnId(meta,r.turnId);request={};}
        if(r.type==='llm.request'){
          request={id:M.id(JSON.stringify([source,session,agent,agentPath,line,r.time])),time:r.time,thinkingEffort:r.thinkingEffort,turnId:currentTurn};
          if(Number.isFinite(r.time))requests.push({id:request.id,source,session:M.id(session),agent,turnId:currentTurn,time:r.time,model:r.model,thinking:r.thinkingEffort,turnStep:r.turnStep,messageCount:r.messageCount,associationBasis:'same-agent-canonical-wire-order'});
          continue;
        }
        const message=C.message(r,meta,{turnId:currentTurn,request},this.config.collectConversationContent!==false);if(message)messages.push(message);
        if(r.type!=='usage.record')continue;
        const event=M.parseUsage(r,meta,request,catalog);if(event){try{this.save(event,'events');}catch(error){this.files.delete(file);throw error;}}else invalid++;
      }
      try{this.store.saveConversation(requests,messages);}catch(error){this.files.delete(file);throw error;}
    }
    this.status[source]={files:files.length,exists:fs.existsSync(root),invalidRecordsInChangedFiles:invalid};
  }
  scanMonthly(){for(const name of ['main.old.log','main.log']){const file=path.join(this.config.workApp,'logs',name);if(!this.changed(file))continue;let text;try{text=fs.readFileSync(file,'utf8');}catch{this.files.delete(file);continue;}const lines=text.split('\n');if(!text.endsWith('\n'))lines.pop();for(const line of lines){const row=M.parseMonthlyLog(line,this.config.logUtcOffset);if(row)this.save(row,'quota');}}}
  async pollCode(){this.lastPoll=Date.now();const dir=path.join(this.config.codeHome,'server','instances');const instances=list(dir).filter(e=>e.isFile()&&e.name.endsWith('.json')).map(e=>readJson(path.join(dir,e.name))).filter(i=>i&&i.host==='127.0.0.1'&&Number.isInteger(i.port)&&i.port>0&&i.port<65536).sort((a,b)=>(b.heartbeat_at||0)-(a.heartbeat_at||0));
    if(!instances.length){this.status.codeQuota={...this.status.codeQuota,ok:false,reason:'Code 未运行，等待客户端启动'};return;}
    let token;try{token=fs.readFileSync(path.join(this.config.codeHome,'server.token'),'utf8').trim();}catch{this.status.codeQuota={...this.status.codeQuota,ok:false,reason:'无法读取 Code 本地服务凭据'};return;}
    if(!token){this.status.codeQuota={...this.status.codeQuota,ok:false,reason:'本地服务凭据为空'};return;}
    for(const instance of instances.slice(0,3)){try{
      if(Number.isInteger(instance.pid)){try{process.kill(instance.pid,0);}catch{continue;}}
      const response=await fetch(`http://127.0.0.1:${instance.port}/api/v1/oauth/usage`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!response.ok)continue;const body=await response.json();if(body?.data?.kind!=='ok')continue;
      const usages=body.data.quota?.usages||{};const now=Date.now();let received=0;
      for(const [key,kind] of [['limit5h','5h'],['limit7d','7d'],['monthTotal','month']]){const u=usages[key];if(!u||!Number.isFinite(u.usedRatio)||u.usedRatio<0||u.usedRatio>1)continue;const row={source:'code-local-api',kind,time:now,used:u.usedRatio,resetAt:u.resetAt||null,plan:'unknown',quantum:0.0001};row.id=M.id(JSON.stringify(row));this.save(row,'quota');received++;}
      if(!received)continue;
      this.status.codeQuota={ok:true,time:now,hasMonth:Boolean(usages.monthTotal)};return;
    }catch{}}
    this.status.codeQuota={...this.status.codeQuota,ok:false,reason:'Code 本地服务没有返回可用额度；请确认客户端已登录'};
  }
  async pollWork(){this.lastWorkPoll=Date.now();const result=await this.workQuota.poll();
    if(result.ok){this.save(result.snapshot,'quota');this.status.workQuota={ok:true,attemptedAt:result.attemptedAt,lastSuccessAt:result.snapshot.time,account:result.snapshot.account,membership:result.membership,provenance:result.provenance};}
    else this.status.workQuota={...this.status.workQuota,ok:false,attemptedAt:result.attemptedAt,reason:result.reason,httpStatus:result.httpStatus};
  }
  async scan(poll=true,force=false){const catalog=this.catalog();this.scanWires('code',this.config.codeHome,{});this.scanWires('work',this.config.workHome,catalog);this.scanMonthly();
    if(poll){const tasks=[];if(force||Date.now()-this.lastPoll>=this.config.quotaPollSeconds*1000)tasks.push(this.pollCode());if(force||Date.now()-this.lastWorkPoll>=this.config.quotaPollSeconds*1000)tasks.push(this.pollWork());const results=await Promise.allSettled(tasks);if(results.some(r=>r.status==='rejected'))this.status.queryError='某项额度查询未完成，保留最后成功读数';else delete this.status.queryError;}
    return {events:[...this.events.values()].sort((a,b)=>a.time-b.time),snapshots:[...this.snapshots.values()].sort((a,b)=>a.time-b.time),status:this.status};}
}
module.exports={Collector,defaultConfig,readJson,wireFiles};
