'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WorkQuotaClient,parseSubscription,SUBSCRIPTION_URL,REFRESH_URL}=require('../lib/work-quota.cjs');
const jwt=expiry=>'test.'+Buffer.from(JSON.stringify({exp:Math.floor(expiry/1000)})).toString('base64url')+'.test';
const subscription=()=>({subscription:{active:true,status:'SUBSCRIPTION_STATUS_ACTIVE',goods:{title:'test-plan',membershipLevel:'TEST_LEVEL'},currentEndTime:'2027-01-01T00:00:00Z'},balances:[{feature:'FEATURE_OMNI',type:'SUBSCRIPTION',amountUsedRatio:.0124,expireTime:'2026-12-05T09:46:57Z'}]});
function fixture(t,access){const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'kimi-quota-test-'));
 t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),tempRoot);assert.match(path.basename(resolved),/^kimi-quota-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const file=path.join(dir,'daimon-share','daimon','config.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({credentials:{kimiWeb:{accessToken:access,refreshToken:'TEST_REFRESH_SECRET',userId:'TEST_USER_ID'}},kimiCode:{kimiRequestHeaders:{'User-Agent':'test-client'}}}));return {dir,file};
}
test('会员比例和周期直接来自响应，不使用缺失字段的默认额度',()=>{
 const r=parseSubscription(subscription(),123,'hashed-account');assert.equal(r.snapshot.used,.0124);assert.equal(r.snapshot.time,123);assert.equal(r.snapshot.resetAt,'2026-12-05T09:46:57.000Z');
 const missing=subscription();delete missing.balances[0].amountUsedRatio;assert.equal(parseSubscription(missing,123,'x').ok,false);
 missing.balances[0].amountUsedRatio='0.0124';assert.equal(parseSubscription(missing,123,'x').ok,false);
});
test('多个共享额度记录不随意挑一个充当真实值',()=>{
 const b=subscription();b.balances.push({...b.balances[0],amountUsedRatio:.9});assert.equal(parseSubscription(b,123,'x').ok,false);
});
test('短期登录凭据到期自动续期，查询成功且不修改客户端文件或输出密钥',async t=>{
 const {dir,file}=fixture(t,jwt(Date.now()-10000)),before=fs.readFileSync(file,'utf8'),calls=[];
 const newToken=jwt(Date.now()+600000);
 const fake=async(url,opts)=>{calls.push(url);assert.equal(opts.redirect,'error');
  if(url===REFRESH_URL){assert.equal(opts.method,'GET');return {ok:true,status:200,json:async()=>({access_token:newToken,refresh_token:'NEW_TEST_REFRESH'})};}
  assert.equal(url,SUBSCRIPTION_URL);assert.equal(opts.method,'POST');assert.equal(opts.headers.Authorization,'Bearer '+newToken);return {ok:true,status:200,json:async()=>subscription()};
 };
 const c=new WorkQuotaClient(dir,fake);const r=await c.poll();assert.equal(r.ok,true);assert.equal(r.snapshot.used,.0124);assert.deepEqual(calls,[REFRESH_URL,SUBSCRIPTION_URL]);
 assert.equal(fs.readFileSync(file,'utf8'),before);assert(!JSON.stringify(r).includes('TEST_REFRESH'));assert(!JSON.stringify(r).includes('TEST_USER_ID'));assert(!JSON.stringify(r).includes(newToken));
 await c.poll();assert.equal(calls.length,3);assert.equal(calls.at(-1),SUBSCRIPTION_URL);
});
test('真正的登录失效返回失败，不生成新的额度快照',async t=>{
 const {dir}=fixture(t,jwt(Date.now()+600000));let calls=0;
 const c=new WorkQuotaClient(dir,async()=>{calls++;return {ok:false,status:401};});
 const r=await c.poll();assert.equal(r.ok,false);assert.equal(r.snapshot,undefined);assert.equal(r.httpStatus,401);assert.equal(calls,2);
});
test('没有登录信息不进行匿名查询或填入演示额度',async t=>{
 const {dir,file}=fixture(t,jwt(Date.now()+600000));fs.writeFileSync(file,'{}');let calls=0;
 const r=await new WorkQuotaClient(dir,async()=>{calls++;throw Error();}).poll();assert.equal(r.ok,false);assert.equal(calls,0);assert.equal(r.snapshot,undefined);
});
