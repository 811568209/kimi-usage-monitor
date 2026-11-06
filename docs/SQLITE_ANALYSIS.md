# SQLite 本地分析说明

数据库位于项目的 `data/usage.sqlite`。需要 Node.js 24 或以上，使用其内置 SQLite，无需安装数据库服务。

启动后本地日志默认每 5 秒采集，额度接口默认每 30 秒查询。后台自动采集写入 `collection_runs`，`trigger='automatic'` 表示周期采集；打开看板、手动刷新和启动也可能产生额外快照。没有新调用时仍保留周期快照，但逐次调用不重复入库。关掉网页不影响后台进程。

旧 `events.jsonl`、`quota.jsonl` 首次运行会自动导入，按记录 ID 去重。SQLite 可独立恢复已采集的用量、额度和会话数据；JSONL 作为数字记录的兼容镜像。客户端已删除且从未采集的历史无法恢复。

| 表 / 视图 | 内容 | 分析注意事项 |
| --- | --- | --- |
| `usage_events` | 每次实际调用的产品、会话、Agent、请求、轮次、模型、原始模型名、思考档位、上下文区间、四类 token | `id` 唯一；分析累计消耗使用此表，未知缓存和总数为 SQL NULL |
| `quota_snapshots` | 真实额度读数、来源、已用比例、周期、套餐、账号散列和精度 | 数值单位为 0–1 的比例；接口失败不新增伪造读数；多个来源不要重叠相加 |
| `requests` | 请求时间、模型、思考、客户端 turn step、消息数量及关联依据 | 不保存系统提示和整个请求体；请求 ID 为本地稳定散列 |
| `conversation_messages` | 用户输入和助手可见回复、角色、时间、文字长度、轮次与请求关联 | 不采集隐藏思考、系统提示、工具输出或附件文件正文 |
| `collection_runs` | 每次采集的开始/完成时间、触发方式、状态、频率与覆盖数量 | 每 5 秒的周期观测依据；不是一次新模型调用 |
| `usage_totals` | 各采集快照当时按产品/模型/思考分组的累计量 | 累计快照不能跨行再次求和；差值或最新快照用于趋势分析 |
| `activity_metrics` | 每次采集时 all/code/work 的活动汇总 JSON，含已知用量、未知缓存、峰值、连续天数和任务跨度 | 以 `run_id + source` 唯一；累计快照不能相加，逐日真实消耗使用 `v_daily_usage` |
| `quota_intervals` | 额度观察区间、待结算/排除原因、月 token 推算与完整依据 JSON | 稳定待结算快照可能折叠；原始读数始终保留在 `quota_snapshots` |
| `capacity_estimates` | 每次快照的综合及模型/档位推算、范围、评分、依据 | `evidence_json` 保存整数百分比、质量筛选、补估依据；混用无法识别的模型不硬分配额度 |
| `samples` | 进阶隔离对照样本及结算状态 | 不影响日常全自动采集 |
| `analysis_ranges` | 用户选择的起止时间、本机独占消费确认及当时的计算结果 | 由明确点击时间段推算保存，便于以后 AI 知道哪段数据有用户确认 |
| `v_daily_usage` | 按北京时间日期、产品、模型、档位、上下文分组的真实调用汇总 | 同时给出已知下限和未知条数，不把 NULL 缓存补成精确总量 |

所有 `*_at` 时间字段为 UTC Unix 毫秒；日期视图按北京时间。`used_ratio` 单位为比例；`delta_percent` 单位为百分点，例如 0.1 表示 0.1 个百分点。模型档位缺失时为 `unknown`，不能自行当作默认档位。

## 会话和用量关联

产品、会话散列和 Agent 确定消息所在的本地日志。用户消息通过客户端显式 `turnId` 与本轮多次模型调用关联；助手回复通过同一 Agent 的 canonical wire 中最近请求顺序关联。后者标为 `same-agent-wire-request-order`，不宣称是服务端返回的唯一响应 ID。

`usage_events.request_id = requests.id`，`conversation_messages.request_id = requests.id`；用户轮次则使用 `source + session_id + agent_id + turn_id`。同一条用量可能同时关联一个用户轮次和一条助手回复，因此不能把这两种视角相加，也不能先把多条消息和多条调用连接后直接求和。

`config.json` 的 `collectConversationContent` 默认为 true。设为 false 后新消息只保留元数据、长度和关联，不保存正文；已有正文不会自动删除。API 访问凭据只用于查询，不写入会话表。用户输入或助手可见文本中本身包含的内容会原样保存在本机。

## 给 AI 的分析口径

1. 优先从 `usage_events` 统计真实消耗，保留产品、模型、思考档位和上下文维度。
2. 区分非缓存输入、缓存读取、缓存写入与输出；缺失计数只能给下限。
3. 额度按账号、套餐、周期、来源和恢复基准分段。Code 与 Work 同时使用时可分析混合构成总量，不能仅按 token 数量分摊共享扣减。
4. 月总 token 推算为匹配 token / 已用比例增量，依赖本机日志覆盖全部消费以及结算时间匹配；不是官方固定额度。
5. 按模型/档位推算只使用可独立归因的区间；混用或档位未知标为数据不足。
6. 使用原始数据重新计算时说明纳入/排除规则、缺失比例、时间覆盖、构成变化和不确定性；不要把程序质量评分当作成功概率。
7. 可信度以 1% 为步长；优先使用 ≥70% 的区间，否则使用 40%–69%，再否则使用全部可匹配区间。`evidence_json.qualitySelection` 保存选择档次、纳入和筛除数量，低质量原始记录没有删除。
8. `quota_intervals.record_json.provisionalEstimate` 是临时估算；原始状态和原始 token 字段仍保留。缓存补估写在推算依据及 `imputation` 中，不能当作 `usage_events` 的实测缓存。`strictGroups` 保留严格匹配结果。真正无消费依据时不生成虚假额度。

示例：按日期、产品、模型和档位统计。

```sql
SELECT * FROM v_daily_usage
ORDER BY local_date, source, raw_model, thinking, context_band;
```

示例：按用户轮次查看 token，同时关联问题内容，先聚合再连接，避免重复计数。

```sql
WITH turns AS (
  SELECT source, session_id, agent_id, turn_id, COUNT(*) AS calls,
         SUM(input_other_tokens + COALESCE(cache_read_tokens,0)
             + COALESCE(cache_write_tokens,0) + output_tokens) AS known_tokens,
         SUM(total_tokens IS NULL) AS unknown_calls
  FROM usage_events
  WHERE turn_id IS NOT NULL
  GROUP BY source, session_id, agent_id, turn_id
)
SELECT t.*, m.occurred_at, m.content_text
FROM turns t LEFT JOIN conversation_messages m
  ON m.source=t.source AND m.session_id=t.session_id
 AND m.agent_id=t.agent_id AND m.turn_id=t.turn_id AND m.role='user'
ORDER BY m.occurred_at;
```

## 获取可交给 AI 的独立数据库

看板的“下载 SQLite 分析快照”会使用 SQLite 在线备份接口生成一致的独立文件，后台可以继续运行。下载文件包含已采集的会话正文。不要直接复制运行中数据库的单个主文件而忽略 WAL；应使用这个下载功能，或停止监控后再复制完整数据库。

数据库、备份、运行日志和个人报告都在 Git 忽略范围内。系统不会自动将这些内容上传给外部 AI；后续分析可以直接在本机读取该文件。
