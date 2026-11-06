'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {activity,tokenActivity,dayKey}=require('../lib/activity.cjs');
const time=date=>Date.parse(date),event=(date,total=1000,extra={})=>({id:date,source:'code',session:'s',agent:'main',time:time(date),requestedAt:time(date)-60000,turnId:date,inputOther:total*.1,cacheRead:total*.7,cacheWrite:total*.05,output:total*.15,total,...extra});
const NOW=time('2026-11-06T04:00:00Z');
test('空记录仍生成连续一年热力图和零值趋势，不虚构使用',()=>{
 const a=activity([],NOW);assert.equal(a.summary.calls,0);assert.equal(a.summary.knownTokens,0);assert.equal(a.summary.peakDay,null);assert.equal(a.heatmap.days.length,371);assert(a.heatmap.days.every(d=>!d.active));assert.equal(a.series.daily.length,14);assert.equal(a.series.weekly.length,12);
});
test('按北京时间跨日聚合，非缓存输入、读写缓存、输出保留',()=>{
 assert.equal(dayKey(time('2026-11-05T16:00:00Z')),'2026-11-06');
 const a=activity([event('2026-11-05T15:59:59Z'),event('2026-11-05T16:00:00Z',2000)],NOW);assert.equal(a.dailyTotals.length,2);assert.equal(a.summary.knownTokens,3000);assert.equal(a.summary.peakDay.date,'2026-11-06');assert.equal(a.summary.peakDay.knownTokens,2000);assert.equal(a.dailyTotals[1].cacheRead,1400);
});
test('连续天数跨月跨年统计；今日未使用但昨日连续可保留当前连续值',()=>{
 const events=['2025-12-30','2025-12-31','2026-01-01','2026-01-02'].map(d=>event(d+'T02:00:00Z'));
 const a=activity(events,time('2026-01-03T02:00:00Z'));assert.equal(a.summary.longestStreak,4);assert.equal(a.summary.currentStreak,4);assert.equal(a.summary.currentStreakThrough,'2026-01-02');
 assert.equal(activity(events,time('2026-01-04T02:00:00Z')).summary.currentStreak,0);
});
test('任务跨度按产品、会话、Agent、轮次隔离，不能将整个会话寿命当任务',()=>{
 const events=[event('2026-11-05T00:00:00Z',1000,{turnId:'a',requestedAt:time('2026-11-04T23:59:00Z')}),event('2026-11-05T00:05:00Z',1000,{turnId:'a'}),event('2026-11-06T00:00:00Z',1000,{turnId:'b'}),event('2026-11-05T00:06:00Z',1000,{turnId:'a',agent:'child'})];
 const a=activity(events,NOW);assert.equal(a.summary.longestTask.durationMs,6*60000);assert.equal(a.summary.longestTask.basis,'turn');
});
test('缓存缺失显示已知下限，热力图和累计曲线不填零',()=>{
 const a=activity([event('2026-11-05T00:00:00Z',1000,{cacheRead:null,total:null}),event('2026-11-06T00:00:00Z')],NOW);
 assert.equal(a.summary.totalTokens,null);assert.equal(a.summary.knownTokens,1300);assert.equal(a.summary.unknownCalls,1);assert.equal(a.series.cumulative.at(-1).knownTokens,1300);assert.equal(a.series.cumulative.at(-1).totalTokens,null);
});
test('产品筛选及每周/累计用量无重复累加，排除尚未发生记录',()=>{
 const events=[event('2026-11-02T00:00:00Z'),event('2026-11-06T00:00:00Z',2000,{source:'work'}),event('2026-11-07T00:00:00Z',100000)];
 const a=tokenActivity(events,NOW);assert.equal(a.all.summary.knownTokens,3000);assert.equal(a.code.summary.knownTokens,1000);assert.equal(a.work.summary.knownTokens,2000);assert.equal(a.all.series.weekly.at(-1).knownTokens,3000);assert.equal(a.all.series.cumulative.at(-1).knownTokens,3000);assert(a.all.heatmap.days.filter(d=>d.future).every(d=>!d.active));
});
