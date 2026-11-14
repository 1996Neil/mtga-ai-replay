# Replay 2.0 P1 中文审查与隔离验收报告

2026-10-15。结论：真实 GitHub 受限发布和重要程度/置信度分离已实现，并完成合成单场在线实验；807 动作的同步响应显著改善，峰值内存仍高。本轮只支持 Draft PR，不构成桌面部署或真实比赛写入批准。

阅读顺序：先回答连接器和判断维度两个问题，再给真实 GitHub 与实机性能证据，最后列历史完整性、测试和剩余边界。

## 基线与范围

起始独立核对 PR #6 仍是 OPEN/Draft，head 为 `51d6b8bb96e3a935aafca1e281af86e05fc5afa5`；源码工作树干净，外层维护仓库及原桌面目录有未提交工作。新建隔离分支 codex/replay2-cloud-p1-20261015，从这个固定提交开始，先提交任务契约 `826b858`，再增量实现。没有重写 Replay、改写 #6 或合并旧 PR。

本机当前基线是 171 场比赛、1 条 Coach Note。P0 的 161 场和那条笔记在本轮开始时仍全部哈希一致；新增 10 场在本轮开始前已存在。不能把旧快照数量当成本轮当前数量，也不能把新增记录算作本轮修改。

## 问题一：连接器能否满足身份及 CAS

**不能仅凭现有连接器声明保证完整契约。** create_commit 没有显式 author/committer 参数；update_ref.expected_sha 只解决预期版本，不能补足提交身份。本轮没有凭空断言默认身份是什么，更没有放宽历史身份验证。

最小实现是 [受限适配器](../src/review/github-review-writer.mjs)：精确准入 PRIVATE 仓库双 ID、默认分支、match/game；完整 fetch/历史校验后重建 P0 计划；REST 显式双 noreply 身份、唯一父、唯一 review 文件；下载 candidate 原始 Git 对象再次校验；GraphQL beforeOid + force=false 更新；最后独立读取并验证实际回执。来源、英文牌名、局数、锚点、原 blob 和内容 hash 检查均保留。

