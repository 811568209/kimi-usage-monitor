'use strict';
const fs=require('node:fs'),path=require('node:path');
const {id}=require('./metrics.cjs');
const SUBSCRIPTION_URL='https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription';
const REFRESH_URL='https://www.kimi.com/api/auth/token/refresh';
function tokenExpiry(token){try{const data=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());return Number.isFinite(data.exp)?data.exp*1000:0;}catch{return 0;}}
function parseSubscription(body,time,account){
  const choices=(body?.balances||[]).filter(b=>b.feature==='FEATURE_OMNI'&&b.type==='SUBSCRIPTION');
  if(choices.length!==1)return {ok:false,reason:'会员接口未返回唯一的共享额度记录，未推算余额'};
  const balance=choices[0],used=balance.amountUsedRatio;
  if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>1)return {ok:false,reason:'会员接口缺少有效的已用比例，保留上次成功读数'};
  const expiry=Date.parse(balance.expireTime),sub=body.subscription||{},goods=sub.goods||{};
  const snapshot={source:'kimi-membership-api',kind:'month',time,used,resetAt:Number.isFinite(expiry)?new Date(expiry).toISOString():null,plan:typeof goods.membershipLevel==='string'?goods.membershipLevel:'unknown',account,quantum:0.0001};
  snapshot.id=id(JSON.stringify(snapshot));
  return {ok:true,snapshot,membership:{active:typeof sub.active==='boolean'?sub.active:null,status:typeof sub.status==='string'?sub.status:null,planTitle:typeof goods.title==='string'?goods.title:null,validUntil:typeof sub.currentEndTime==='string'?sub.currentEndTime:null},provenance:{source:'Kimi 会员接口',ratioField:'balances[FEATURE_OMNI/SUBSCRIPTION].amountUsedRatio',resetField:'balances[FEATURE_OMNI/SUBSCRIPTION].expireTime'}};
}
class WorkQuotaClient{
  constructor(appPath,fetchImpl=globalThis.fetch){this.file=path.join(appPath,'daimon-share','daimon','config.json');this.fetch=fetchImpl;this.cache=null;}
  readCredentials(){try{const config=JSON.parse(fs.readFileSync(this.file,'utf8')),auth=config.credentials?.kimiWeb;
    if(!auth||typeof auth.userId!=='string')return null;
    const headers={};for(const key of ['User-Agent','R-Timezone','X-Msh-Version']){const v=config.kimiCode?.kimiRequestHeaders?.[key];if(typeof v==='string')headers[key]=v;}
    return {access:auth.accessToken,refresh:auth.refreshToken,account:id(auth.userId),userId:auth.userId,headers};
  }catch{return null;}}
  async renew(auth){
    const response=await this.fetch(REFRESH_URL,{method:'GET',headers:{Authorization:`Bearer ${auth.refresh}`,'X-Language':'zh-CN'},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return {ok:false,httpStatus:response.status,reason:response.status===401||response.status===403?'Kimi 登录已失效，请在客户端重新登录；未伪造新读数':'Kimi 登录续期查询失败，稍后自动重试'};
    const body=await response.json(),access=body.access_token||body.accessToken,refresh=body.refresh_token||body.refreshToken;
    if(typeof access!=='string'||!access)return {ok:false,reason:'续期接口没有返回有效凭据'};
    this.cache={...auth,access,refresh:typeof refresh==='string'?refresh:auth.refresh};return {ok:true,auth:this.cache};
  }
  async poll(){const attemptedAt=Date.now();try{
    const disk=this.readCredentials();if(!disk)return {ok:false,attemptedAt,reason:'尚未读取到 Kimi 客户端的登录信息'};
    if(!this.cache||this.cache.account!==disk.account)this.cache=disk;
    else if(typeof disk.access==='string'&&tokenExpiry(disk.access)>tokenExpiry(this.cache.access))this.cache=disk;
    let auth=this.cache;
    if(typeof auth.access!=='string'||tokenExpiry(auth.access)<=Date.now()+30000){
      if(typeof auth.refresh!=='string'||!auth.refresh)return {ok:false,attemptedAt,reason:'Kimi 登录凭据不可续期，请在客户端重新登录'};
      const renewed=await this.renew(auth);if(!renewed.ok)return {...renewed,attemptedAt};auth=renewed.auth;
    }
    const request=()=>this.fetch(SUBSCRIPTION_URL,{method:'POST',headers:{...auth.headers,Authorization:`Bearer ${auth.access}`,'X-Traffic-Id':auth.userId,'Content-Type':'application/json','Connect-Protocol-Version':'1'},body:'{}',redirect:'error',signal:AbortSignal.timeout(10000)});
    let response=await request();
    if(response.status===401&&typeof auth.refresh==='string'){
      const renewed=await this.renew(auth);if(!renewed.ok)return {...renewed,attemptedAt};auth=renewed.auth;response=await request();
    }
    if(!response.ok)return {ok:false,attemptedAt,httpStatus:response.status,reason:'Kimi 会员接口查询失败，保留最后成功时间与读数'};
    const result=parseSubscription(await response.json(),Date.now(),auth.account);return {...result,attemptedAt};
  }catch(error){return {ok:false,attemptedAt,reason:error?.name==='TimeoutError'?'Kimi 会员接口查询超时，下一周期自动重试':'Kimi 会员接口连接失败，下一周期自动重试'};}}
}
module.exports={WorkQuotaClient,parseSubscription,tokenExpiry,SUBSCRIPTION_URL,REFRESH_URL};
