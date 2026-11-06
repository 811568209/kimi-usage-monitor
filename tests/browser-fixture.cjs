'use strict';
// Isolated UI/HTTP fixture. Never reads the real client's logs or credentials.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const M=require('../lib/metrics.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function startFixture(){
  const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'kimi-browser-test-')),root=path.resolve(__dirname,'..');
  fs.mkdirSync(dir+'/lib');fs.mkdirSync(dir+'/data');
  for(const file of ['monitor.cjs','dashboard.html'])fs.copyFileSync(path.join(root,file),path.join(dir,file));
  const html=fs.readFileSync(dir+'/dashboard.html','utf8');fs.writeFileSync(dir+'/dashboard.html',html.replace('<main>','<main><div class="note warning">合成数据功能验证：以下数值仅用于测试，不代表真实账号。</div>'));
  for(const file of ['collector.cjs','metrics.cjs','work-quota.cjs','monthly-capacity.cjs','history.cjs','database.cjs','conversations.cjs'])fs.copyFileSync(path.join(root,'lib',file),path.join(dir,'lib',file));
  const now=Date.now(),start=now-15*60000,account=M.id('SYNTHETIC_UI_USER');
  const points=Array.from({length:13},(_,i)=>({id:'fixture-quota-'+i,source:'kimi-membership-api',kind:'month',time:start+i*60000,used:.1+i*.001,account,plan:'TEST_PLAN',resetAt:'2027-01-01T00:00:00.000Z',quantum:.0001}));
  points.push({...points.at(-1),id:'fixture-stable',time:now-60000});
  fs.writeFileSync(dir+'/data/quota.jsonl',points.map(JSON.stringify).join('\n')+'\n');
  const wire=dir+'/code/sessions/wd-fixture/synthetic-session/agents/main/wire.jsonl';fs.mkdirSync(path.dirname(wire),{recursive:true});
  const events=Array.from({length:12},(_,i)=>[{type:'llm.request',time:start+i*60000+1000,thinkingEffort:'high'},
    {type:'usage.record',time:start+i*60000+30000,model:'kimi-code/k3.1-pro',usageScope:'turn',usage:{inputOther:1000,inputCacheRead:7000,inputCacheCreation:500,output:1500}}]).flat();
  fs.writeFileSync(wire,events.map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(dir+'/data/samples.json','[]');
  fs.mkdirSync(dir+'/app/daimon-share/daimon',{recursive:true});
  const access='test.'+Buffer.from(JSON.stringify({exp:Math.floor(now/1000)+86400})).toString('base64url')+'.test';
  fs.writeFileSync(dir+'/app/daimon-share/daimon/config.json',JSON.stringify({credentials:{kimiWeb:{userId:'SYNTHETIC_UI_USER',accessToken:access}}}));
  fs.writeFileSync(dir+'/fixture.json',JSON.stringify({used:.112}));
  fs.writeFileSync(dir+'/fetch.cjs',`const fs=require('node:fs'),real=fetch,realNow=Date.now;Date.now=()=>{const f=JSON.parse(fs.readFileSync(__dirname+'/fixture.json'));return f.now??realNow();};globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('http://127.0.0.1:'))return real(url,opts);if(!String(url).startsWith('https://www.kimi.com/'))throw Error('Unexpected network request');const f=JSON.parse(fs.readFileSync(__dirname+'/fixture.json'));if(f.fail)throw Error('Synthetic outage');return new Response(JSON.stringify({subscription:{active:true,goods:{membershipLevel:'TEST_PLAN'}},balances:[{feature:'FEATURE_OMNI',type:'SUBSCRIPTION',amountUsedRatio:f.used,expireTime:'2027-01-01T00:00:00Z'}]}));};`);
  fs.writeFileSync(dir+'/config.json',JSON.stringify({port:0,intervalSeconds:5,quotaPollSeconds:30,codeHome:dir+'/code',workHome:dir+'/work',workApp:dir+'/app'}));
  const child=spawn(process.execPath,['--require',dir+'/fetch.cjs',dir+'/monitor.cjs','--serve'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);let base;
  async function cleanup(){
    if(child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
    const resolved=fs.realpathSync(dir);
    if(path.dirname(resolved)!==tempRoot||!path.basename(resolved).startsWith('kimi-browser-test-'))throw Error('Unsafe fixture cleanup path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
  try{
    for(let i=0;i<100;i++){
      try{const runtime=JSON.parse(fs.readFileSync(dir+'/data/runtime.json'));if(runtime.pid===child.pid){base='http://127.0.0.1:'+runtime.port;const health=await fetch(base+'/api/health').then(r=>r.json());if(health.pid===child.pid)break;}}catch{}
      if(child.exitCode!==null)throw Error(errors||'Fixture exited');await wait(50);
    }
    if(!base)throw Error('Fixture not ready');
    return {dir,base,wire,child,cleanup,setState:state=>fs.writeFileSync(dir+'/fixture.json',JSON.stringify(state))};
  }catch(error){await cleanup();throw error;}
}
if(require.main===module)startFixture().then(async fixture=>{
  console.log(JSON.stringify({url:fixture.base,fixtureDirectory:fixture.dir,syntheticDataOnly:true}));
  await new Promise(r=>fixture.child.once('exit',r));await fixture.cleanup();
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={startFixture};
