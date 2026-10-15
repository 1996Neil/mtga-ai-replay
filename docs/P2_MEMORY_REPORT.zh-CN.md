# Replay 2.0 P2 内存专项报告

写作结构：先给验收结果，再用阶段证据解释峰值来源，最后列出正确性回归、复现步骤和未覆盖的边界。

本轮基线固定 PR #7 的 `bf70d7934e9aa5d3b9c06f93b41b335f0697525b`。修改位于独立工作树和分支，不改写 PR #7，不合并、不部署。真实回放使用只读副本；报告为合成 V2/V1 测试数据，不代表模型分析质量或真实 GitHub 网络表现。

五组正式 A/B 的峰值 RSS 中位数从 **1,986.8 降至 821.1 MiB（降低 58.7%）**，最差从 2,147.8 降至 **828.2 MiB**，低于 1,400 MiB 目标。首次同步中位数 28.565→25.945 秒，最差 27.857 秒，CPU 中位数降低约 9.9%。

**响应目标尚未验收通过：**SQLite/HTTP入口补测的B主线程为216.7ms、HTTP为200.5ms，见文末单列证据。五组预载对照中，**主线程 ≤100ms 也未全部达到：**B 第五次为 **141.7ms**，其余四次为 77.3–97.3ms；不能宣称本轮全部目标通过。HTTP 最差 89.4ms，五次均低于 100ms，探针失败为 0。内存改进没有借助关闭校验或把重 CPU 迁回主线程。下一阶段应继续检查大输入 structured clone 和主线程 GC/调度；目前无法把该次超标精确归因给单一函数。

正式样本是本机开发实验，**不是生产 P95**。A 为准确 PR #7，B 为本 PR 生产补丁；完整样本、15 次热读、CPU/Git、标准差和 MAD 在 [JSON](evidence/p2-memory/ab-samples.json) / [CSV](evidence/p2-memory/ab-samples.csv)。

| 配对 | 版本 | 峰值 RSS MiB | 首次同步 s | Node CPU s | 主循环最长 ms | HTTP 最长 ms |
|---|---|---:|---:|---:|---:|---:|
| 1 | A | 2131.4 | 29.252 | 21.877 | 92.1 | 68.6 |
| 1 | B | 821.1 | 25.462 | 19.138 | 80.6 | 59.9 |
| 2 | A | 1986.8 | 27.627 | 21.355 | 74.4 | 31.1 |
| 2 | B | 811.8 | 25.945 | 19.476 | 77.3 | 42.3 |
| 3 | A | 1983.5 | 28.565 | 21.623 | 85.6 | 66.1 |
| 3 | B | 809.4 | 25.763 | 19.346 | 97.3 | 52.4 |
| 4 | A | 2147.8 | 28.013 | 21.552 | 73.3 | 44.1 |
| 4 | B | 825.8 | 27.572 | 19.905 | 97.1 | 37.1 |
| 5 | A | 1983.0 | 29.559 | 22.106 | 91.0 | 65.6 |
| 5 | B | 828.2 | 27.857 | 19.811 | 141.7 | 89.4 |

任务结束后 RSS 中位数 **1,442.4→754.8 MiB**；30s 为 **1,201.7→716.5 MiB**；60s 为 **1,198.1→717.7 MiB**。A 第二次 60s 自然下降至 477.0 MiB，低于 B 对应 715.1 MiB，所以不能承诺每一次空闲 RSS 都更低。两版均保留 replay loader 所持输入与常规读取池，RSS 不会归零。

| 配对 | 任务后 RSS A→B MiB | 30s RSS A→B MiB | 60s RSS A→B MiB | 热读中位数 A→B ms（三次/版本） |
|---|---:|---:|---:|---:|
| 1 | 1508.5→773.9 | 1206.6→736.5 | 1207.8→737.8 | 216.2→221.1 |
| 2 | 1442.4→752.5 | 1201.7→714.7 | 477.0→715.1 | 220.6→221.2 |
| 3 | 1438.7→750.4 | 1199.5→713.4 | 1200.8→714.6 | 217.6→218.2 |
| 4 | 1524.9→759.4 | 1221.6→722.4 | 927.6→723.6 | 222.7→212.6 |
| 5 | 1438.2→754.8 | 1198.0→716.5 | 1198.1→717.7 | 227.9→234.3 |

