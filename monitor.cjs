'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {Collector,defaultConfig,readJson}=require('./lib/collector.cjs');
const M=require('./lib/metrics.cjs');
const {monthlyCapacity}=require('./lib/monthly-capacity.cjs');
const {rangeParams,usageHistory}=require('./lib/history.cjs');
const ROOT=__dirname, DATA=path.join(ROOT,'data'), REPORTS=path.join(ROOT,'reports');
fs.mkdirSync(DATA,{recursive:true});fs.mkdirSync(REPORTS,{recursive:true});
const config={...defaultConfig(),...(readJson(path.join(ROOT,'config.json'))||{})};
const nonce=crypto.randomBytes(24).toString('hex');
let collector,samples=readJson(path.join(DATA,'samples.json'))||[],report,scanning=null,server,timer,quotaTimer,port;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function atomic(file,text){const tmp=file+'.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);}
function saveSamples(){atomic(path.join(DATA,'samples.json'),JSON.stringify(samples,null,2));}
function csv(rows,fields){const cell=v=>{let s=v==null?'':String(v);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return '\ufeff'+[fields.join(','),...rows.map(r=>fields.map(k=>cell(r[k])).join(','))].join('\r\n');}
function snapshotSummary(snapshots){return Object.fromEntries(['5h','7d'].map(kind=>[kind,snapshots.filter(s=>s.kind===kind).at(-1)||null]));}
function modelCapacityHtml(c){
  const n=v=>v==null?'待积累可区分数据':Math.round(v).toLocaleString('zh-CN');
  return '<h2>按模型与档位推算</h2><p>产品、模型、思考档位与上下文区间分别计算；混用共享扣减不按 token 比例分摊。</p><table><tr><th>产品</th><th>模型</th><th>档位 / 上下文</th><th>记录调用</th><th>推算月 token</th><th>置信度</th><th>说明</th></tr>'+c.modelEstimates.filter(m=>m.groupId===c.overall?.id).map(m=>`<tr><td>${escape(m.source)}</td><td>${escape(m.model)}</td><td>${escape(m.thinking)} / ${escape(m.band)}</td><td>${m.observedCalls}</td><td>${n(m.monthlyTokens)}</td><td>${m.confidence.level} ${m.confidence.score}/100</td><td>${escape(m.reason)}</td></tr>`).join('')+'</table>';
}
function capacityHtml(capacity){
  const number=n=>n==null?'暂不可推算':Math.round(n).toLocaleString('zh-CN');
  const summary=x=>x?.monthlyTokens!=null?`${number(x.monthlyTokens)} token / 月；范围 ${number(x.range.lower)} — ${x.range.upper==null?'上限无法确定':number(x.range.upper)}；置信度 ${x.confidence.level}（${x.confidence.score}/100）`:'暂不可推算，等待可匹配的额度变化与完整 token 记录';
  const overall=capacity.overall;
  return `<h2>月 token 总额度推算</h2><p>最近可推算区间：${summary(capacity.latestEstimate)}</p><p>当前分段全部可用数据综合：${summary(overall)}</p><p>${escape(capacity.formula)}。${escape(capacity.assumption)}</p><p>本机共 ${capacity.coverage.localCalls} 条调用，当前分段已匹配 ${capacity.coverage.matchedCalls} 条，待结算 ${capacity.coverage.pendingCalls} 条；排除 ${capacity.coverage.excludedWindows} 个区间。</p><p>最新读数：${escape(capacity.latest?.reason||'等待起始读数')}；综合覆盖截至 ${overall?.end?escape(new Date(overall.end).toLocaleString('zh-CN')):'暂无'}。</p><p>${escape(capacity.confidenceNote)}</p><p>${escape(overall?.confidence.reasons?.join('；')||'')}</p><table><tr><th>构成</th><th>对应 token</th><th>占比</th><th>保持构成的月 token 分配</th></tr>${(overall?.composition||[]).map(c=>`<tr><td>${c.label}</td><td>${number(c.tokens)}</td><td>${c.share==null?'未知':(c.share*100).toFixed(2)+'%'}</td><td>${number(c.monthlyTokens)}</td></tr>`).join('')}</table><p>${escape(capacity.compositionNote)}</p><table><tr><th>采集时间</th><th>状态</th><th>对应 token</th><th>消耗百分点</th><th>推算月 token</th><th>说明</th></tr>${capacity.observations.slice(-20).reverse().map(o=>`<tr><td>${escape(new Date(o.end).toLocaleString('zh-CN'))}</td><td>${escape(o.status)}</td><td>${o.total==null?(o.knownTotal==null?'未知':'≥ '+number(o.knownTotal)):number(o.total)}</td><td>${o.deltaPercent==null?'未知':o.deltaPercent.toFixed(4)}</td><td>${number(o.monthlyTokens)}</td><td>${escape(o.reason)}</td></tr>`).join('')}</table>`;
}
function exportReport(data){
  atomic(path.join(REPORTS,'report.json'),JSON.stringify(report,null,2));
  atomic(path.join(REPORTS,'tokens.csv'),csv(data.events.map(e=>({...e,time:new Date(e.time).toISOString()})),['source','session','agent','time','model','rawModel','thinking','scope','auxiliary','inputOther','cacheRead','cacheWrite','input','output','total','contextBand']));
  atomic(path.join(REPORTS,'quota.csv'),csv(data.snapshots.map(s=>({...s,time:new Date(s.time).toISOString(),usedPercent:s.used*100})),['source','time','kind','usedPercent','resetAt','plan','account']));
  const srows=samples.map(s=>({id:s.id,source:s.source,label:s.label,start:new Date(s.startedAt).toISOString(),status:s.result?.status,reason:s.result?.reason,...s.result}));
  atomic(path.join(REPORTS,'samples.csv'),csv(srows,['id','source','label','start','status','reason','deltaPercent','calls','inputOther','cacheRead','cacheWrite','output','total','knownTotal','unknown','tokenComplete','percentPerMillion']));
  const capacityRows=report.monthlyCapacity.observations.map(o=>({...o,start:new Date(o.start).toISOString(),end:new Date(o.end).toISOString(),confidenceScore:o.confidence.score,confidenceLevel:o.confidence.level,rangeLower:o.range?.lower,rangeUpper:o.range?.upper,confidenceReasons:o.confidence.reasons?.join('；'),...Object.fromEntries(o.composition.flatMap(c=>[[c.key+'Share',c.share],[c.key+'MonthlyTokens',c.monthlyTokens]]))}));
  atomic(path.join(REPORTS,'capacity.csv'),csv(capacityRows,['id','groupId','source','start','end','plan','resetAt','status','reason','calls','deltaPercent','inputOther','cacheRead','cacheWrite','output','total','knownTotal','unknownCacheRead','unknownCacheWrite','monthlyTokens','rangeLower','rangeUpper','confidenceScore','confidenceLevel','confidenceReasons',...['inputOther','cacheRead','cacheWrite','output'].flatMap(k=>[k+'Share',k+'MonthlyTokens'])]));
  const modelRows=report.monthlyCapacity.modelEstimates.map(m=>({...m,confidenceScore:m.confidence.score,confidenceLevel:m.confidence.level,rangeLower:m.range?.lower,rangeUpper:m.range?.upper,...Object.fromEntries(m.observedComposition.map(c=>[c.key+'Share',c.share]))}));
  atomic(path.join(REPORTS,'models.csv'),csv(modelRows,['groupId','quotaSource','source','model','rawModel','thinking','band','plan','resetAt','status','reason','observedCalls','observedTokens','observedKnownTokens','unknownCalls','observations','calls','monthlyTokens','rangeLower','rangeUpper','confidenceScore','confidenceLevel',...['inputOther','cacheRead','cacheWrite','output'].map(k=>k+'Share')]));
  const taskCosts=report.taskComparisons.map(c=>`${escape(c.label)}：Work / Code = ${c.workOverCode.toFixed(2)} 倍；Code ${c.code.toFixed(4)} / Work ${c.work.toFixed(4)} 个百分点（同标签任务观察值）`).join('<br>');
  const table=report.groups.map(g=>`<tr><td>${g.source==='code'?'Kimi Code':'Kimi Work'}</td><td>${escape(g.model)}</td><td>${escape(g.thinking)}</td><td>${g.calls}</td><td>${g.inputOther.toLocaleString()}</td><td>${g.unknownCacheRead?'≥ ':''}${g.cacheRead.toLocaleString()}</td><td>${g.unknownCacheWrite?'≥ ':''}${g.cacheWrite.toLocaleString()}</td><td>${g.output.toLocaleString()}</td><td>${(g.total==null?'≥ '+g.knownTotal.toLocaleString():g.total.toLocaleString())}${g.unknown?'（有缺失）':''}</td></tr>`).join('');
  atomic(path.join(REPORTS,'report.html'),`<!doctype html><meta charset="utf-8"><title>Kimi 用量统计</title><style>body{font:16px/1.7 system-ui;max-width:1200px;margin:40px auto;padding:0 24px;color:#182432}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:right}td:first-child,td:nth-child(2){text-align:left}.note{background:#eef4fa;padding:16px;border-radius:12px}</style><h1>Kimi Code / Work 用量统计</h1><p>生成时间：${escape(new Date(report.generatedAt).toLocaleString('zh-CN'))}</p><p class="note">这是本机已保留日志的累计用量，不等于整个订阅周期。月额度来自实际会员接口或历史日志；没有足够的隔离样本时，不报告计费倍率。</p><table><tr><th>产品</th><th>模型</th><th>思考</th><th>调用</th><th>非缓存输入</th><th>缓存读取</th><th>缓存写入</th><th>输出</th><th>合计</th></tr>${table}</table><h2>月额度最近一次记录</h2><p>${report.monthly?`${(report.monthly.used*100).toFixed(2)}% 已用；记录时间 ${escape(new Date(report.monthly.time).toLocaleString('zh-CN'))}；${report.monthly.stale?'历史读数，开始对照前需要新读数；此提示不代表会员到期':'近期读数'}`:'尚未发现'}</p>${capacityHtml(report.monthlyCapacity)}${modelCapacityHtml(report.monthlyCapacity)}<h2>计费差距</h2><p>${taskCosts||'尚无已结算的同标签任务对照。'}</p><p>${report.comparisons.length?report.comparisons.map(c=>`${escape(c.model)}：指定构成下 Work / Code 约 ${c.workOverCode.toFixed(2)} 倍（经验估计）`).join('<br>'):'统一 token 单价的样本不足，尚不能可靠计算。请运行本地看板建立对照样本。'}</p><p>完整明细保存在同目录 tokens.csv、quota.csv、samples.csv、capacity.csv、models.csv 和 report.json。</p>`);
}
async function refresh(poll=true,force=false,trigger='request'){
  if(scanning)return scanning;
  scanning=(async()=>{const startedAt=Date.now(),data=await collector.scan(poll&&!process.argv.includes('--offline'),force);
    for(const s of samples)if(['running','settling'].includes(s.result?.status)||s.result?.reason==='缺少缓存计数，无法计算完整 token'){if(s.result?.status==='invalid'&&!s.previousResult)s.previousResult={...s.result};s.result=M.settlement(s,data.events,data.snapshots);}
    saveSamples();const rates=M.fitRates(samples),capacity=monthlyCapacity(data.events,data.snapshots,samples);
    report={schemaVersion:5,generatedAt:Date.now(),settings:{updateIntervalSeconds:config.intervalSeconds,quotaPollSeconds:config.quotaPollSeconds},coverage:{first:data.events[0]?.time||null,last:data.events.at(-1)?.time||null,records:data.events.length},groups:M.aggregate(data.events),today:M.aggregate(data.events.filter(e=>new Date(e.time).toDateString()===new Date().toDateString())),monthly:M.latestMonthly(data.snapshots,Date.now(),config.sampleMaxAgeSeconds),monthlyCapacity:capacity,codeQuota:snapshotSummary(data.snapshots),status:data.status,intervals:M.candidateIntervals(data.events,data.snapshots),samples,rates,comparisons:M.compareRates(rates),limitations:['token 只统计本机现存及监控期间保存的实际调用日志，不代表账号所有设备的总量。','月额度由所有入口共享；隔离实验需要确认两端同一账号，且没有其他设备、网页或自动任务消费。','月额度主动查询 Kimi 会员接口；查询失败保留最后成功读数和时间，历史日志作为备份，不伪造新读数。','出现余额下降、套餐或周期信息变化时，对照数据会分段；额度恢复不计为负的消费。','输出采用客户端报告值，不额外累加思考 token；未知字段不补零。','总 token 包含累计缓存读取。缓存缺失时只展示已知下限（≥），不补零；可结算月额度任务成本，但不拟合 token 单价。说明栏为程序判定；参考构成取自实测样本。']};
    report.taskComparisons=M.compareTasks(samples);report.sqlite=collector.store.recordRun(report,startedAt,trigger,samples);exportReport(data);return report;})();
  try{return await scanning;}finally{scanning=null;}
}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>4096)throw Error('请求过长');}return text?JSON.parse(text):{};}
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));}
async function handle(req,res){
  const origin=`http://127.0.0.1:${port}`;
  if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin))return send(res,403,{error:'仅允许本机看板访问'});
  const url=new URL(req.url,origin);
  try{
    if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{app:'kimi-usage-monitor',pid:process.pid,version:5});
    if(req.method==='GET'&&url.pathname==='/api/report'){await refresh();return send(res,200,{...report,nonce});}
    if(req.method==='GET'&&url.pathname==='/api/events'){return send(res,200,usageHistory([...collector.events.values()],url.searchParams));}
    if(req.method==='GET'&&url.pathname==='/api/conversation'){
      const source=url.searchParams.get('source'),session=url.searchParams.get('session'),agent=url.searchParams.get('agent')||'main';
      if(!['code','work'].includes(source)||!session||!agent||agent.length>200)throw Error('请选择有效会话');
      await refresh();return send(res,200,{source,session,agent,...collector.store.conversation(source,session,agent)});
    }
    if(req.method==='GET'&&url.pathname==='/export/usage.sqlite'){
      await refresh();const file=path.join(REPORTS,'usage-analysis.sqlite');await collector.store.backupTo(file);
      res.writeHead(200,{'Content-Type':'application/vnd.sqlite3','Content-Disposition':'attachment; filename="usage-analysis.sqlite"','Cache-Control':'no-store'});return res.end(fs.readFileSync(file));
    }
    if(req.method==='GET'&&url.pathname==='/api/capacity'){
      const range=rangeParams(url.searchParams,true);
      return send(res,200,monthlyCapacity([...collector.events.values()],[...collector.snapshots.values()],samples,Date.now(),{...range,exclusiveAttested:url.searchParams.get('exclusive')==='true'}));
    }
    if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(fs.readFileSync(path.join(ROOT,'dashboard.html')));}
    if(req.method==='GET'&&/^\/export\/(tokens|quota|samples|capacity|models)\.csv$/.test(url.pathname)){const name=path.basename(url.pathname);res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`});return res.end(fs.readFileSync(path.join(REPORTS,name)));}
    if(req.method!=='POST')return send(res,404,{error:'未找到'});
    if(req.headers['x-monitor-token']!==nonce)return send(res,403,{error:'请刷新看板后重试'});
    const input=await body(req);
    if(url.pathname==='/api/refresh'){await refresh(true,true);return send(res,200,{ok:true});}
    if(url.pathname==='/api/analysis/range'){
      const range={...rangeParams(new URLSearchParams({from:input.from??'',to:input.to??''}),true),exclusiveAttested:input.exclusive===true};
      const result=monthlyCapacity([...collector.events.values()],[...collector.snapshots.values()],samples,Date.now(),range);
      result.savedRangeId=collector.store.saveAnalysisRange(M.id(JSON.stringify(range)),range,result);return send(res,200,result);
    }
    if(url.pathname==='/api/sample/start'){
      await refresh();if(!['code','work'].includes(input.source))throw Error('请选择产品');
      if(input.exclusive!==true)throw Error('请先确认两端属于同一账号，并暂停其他入口的任务');
      if(samples.some(s=>['running','settling'].includes(s.result?.status)))throw Error('已有进行中或等待结算的样本');
      const monthly=M.latestMonthly([...collector.snapshots.values()],Date.now(),config.sampleMaxAgeSeconds);
      if(!monthly)throw Error('尚未取得月额度读数，系统正在自动查询；请查看会员接口状态');
      if(monthly.staleReason==='clock-skew')throw Error('日志时间晚于本机时间：请核对电脑时间和日志时区后再开始对照');
      if(monthly.stale)throw Error(`尚未取得新的起始读数：最后成功记录距今 ${Math.ceil(monthly.ageSeconds/60)} 分钟，系统会继续自动重试。请查看会员接口状态。`);
      if(monthly.used>=0.999999)throw Error('月额度已用满，不能测量扣减；请等刷新后再开始');
      if(!M.stableBaseline([...collector.snapshots.values()],Date.now(),config.sampleMaxAgeSeconds))throw Error('正在等待两次稳定的起始读数，系统每个周期自动查询；保持任务停止即可');
      const now=Date.now();if([...collector.events.values()].some(e=>e.time>monthly.time))throw Error('最新读数后还有模型调用：请等任务停止，系统会自动取得新的起始读数');
      const sample={id:crypto.randomUUID(),source:input.source,label:String(input.label||'未命名任务').slice(0,100),startedAt:now,baseline:monthly,exclusiveAttested:true,result:{status:'running',reason:'采样中'}};samples.push(sample);saveSamples();await refresh(false);return send(res,200,{ok:true,id:sample.id});
    }
    if(url.pathname==='/api/sample/end'){
      const sample=samples.find(s=>s.id===input.id);if(!sample||sample.result.status!=='running')throw Error('没有正在运行的对应样本');
      await refresh();sample.endedAt=Date.now();sample.result=M.settlement(sample,[...collector.events.values()],[...collector.snapshots.values()]);saveSamples();await refresh(false);return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/sample/cancel'){
      const sample=samples.find(s=>s.id===input.id);if(!sample||!['running','settling'].includes(sample.result.status))throw Error('没有可取消的样本');sample.result={status:'cancelled',reason:'用户取消，保留记录但不参与估算'};saveSamples();await refresh(false);return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/stop'){send(res,200,{ok:true});clearInterval(timer);clearInterval(quotaTimer);server.close(()=>process.exit(0));return;}
    return send(res,404,{error:'未找到'});
  }catch(err){return send(res,400,{error:err.message==='请求过长'?err.message:String(err.message||'操作失败').slice(0,260)});}
}
async function stop(){const runtime=readJson(path.join(DATA,'runtime.json'));if(!runtime)throw Error('没有找到运行中的监控');const base=`http://127.0.0.1:${runtime.port}`;const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());if(health.app!=='kimi-usage-monitor'||health.pid!==runtime.pid)throw Error('对应端口不是此监控，未停止其他程序');const view=await fetch(base+'/api/report').then(r=>r.json());await fetch(base+'/api/stop',{method:'POST',headers:{'x-monitor-token':view.nonce}});console.log('统计监控已停止。');}
async function main(){
  if(process.argv.includes('--stop'))return stop();
  const lockPath=path.join(DATA,'monitor.lock');
  if(fs.existsSync(lockPath)){
    const lock=readJson(lockPath);let alive=false;
    if(Number.isInteger(lock?.pid)){try{process.kill(lock.pid,0);alive=true;}catch{}}
    if(alive)throw Error('统计程序已经运行，请使用看板或先停止现有监控');
    fs.unlinkSync(lockPath);
  }
  const lockFd=fs.openSync(lockPath,'wx');fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid}));fs.closeSync(lockFd);
  process.on('exit',()=>{try{if(readJson(lockPath)?.pid===process.pid)fs.unlinkSync(lockPath);}catch{}});
  collector=new Collector(config,DATA);
  await refresh(!process.argv.includes('--offline'),false,'startup');
  if(!process.argv.includes('--serve')){console.log(JSON.stringify({records:report.coverage.records,groups:report.groups,monthly:report.monthly,codeQuota:report.codeQuota,monthlyCapacity:report.monthlyCapacity,status:report.status,comparisons:report.comparisons},null,2));return;}
  server=http.createServer(handle);server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});port=server.address().port;
  atomic(path.join(DATA,'runtime.json'),JSON.stringify({app:'kimi-usage-monitor',pid:process.pid,port,startedAt:Date.now()}));
  timer=setInterval(()=>refresh(true,false,'automatic').catch(()=>{if(report)report.collectionError='本轮采集或 SQLite 写入失败，保留上次成功数据；请检查本地文件权限或磁盘空间';}),Math.max(2,config.intervalSeconds)*1000);
  // Schedule quota reads independently so an intervening page read cannot postpone the next query by a full log interval.
  if(!process.argv.includes('--offline'))quotaTimer=setInterval(()=>{
    if(Date.now()-Math.min(collector.lastPoll,collector.lastWorkPoll)>=config.quotaPollSeconds*1000)refresh(true,false,'quota-poll').catch(()=>{if(report)report.collectionError='额度查询或 SQLite 写入失败，保留最后成功记录';});
  },1000);
  console.log(`统计看板：http://127.0.0.1:${port}`);
}
if(require.main===module)main().catch(err=>{console.error(err.code==='EADDRINUSE'?'端口已被占用，请打开现有看板或修改 config.json 的 port。':`启动失败：${err.message}`);process.exitCode=1;});
