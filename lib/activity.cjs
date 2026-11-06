'use strict';
const DAY=86400000,OFFSET=8*3600000;
const dayKey=time=>new Date(time+OFFSET).toISOString().slice(0,10);
const dayTime=date=>Date.parse(date+'T00:00:00Z');
const keyFromDay=time=>new Date(time).toISOString().slice(0,10);
const empty=date=>({date,calls:0,inputOther:0,cacheRead:0,cacheWrite:0,output:0,knownTokens:0,totalTokens:0,unknownCalls:0,unknownCacheRead:0,unknownCacheWrite:0,active:false});
function add(target,row){
  for(const field of ['calls','inputOther','cacheRead','cacheWrite','output','knownTokens','unknownCalls','unknownCacheRead','unknownCacheWrite'])target[field]+=row[field];
  target.totalTokens=target.unknownCalls?null:target.knownTokens;target.active=target.knownTokens>0||target.unknownCalls>0;return target;
}
function activity(events,now=Date.now()){
  const today=dayKey(now),todayTime=dayTime(today),daily=new Map(),tasks=new Map();
  const valid=events.filter(e=>Number.isFinite(e.time)&&e.time<=now&&['code','work'].includes(e.source));
  for(const e of valid){
    const date=dayKey(e.time);if(!daily.has(date))daily.set(date,empty(date));
    const known=e.inputOther+(e.cacheRead??0)+(e.cacheWrite??0)+e.output;
    add(daily.get(date),{calls:1,inputOther:e.inputOther,cacheRead:e.cacheRead??0,cacheWrite:e.cacheWrite??0,output:e.output,knownTokens:known,unknownCalls:e.total==null?1:0,unknownCacheRead:e.cacheRead==null?1:0,unknownCacheWrite:e.cacheWrite==null?1:0});
    const key=JSON.stringify([e.source,e.session,e.agent,e.turnId||e.requestId||e.id||e.time]);
    const start=Number.isFinite(e.requestedAt)&&e.requestedAt<=e.time?e.requestedAt:e.time;
    const task=tasks.get(key)||{start,end:e.time,source:e.source,basis:e.turnId?'turn':e.requestId?'request':'record'};
    task.start=Math.min(task.start,start);task.end=Math.max(task.end,e.time);tasks.set(key,task);
  }
  const rows=[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const totals=rows.reduce((t,d)=>add(t,d),empty(null));
  const active=rows.filter(d=>d.active);let longestStreak=0,streak=0,last=null;
  for(const d of active){const time=dayTime(d.date);streak=last!==null&&time-last===DAY?streak+1:1;longestStreak=Math.max(longestStreak,streak);last=time;}
  const activeDates=new Set(active.map(d=>d.date));
  let through=activeDates.has(today)?todayTime:todayTime-DAY,currentStreak=0;
  while(activeDates.has(keyFromDay(through))){currentStreak++;through-=DAY;}
  const longestTask=[...tasks.values()].sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0]||null;
  const peak=rows.reduce((best,d)=>!best||d.knownTokens>best.knownTokens?d:best,null);
  const monday=todayTime-((new Date(todayTime).getUTCDay()+6)%7)*DAY,start=monday-52*7*DAY;
  const days=Array.from({length:53*7},(_,i)=>{const date=keyFromDay(start+i*DAY);return {...(daily.get(date)||empty(date)),future:date>today,weekday:(new Date(start+i*DAY).getUTCDay()+6)%7,week:Math.floor(i/7)};});
  const max=Math.max(0,...days.map(d=>d.knownTokens));for(const d of days)d.intensity=d.active?Math.max(1,Math.min(4,Math.ceil(d.knownTokens/Math.max(max,1)*4))):0;
  const weeks=[];for(let i=0;i<53;i++)weeks.push(days.slice(i*7,i*7+7).filter(d=>!d.future).reduce((t,d)=>add(t,d),empty(days[i*7].date)));
  let cumulative=rows.filter(d=>d.date<days[0].date).reduce((sum,d)=>sum+d.knownTokens,0),cumulativeUnknown=rows.filter(d=>d.date<days[0].date).reduce((sum,d)=>sum+d.unknownCalls,0);
  const cumulativeDays=days.filter(d=>!d.future).map(d=>{cumulative+=d.knownTokens;cumulativeUnknown+=d.unknownCalls;return {...d,knownTokens:cumulative,totalTokens:cumulativeUnknown?null:cumulative,unknownCalls:cumulativeUnknown};});
  return {timezone:'Asia/Shanghai',today,generatedAt:now,summary:{...totals,activeDays:active.length,peakDay:peak,longestTask:longestTask?{...longestTask,durationMs:longestTask.end-longestTask.start}:null,
    longestStreak,currentStreak,currentStreakThrough:currentStreak?keyFromDay(activeDates.has(today)?todayTime:todayTime-DAY):null},
    dailyTotals:rows,heatmap:{start:days[0].date,end:days.at(-1).date,weeks:53,days},series:{daily:days.filter(d=>!d.future).slice(-14),weekly:weeks.slice(-12),cumulative:cumulativeDays.slice(-30)},
    note:'按北京时间统计本机已保存调用。缓存缺失时 token 为已知下限。最长任务为同轮次首请求至末次用量的观测跨度，包含等待时间；当前连续天数允许今天尚未使用、昨日仍连续的情况。'};
}
function tokenActivity(events,now=Date.now()){return {all:activity(events,now),code:activity(events.filter(e=>e.source==='code'),now),work:activity(events.filter(e=>e.source==='work'),now)};}
module.exports={activity,tokenActivity,dayKey};