15 次热读总样本中位数 A/B 为 **220.6/221.1ms**，最大 **231.7/238.6ms**，没有得到热读加速结论。峰值 RSS 标准差 A/B 为 76.2/7.5 MiB，MAD 为 3.8/7.1 MiB；冷墙钟标准差 0.726/0.992 秒，MAD 0.687/0.484 秒。只有五组，不能据此估计生产尾延迟或置信区间。所有正式运行中的生产源码、基线 tracked tree 和测量 harness 均核验未变；[冻结摘要](evidence/p2-memory/freeze.json) 可核对。


## 峰值来自哪里

先在不改动基线工作树的情况下，生成私有观测副本。临时观测覆盖 Git fetch、全历史验证、分片读取、Worker 传输、源展开、完整局面隐私校验、本地 bundle 重建、指纹、缓存写入和 Worker 退出。观测只记录数字，不生成或发布 heap dump。

807 动作基线的阶段观测单次峰值为 **2,004.2 MiB**，墙钟 28.262 秒。下表是阶段边界，边界之间的定时采样另外保留峰值；RSS 包含全部 Worker，不能与 Worker RSS 再相加。heapUsed 为当时相应 isolate，不能把不同时刻的堆简单相加。

| 阶段 | Node RSS（MiB） | 相关 isolate heapUsed（MiB） | 观察 |
|---|---:|---:|---|
| Git 全历史验证前 | 210.5 | — | 严格历史扫描仍启用 |
| Git 全历史验证后 | 571.9 | parent 41.7 | 验证 Worker/分配器已有驻留 |
| sourceInput 收集完成 | 604.1 | — | 原始分片约 50.4 MiB |
| postMessage 前→后 | 604.2→622.9 | — | 克隆有代价，但不是约 2 GiB 的主峰 |
| Worker 开始源验证 | 740.4 | worker 50.4 | external 55.6 MiB |
| 分片 JSON 解析后 | 853.7 | worker 127.3 | 原始字节与解析对象共存 |
| resolve 全量展开后 | 891.1 | worker 168.3 | 尚未到最高峰 |
| 源连续值隐私校验后 | 1,435.7 | worker 408.5 | 此区间采样峰值 1,597.8 MiB |
| 本地 games 重建后 | 1,489.8 | worker 487.0 | 源验证与新 bundle 中间对象相邻驻留 |
| 本地连续值隐私校验后 | 1,948.5 | worker 907.5 | 此区间达到总峰 2,004.2 MiB |
| multipart 后 | 1,491.9 | worker 299.8 | GC 已释放一批临时对象 |
| 哈希阶段后 | 1,418.8 | worker 203.2 | 不代表 RSS 已全部退还系统 |
| 首次 ready 读取后 | 1,460.5 | parent 46.2 | 30s/60s 仍约 1,219.8 MiB |

证据支持的主要来源是两次额外的全量 `serializeCoachJson → JSON.parse → 隐私扫描`，叠加源对象、本地重建对象和历史校验 Worker 的生命周期重叠。仅把计算挪到 Worker 并不能消除这些驻留。阶段记录观察到重型 Worker 的 GC 延迟最高约 295ms，但它发生在 Worker，不能当成主线程停顿。GC observer 的回调会延后，不能把累计 GC 精确归属到某个边界。

Git 单进程采样峰值约 84.8 MiB，Git 并发进程合计约 119.4 MiB，单独记账，不包含在 Node RSS 中。这是 100ms OS 采样观察到的峰值，短命进程可能漏采。没有证据支持把主要峰值归因于 Git 子进程。任务完成后 RSS 高于仍存活 JS 堆，可能包含 native allocator/V8 页驻留；本轮没有用 heap dump 或 allocator 专用工具证明泄漏，不能把 RSS 滞留直接称为对象泄漏。

最终补丁的独立插桩样本峰值 **811.6 MiB**，墙钟 25.759 秒，主循环 82.8ms、HTTP 43.5ms。相同节点对比如下，完整数字和 100ms 桶内最大 RSS 轨迹见[基线观测](evidence/p2-memory/profile-baseline-ready.json)与[最终观测](evidence/p2-memory/profile-B2-final.json)。

