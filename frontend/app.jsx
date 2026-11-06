import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {get,post,date} from './api';
import {FeatureBoundary} from './components';
import Overview from './features/Overview';
import Activity from './features/Activity';
import Usage from './features/Usage';
import Capacity from './features/Capacity';
import Models from './features/Models';
import RangeAnalysis from './features/RangeAnalysis';
import Comparisons from './features/Comparisons';
import DataStatus from './features/DataStatus';
import './styles.css';
const pages=[['overview','总览','监控概况与常用入口'],['activity','Token 活动','每日、每周与累计用量'],['usage','调用与会话','模型明细与逐次调用记录'],['capacity','额度推算','持续估算与可信度筛选'],['models','模型与档位','按模型、思考档位和上下文分析'],['range','时间段分析','复盘指定时段的额度与构成'],['comparisons','隔离对照','任务成本与计费差距'],['data','数据与运行','SQLite、导出与后台状态']];
const currentPage=()=>pages.some(([id])=>id===location.hash.slice(1))?location.hash.slice(1):'overview';
function App(){
  const [page,setPage]=useState(currentPage),[report,setReport]=useState(null),[connection,setConnection]=useState('正在连接'),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[stopped,setStopped]=useState(false),loading=useRef(null),timer=useRef(null),stopRef=useRef(false),noticeTimer=useRef(null);
  const notify=useCallback(text=>{setNotice(text);clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(''),12000);},[]);
  const refresh=useCallback(()=>{if(loading.current)return loading.current;loading.current=get('/api/report').then(r=>{setReport(r);setConnection('监控运行中');return r;}).catch(e=>{setConnection('监控未连接');throw e;}).finally(()=>{loading.current=null;});return loading.current;},[]);
  useEffect(()=>{let closed=false;async function poll(){try{const r=await refresh();if(!closed&&!stopRef.current)timer.current=setTimeout(poll,(r.settings.updateIntervalSeconds||5)*1000);}catch{if(!closed&&!stopRef.current)timer.current=setTimeout(poll,5000);}}poll();return ()=>{closed=true;clearTimeout(timer.current);clearTimeout(noticeTimer.current);};},[refresh]);
  useEffect(()=>{const change=()=>{setPage(currentPage());window.scrollTo(0,0);};window.addEventListener('hashchange',change);return ()=>window.removeEventListener('hashchange',change);},[]);
  const navigate=id=>{location.hash=id;setPage(id);};
  async function update(){setBusy(true);try{await post('/api/refresh',report?.nonce);await refresh();}catch(e){notify(e.message);}finally{setBusy(false);}}
  async function stop(){try{await post('/api/stop',report.nonce);stopRef.current=true;clearTimeout(timer.current);setStopped(true);setConnection('监控已停止');notify('监控已停止；双击启动文件可重新运行。');}catch(e){notify(e.message);}}
  const title=pages.find(([id])=>id===page),w=report?.status.workQuota;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-icon">K</span><div>Kimi 用量监控<small>本地自动采集与分析</small></div></div><nav aria-label="功能导航">{pages.map(([id,label])=><a key={id} href={'#'+id} aria-current={id===page?'page':undefined} className={id===page?'active':''}>{label}</a>)}</nav><div className="sidebar-footer"><span className={'status-dot '+(connection==='监控运行中'?'running':'')}/>{connection}<small>仅在本机 127.0.0.1 运行</small></div></aside>
    <main className="workspace"><header className="top"><div><div className="eyebrow">KIMI USAGE OBSERVATORY</div><h1>{title[1]}</h1><p className="muted">{title[2]}</p></div><div className="actions"><span className="badge" id="connection">{connection}</span><button id="refresh" disabled={!report||busy||stopped} onClick={update}>{busy?'更新中…':'更新统计'}</button></div></header>
    {document.documentElement.dataset.synthetic==='true'&&<div className="note warning">合成数据功能验证：以下数值仅用于测试，不代表真实账号。</div>}
    {notice&&<div className="message" id="message" style={{display:'block'}} role="alert">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>}
    {report?<><div className={'note freshness'+(report.collectionError||w&&!w.ok?' warning':'')} id="freshness">{stopped?'后台已停止。':report.collectionError|| (w&&!w.ok?'月额度查询暂未成功：'+w.reason+'。保留最后成功读数，后台将自动重试。':w?.ok?'月额度接口查询成功 · '+date(w.lastSuccessAt)+' · 本地日志每 '+report.settings.updateIntervalSeconds+' 秒采集，额度每 '+report.settings.quotaPollSeconds+' 秒查询。':'等待会员接口首次有效读数。')}</div>
      {pages.map(([id])=><div key={id} hidden={id!==page} className="feature-page" data-page={id}><FeatureBoundary>{id==='overview'?<Overview report={report} navigate={navigate}/>:id==='activity'?<Activity data={report.activity}/>:id==='usage'?<Usage report={report} notify={notify}/>:id==='capacity'?<Capacity report={report}/>:id==='models'?<Models report={report}/>:id==='range'?<RangeAnalysis report={report} notify={notify}/>:id==='comparisons'?<Comparisons report={report} notify={notify} refresh={refresh}/>:<DataStatus report={report} onStop={stop}/>}</FeatureBoundary></div>)}
      <footer className="footer">自动保存到本机 SQLite · 分页默认 10 条，最少 5 条，修改后自动记忆 · 最近统计 {date(report.generatedAt)}</footer>
    </>:<div className="panel empty" role="status">{connection==='监控未连接'?'暂时连接不上本机监控，正在自动重试。':'正在读取本机已采集数据…'}</div>}</main></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