GitHub 官方 [REST commit](https://docs.github.com/en/rest/git/commits#create-a-commit) 文档支持显式双身份；[GraphQL updateRefs](https://docs.github.com/en/graphql/reference/git#updaterefs) 文档及现场 schema introspection 支持 beforeOid 和原子更新。仅凭 REST 快进检查不足以替代精确旧 head。

## 问题二：重要程度与判断置信度

原实现无条件把 critical/major 降为 tip，与 confidence 无关。现在 V2 分开 importance、assessment、confidence：关键程度决定关注顺序，判断性质说明“策略建议/建议核查/值得保留”，置信度独立显示。关键但低置信度的建议保持醒目橙色，并注明“AI 判断：建议核查 · 不代表规则裁定”。提高置信度也不会自动升级为“确定错误”。

没有完整规则引擎，因此 V2 不提供 confirmed_error，也拒绝自称 proof 的额外字段。V1 保留历史字节，只做保守展示适配。27 种维度组合和负向输入已测试；旧 severity 展示字段保持 tip，保护旧 Viewer，新版按独立 importance/assessment 选醒目程度。旧本地模型模块继续使用原有保守行为。详见 [P1 协议](CLOUD_REVIEW_P1_PROTOCOL.md)、[V2 Schema](../schemas/MTGA_AI_REVIEW_V2.schema.json) 和 [合成样例](../examples/cloud-review/ready-v2.json)。

## 真实 GitHub 隔离实验

新建专用 [PRIVATE sandbox](https://github.com/1996Neil/mtga-replay-p1-sandbox-20261015)，只写 synthetic-match-one 合成数据。没有上传真实回放、Notes、截图或缓存。实际使用现有比赛上传器、P0 publishCloudReview 和本轮适配器，执行：

`合成比赛上传 → 复盘提交 → 读取/同步 → 两个不同候选并发 CAS → 回执丢失模拟 → 比赛再次上传 → 旧报告失效`

- 首次真实复盘提交 [565449d](https://github.com/1996Neil/mtga-replay-p1-sandbox-20261015/commit/565449d2738912cdc77ca84cfc9603e0b9dd5335)，最后补强版提交 [aa6ba08](https://github.com/1996Neil/mtga-replay-p1-sandbox-20261015/commit/aa6ba087d90fc0ced9f4287fc1c050f10a1dc883)。独立审查者只读核实后者真实存在、精确双身份和唯一 parent。
- 两个候选均等到实际 CAS 阶段：1 个接受、1 个拒绝，force=false。错误原 blob 在写前拒绝。
- 真实 CAS 被服务器接受后，工具层模拟丢失回执：只发送 1 次 mutation，返回 unconfirmed，没有重试或回滚；随后独立读取确认已持久化内容。
- 原上传器在 review 提交后正常上传比赛更新，review 文件字节不变，旧报告失效。额外使用另一个隔离上传目录模拟其他设备更新远端源；原 reader 的本地输入和上传 state 完全不变，仍检测 stale，重启后也保持 stale。
- 额外错 expected-head 请求被 GitHub 拒绝且 ref 未变；相同目标与 afterOid、正确 beforeOid 的无变化对照请求成功。错误旧值时服务返回通用执行错误，没有结构化 CAS 冲突码，因此不将所有网络/服务错误归因为确定冲突；适配器统一保守报告“冲突或结果未确认”。

[在线复现脚本](../scripts/verify-cloud-github.mjs) 限定空、新建、PRIVATE、专用名称/描述的 sandbox 和新目录，不能指向真实数据或源码仓库。真实比赛的单场准入仍待用户明确批准。

## 807 动作：首次同步的成本与响应

使用同一真实 Quick Draft 只读副本、本地 bare Git 路由、相同 V1 合成报告、独立新进程和空缓存对比 P0 与 P1。真实比赛字节没有联网发布。Node CPU 包括 worker 线程，RSS 是同一 Node 进程含 workers；不包括浏览器、探针子进程和 Git 子进程。HTTP 探针独立于被测主线程，每约 100ms 请求一次，避免主线程卡住时漏测。桌面其他进程未停止，以下是单次样本，不是生产 P95 或网络 SLA。

| 指标 | P0 | P1 冻结主体实现 |
| --- | ---: | ---: |
| 总耗时 | 27.12 s | 26.96 s |
| Node CPU | 20.63 s | 20.67 s |
| 主事件循环最长停顿 | 8233.4 ms | 83.2 ms |
| 主事件循环样本 P99 | 42.7 ms | 11.3 ms |
| 独立 HTTP 探针最长响应 | 6875.9 ms | 34.9 ms |
| HTTP 探针失败数/总数 | 1 / 114 | 0 / 265 |
| Node RSS 峰值 | 1285.2 MiB | 2061.0 MiB |

**取舍明确：CPU 和总时长基本持平，主线程响应改善，内存峰值增加。** 大对象跨线程复制和完整 bundle 验证仍有成本。任务完成后主动回收大计算 worker，但样本任务后 RSS 仍约 1516.5 MiB；不能声称低内存优化完成。最后加入的读取回执复核属于小范围同步 SQLite/配置读取，另有针对性与冻结全量测试；上表不是对该几毫秒差异的精确测量。

真实浏览器另以 V2 合成报告验收：首次同步 31.36 s、事件循环最长 82.4 ms、独立 HTTP 最长 39.4 ms、0/307 失败、RSS 峰值 2077.2 MiB。该时长包括交互启动和额外轮询，不能与上一行直接计算提速。

同步期间实际操作“下一步”成功，再把时间轴定位到 T38-A17（725/807）；完成后 8 个标记、动作前边界、可见英文牌名和浮窗均可用。低置信度关键决策保持橙色，浮窗键盘移动从 x=861 到 881、宽 375，未越过 1280×720 视口。数据完整性、高级工具及 Coach Context 下载保留。同步合成过期报告后 8 个旧标记全部清除，时间轴仍停在 725/807。

## 持久化失效与独立审查

发现并修复三条异步路径：

1. 远端已知 stale 只留在内存 task，重启可能恢复旧 cache：现在持久化 stale 并清缓存。
2. 同分支的旧 worker 晚到可覆盖较新报告：每个 repo/branch/match/game 保存已观察 revision，缓存事务在写前比较 receipt；不会全局失效其他比赛。
3. 旧 read worker 已取得 cache 后，另一 reader 将其失效，旧 read 仍返回 ready：worker 返回后再次核对配置 hash、分支、revision、report、fingerprint 及 ready 回执。

新增的冷启动、共享 SQLite、阻塞 worker 和跨场测试覆盖上述路径。独立审查还促成 V2 唯一 $id 和原始 candidate 精确身份补强。最终结论：**未发现阻塞本轮 Draft PR 的问题**，仅支持隔离候选，不批准合并或部署。

## 测试与历史完整性

自动测试最终计数及发布扫描范围见 [结果文件](cloud-review-p1-results.json)。首轮完整后端为 413 项、405 PASS、0 FAIL、8 SKIP；补入 read 回执竞态回归后是 414 项、406 PASS、0 FAIL、8 SKIP。最后的旧 Viewer 兼容保护也已纳入最终冻结全量：**414 项、406 PASS、0 FAIL、8 SKIP、0 CANCEL**，约 295.4 秒。8 项为锁定私有语料测试，未冒称已执行。独立审查执行 22 项专项测试通过，并重跑最终协议 7 项和展示 2 项；这些组有重叠，不累加为唯一总数。读取回执最终专项 12 PASS，最终语义/reader 专项 25 PASS。

Viewer 最终 **80 PASS、0 FAIL**，类型检查与生产构建通过，产物 gzip 85.21 kB。无新增运行依赖，两个已有锁定依赖安装审计均为 0 漏洞。完整发布扫描通过：269 个历史并集路径、19 个 manifest 固定 Viewer 文件、已取得 refs 可达 41 个完整提交，shallow=false，包含 tree/metadata/index/工作区检查。最终新增报告、结果文件及最后补丁另做同规则 index/工作区增量检查，新提交元数据独立检查，不将先前 scope 冒称更新后的整份历史重扫。

原 SQLite 数据库只读逐行计算 SHA-256：本轮前后均为 **171 场比赛、1 条 Coach Note**，全部原始逻辑行内容一致；其中 P0 的 **161 场/1 条**仍完整。只修改隔离缓存、测试目录、合成 sandbox 和新源码分支，没有替换桌面、合并旧 PR、改名、配置后台任务或调用收费 API。

截图与含真实回放的原始证据仅留在本机交付目录，未提交源码仓库：sync-responsive-807.jpg、critical-low-confidence-807.jpg、anchor-725-and-tools.jpg、stale-markers-cleared-807.jpg。

## 剩余边界

- 真实数据仓库的单场写入尚未授权、未执行；真实比赛/Agent 分析质量、收费模型性能未测试。
- 适配器是受信任工具进程可调用的代码，不是已经安装并授予普通云端会话的新 MCP 服务；权限配置与真实准入留待批准。
- 约 2 GiB 的首次峰值内存仍是部署前要处理的风险；本轮改善的是响应性，不是全面性能达标。
- fetch.lock 的中断恢复继续保留原人工核验边界，没有自动删除未知锁；GitHub 通用错误与网络不确定结果不能冒充确定 CAS 冲突。
- 隔离 sandbox 保留，便于核对真实提交；没有自动删除远端仓库或清理其他人的任务/目录。
