import {fmt,pct,product,score} from '../api';
import {Panel,Paged,Export} from '../components';
export function ModelEstimates({models=[],id='capacityModels',label='模型与档位'}){
  return <Paged id={id} label={label} rows={models} columns={['产品','模型','思考档位 / 上下文','记录调用 / token','推算月 token','可信度','构成与说明']} empty="等待当前额度分段的模型调用记录" render={m=><tr><td>{product(m.source)}</td><td>{m.model}</td><td>{m.thinking==='unknown'?'未知档位':m.thinking}<br/><span className="tag">{m.band}</span></td><td>{fmt(m.observedCalls)} / {m.observedTokens==null?'≥ '+fmt(m.observedKnownTokens):fmt(m.observedTokens)}</td><td>{m.monthlyTokens==null?'待积累可区分数据':(m.status==='provisional'?'≈ ':'')+fmt(m.monthlyTokens)}</td><td>{score(m.confidence)} · {m.confidence.level}<br/><span className="tag">{m.observations} 个可用区间</span></td><td className="description-cell">{m.reason}<br/><span className="small">{m.qualitySelection?.label}{m.qualitySelection?' · ':''}{(m.observedComposition||[]).map(p=>p.label+' '+pct(p.share)).join(' · ')}</span></td></tr>}/>;
}
export default function Models({report:r}){
  return <Panel title="按模型与档位推算" actions={<Export name="models.csv">导出模型与档位推算</Export>}><p className="small">产品、模型、思考档位、上下文区间分别计算；只把可单独归因的扣减用于该组推算。多个模型同时消费共享额度时，不按 token 数量硬分摊。未知档位保持未知。</p><ModelEstimates models={r.monthlyCapacity.modelEstimates.filter(m=>m.groupId===r.monthlyCapacity.overall?.id)}/><p className="small">每个模型分组同样优先使用高可信度区间，其次中可信度，否则使用全部可匹配数据。缓存缺失与补估会在构成及说明中标明。</p></Panel>;
}