| 相同阶段边界 | A RSS→B RSS MiB | A Worker heap→B Worker heap MiB |
|---|---:|---:|
| 源 resolve 后 | 891.1→770.6 | 168.3→147.8 |
| 源连续值检查后 | 1,435.7→810.5 | 408.5→147.2 |
| 本地连续值检查前 | 1,501.3→695.3 | 452.9→155.4 |
| 本地连续值检查后 | 1,948.5→729.7 | 907.5→151.1 |
| multipart 后 | 1,491.9→757.6 | 299.8→185.3 |

最终样本中，历史池在约 12.148s 退出、源池在 19.642s 退出、本地池在 25.290s 退出；对应回收顺序还由原生 Worker 生命周期测试验证。最大 postMessage 同步调用约 80.5ms（本地输入）、73.0ms（指纹）、67.7ms（读取），比原始分片 Map 的 6.1ms 显著。它们是剩余主线程风险的实测候选，但该插桩样本没有复现正式 B5 的 141.7ms，不能据此断言已经找到 B5 的唯一原因。B5 数值采样在约 27.22s 记录到 149ms 间隔，接近末尾指纹/首次呈现阶段；没有当时的栈观测，归因到具体函数仍待验证。

工具开销不能从单次差值精确分离：A 插桩 28.262s 对比未插桩中位 28.565s（−1.1%），B 插桩 25.759s 对比 25.945s（−0.7%），均处于样本波动范围。峰值 A 插桩比中位高 0.9%，B 低 1.2%。这些数字说明观测本身和调度噪声需要一起记录，不能解释为插桩会加速；没有足够样本给出纯工具成本置信区间。

## 最小改动及安全边界

1. **分阶段持有重型 Worker。** Git/历史检查、源验证、本地重建各有短寿命池；前一阶段 `close()` 完成才开始下一阶段。常规读取和指纹使用独立小池。源能力对象留在验证 Worker，只返回小型卡牌字典和绑定字段；不把完整源局面带回主线程。
2. **清除已不需要的引用。** dispatch 后释放主进程的 sourceInput/replay 引用，Worker 只清理自己的 structured-cloned Map，调用者的 Map 不受影响。关闭、异常均通过 `finally` 等待回收；受信任的外部注入池仍由其所有者管理。
3. **移除整棵树的重复 clone。** multipart 只复制会替换字段的根容器和 game 容器，使用已经清洗、由本次构建拥有的只读行。summary 的生命值和 coverage 保持独立小副本。以八场所有输出文件的精确字节摘要作为兼容性检查。
4. **避免额外大 JSON 往返。** `validateExpandedCoach` 只用于已经解析/清洗的 `MTGA_FULL_COACH_V1` 普通对象。完整遍历语义 key 和 string，保留原文字规则、转义文字和编码 key 加冒号的检查，不截断。拒绝 getter、可执行 toJSON、异常原型、循环和继承数组索引；测试证明不触发 getter。它不接受任意路径，不代替原始文件验证，也不是任意 JavaScript Proxy 沙箱。

所有原始文件仍执行原有 UTF-8、JSON/raw key、完整文本隐私扫描；所有源文件的大小、每片 SHA-256、manifest/content_hash、严格 resolve 限制、隐藏手牌与锚点检查均保留。完整本地 bundle hash、当前输入指纹、SQLite 回执复核、全历史 Git 身份/路径/权限/分支检查均保留。没有提高内存上限、减少动作、放宽节点限制或关闭校验，没有新增依赖，也没有修改 Viewer。

只实施阶段拆分和 shallow clone 的早期 B1 试跑仍有 **1,607.5 MiB** 峰值，未达到 1,400 MiB；因此继续处理全量 JSON 往返。B1 插桩试跑墙钟 **31.596 秒**，也超出目标。这些探索值与最初 stale fixture/插桩缺 schema 的失败记录保留在本地，不冒充正式 A/B 或成功样本。

## 测量口径与复现

环境：Apple M1 Pro、32 GiB RAM、macOS 27.0.1 arm64、Node v24.19.0；默认 GC，没有 `--expose-gc`、手动 GC 或 `--max-old-space-size`。固定一份 807 动作回放、同一卡牌字典、同一份合成 V2 报告和同一 local bare revision。按 AB、BA、AB、BA、AB 顺序串行运行五组，每次新进程、新缓存目录；没有同时运行本任务的测试/build。现有桌面和系统背景进程保留，因此仍有系统噪声。Git/Linux/GitHub 网络或其他机器的性能不能从此推导。

每次冷测从 reader 启动同步到首次 ready 规范化读取完成；每次随后等待 30s/60s，再做三次已缓存读取。Node RSS 20ms 采样与内核 `maxRSS` 取较大值，独立 OS 进程另以 100ms 采样 Node/Git，独立 HTTP 进程每 100ms 访问 health。主循环监视分辨率 5ms，HTTP 响应与 UI 浏览器绘制是不同证据，后者本轮没有测量。CPU 是 Node 进程全部线程累计 CPU，不包括 Git CPU。

正式比较使用预载只读 JSON 对象的 replay loader，与 P1 的计算路径对照口径相同；不包含 SQLite 每次读盘/JSON.parse、浏览器首屏、外部网络或模型推理。它不能直接证明现有桌面的完整端到端耗时。一次额外的阶段插桩样本只用于归因，不纳入五组统计。工具自身也有开销：phase hook 会传输少量数值，RSS/OS/HTTP 采样会竞争资源。报告保留插桩与未插桩观测值，不把它们的差值误称为纯工具开销。

以下均需显式提供私有副本路径，工具不会自动读取真实历史或连接真实数据仓库：

```sh
# 在准确 bf70d79 工作树准备新的私有 local bare；所有输出留在源码目录之外。
node scripts/prepare-cloud-memory-fixture.mjs --source="$BASELINE" --replay="$COPY" --cards="$CARDS" --output="$NEW_FIXTURE"
node scripts/run-cloud-memory-ab.mjs --baseline="$BASELINE" --candidate="$CANDIDATE" --fixture="$NEW_FIXTURE/fixture.json" --output="$NEW_AB"
# 每个回放分别生成基线，并比较 candidate 的全部输出字节。
node scripts/prepare-cloud-memory-fixture.mjs --source="$CANDIDATE" --replay="$COPY" --cards="$CARDS" --output="$NEW_FIXTURE" --compare="$NEW_FIXTURE/bundle-fingerprints.json"
node scripts/verify-cloud-memory-fixture.mjs --source="$CANDIDATE" --fixture="$NEW_FIXTURE/fixture.json" --output="$NEW_CHECK" --repeat=3 --faults=true
# 阶段观测只修改新的私有副本。
python3 scripts/instrument-cloud-memory.py "$BASELINE" "$NEW_PROFILE_SOURCE"
node scripts/profile-cloud-memory.mjs --source="$NEW_PROFILE_SOURCE" --fixture="$NEW_FIXTURE/fixture.json" --output="$NEW_PROFILE_RESULT" --settle=60
```

真实牌局、ID、完整日志、私有目录路径、heap dump、逐行历史摘要均不进入源码仓库。提交中的证据只有数值、源代码摘要和测试结果。回退可直接保留 PR #7 原版本；本 PR 独立、尚未合并，不需要改写真实数据或回滚桌面。

五组正式测量使用的[原始 harness 文本存档](evidence/p2-memory/measurement-harness.mjs.txt)与冻结 SHA 一致，供审查，不应当作当前工具运行。正式十轮后才补充输出目录防覆盖、Git 环境清理、真实路径防别名和可选 SQLite 模式；原五组的测量步骤没有被追溯改写。该轮继承的 Git 环境变量只有 `GIT_PAGER`，没有 Git 目录、对象库、索引或配置定向变量，实际路径均在私有实验目录内。临时 runner 的原始副本含机器路径，留在本地私有证据目录，不上传。

## 正确性与数据隔离

八场动作数 **340、382、387、391、545、548、561、807** 的真实 Quick Draft 只读副本，逐场用准确基线构建，再对最终补丁全部 summary/coach/cards/manifest/parts/index 文件的字节 SHA-256 比较，八场一致。每场经过真实 local bare Git fetch、全历史扫描、严格源校验和本地重建后为 ready；每场检查两个不同节点的 before/after、可见英文卡名、critical + possible_error + low 的独立语义，以及三次热读和本地变化失效。

807 场完成三次同步。340 场另外覆盖网络中断、Worker 失败保留合法缓存、仅远端源更新使旧报告 stale、无报告 missing、V1 兼容、同场/跨场竞争与关闭。远端更新测试对克隆构建，断言原本地输入和上传 state 文件 SHA 不变，排除“只是本地变化导致 stale”的假阳性。所有 Worker 退出断言通过。总计 **73 项断言**，见[逐场结果](evidence/p2-memory/corpus-results.json)。这些是合成报告配合真实回放的隔离测试，不是真实 Agent 或 GitHub 写入验收。

真实本地数据库仅通过只读连接核对。**171 场 replay、1 条 Coach Note、1,045 条卡牌行**和轮抽库的88条成员、15条 run、1条 meta，所有原有逻辑行 SHA-256 均不变，无删除或新增；逐行摘要留在私有目录，仅提交[计数及比较结果](evidence/p2-memory/integrity-result.json)。正在运行的桌面进程未替换或重启。

新增自动测试覆盖连续值检查与原字节检查的确定性差分、转义/凭据/路径、getter/toJSON/稀疏数组继承索引、摘要别名隔离，真实 Worker 的阶段退出/异常/关闭，以及工具拒绝覆盖已有证据和拒绝源码内私有输出。已有原比赛上传/Agent CAS 共存、并发冲突、分支变更及恶意历史测试完整保留。

最终本地检查：**后端 417 PASS / 0 FAIL / 8 SKIP，Viewer 80 PASS / 0 FAIL**；类型检查、Viewer build 和完整 release scan 通过，后者覆盖本地46个可达历史提交、索引和19个固定摘要 Viewer 文件。8 SKIP 是原有锁定私有语料检查，未被删除或伪造通过；本次要求的八场真实副本由上面的独立回归完成。[检查摘要](evidence/p2-memory/checks.json)。

首次全量尝试因旧并发测试仍等待拆分前的 `cloudReviewSync` 断点而挂起，主动终止并保留日志，未计为通过。断点移到 `cloudReviewLocal`，保留“旧任务晚到不能覆盖最新报告”的全部断言。旧语音路由测试另显式关闭真实日志观察，避免隔离路由测试扫描本机日志；原有权限断言保留。修正后完整套件全部通过。

[独立审查](evidence/p2-memory/independent-review.zh-CN.md)实际另跑22项并全部通过，未发现生产安全或生命周期阻塞问题；明确保留141.7ms主线程未达项。该结论不替代完整 CI 或真实桌面验收。远端 CI 以此 Draft PR 的 Checks 页面为准，不把本地结果冒充远端结果。

## SQLite 与 HTTP 入口补测：响应目标仍不通过

另外使用同一只读807动作副本创建新的隔离 SQLite，loader 改为生产 `getReplay` 的只读查询/JSON.parse，通过受保护的同源 HTTP POST 启动同步；没有访问真实数据库写路径。A/B各一次，正常GC，同样等待30s/60s并进行三次热读；该组**不混入前面的五组预载数据统计**。

| 指标 | A | B |
|---|---:|---:|
| 峰值 Node RSS | 2095.9 MiB | 1040.0 MiB |
| 首次同步 | 28.5 s | 27.7 s |
| 主循环最长 | 177.2 ms | 216.7 ms |
| HTTP 最长 | 169.6 ms | 200.5 ms |
| 任务后 RSS | 1636.1 MiB | 1036.0 MiB |
| 30s RSS | 1397.2 MiB | 997.5 MiB |
| 60s RSS | 1398.4 MiB | 997.6 MiB |

这一组再次支持内存降低，但**两版主线程和HTTP均超过100ms，B单次尾值还高于A**。不能宣称保住了完整桌面链路的全部响应指标。只有一组，不足以判断该差异是否稳定或由哪一处变化导致；也没有实际浏览器绘制/交互采样。完整数字和热读样本见[补测证据](evidence/p2-memory/sqlite-supplement.json)。

该 loader 每次产生新的对象，生产同步还要做完整本地绑定、当前指纹和首次呈现传输；它们是后续应继续分阶段采样的候选。当前没有这次超标的调用栈，不能把全部时间确定归到SQLite或某个postMessage。新SQLite的准备发生在冷墙钟计时前，内核maxRSS仍包含进程启动/准备成本，CPU计时不包括准备。不能把此组解读为真实数据仓库、外网、运行中桌面或模型性能验收。

建议保持 Draft。下一阶段先对SQLite读取/JSON.parse与IPC传输分别做栈/时间观测，再考虑带版本绑定的分帧传输或装载复用。当前保留全部校验和正确性，不为低于100ms跳过当前指纹或改变原始数据。
