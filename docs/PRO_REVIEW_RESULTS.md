# Replay 2.0：Pro 独立审查与修复

审查日期：2026-10-10（UTC）。目标提交：`fca87281749ae17cafac8b27974cee69203f6209`；main 对照：`30d93007dc5c45cf600a213056c1cbc6566ddf77`。修复分支：`pro/replay2-sync-audit-20261010`。

**结论：不建议直接合并原 fca8728。确认 6 条 P1 发现并完成最小修复；合成工作负载上的提速已经测得，真实 Mac 上传、收藏数量与通知横幅仍待本机验收。** 本轮没有确认 P0，这只是当前可见源码和实际检查范围的结论。没有合并 main、部署、上传真实记录、调用模型/TTS 或改变权限。

以下原代码行号全部指 fca8728。完整计数、测量说明和生产源码 SHA-256 见 [pro-review-benchmarks.json](pro-review-benchmarks.json)；改动文件的前后摘要见 [pro-review-manifest.json](pro-review-manifest.json)。原 runtime-export 清单保留原义，不把未部署的修复冒充已部署版本。完整执行日志随审查证据附件交付。

## 一、P0 / P1 / P2 发现

### P1-S1：Git tree 替身可隐藏将被推送的秘密祖先（已修复）

- **位置：** `src/sync-security.mjs:301–311`。原逻辑校验 commit/blob 原始摘要，却通过 `ls-tree` 解释历史 tree。
- **触发：** 构造“安全 root → 含合成密码的 ancestor → 安全 main tip”；当前 index 和工作区安全，再用本地 tree replacement 将恶意祖先的 tree 替换为安全视图。
- **影响与证据：** 原 validator 先返回成功，随后真实本地 bare 的 `push main` 带出原始祖先密码；远端当前 tip 仍安全。修复版在 push 前以 `invalid-git-object` 拒绝，目标 refs 为空。证据：`security/replacement-main-proof.log`、`tree-replacement-proof.json` 及逐命令原始输出。
- **最小修复：** 批量读取、验证每个原始 tree 的类型、长度和 Git 摘要，再按 tree hash 与路径前缀遍历叶子。替身的内容与所请求对象 hash 不符即失败。
- **归因与范围：** main 已有此缺口，并非本 PR 新增；证明的是向所配置数据仓库泄漏的可能性，没有声称真实数据已泄漏或仓库公开。

### P1-S2：用户的 followTags 配置可附送未经检查的标签元数据（已修复）

- **位置：** `src/coach-sync.mjs:280–291`，实际 push 在原 476–482 行。
- **触发：** 本地 `push.followTags=true`，待发布分支有 annotated tag，tagger 或 annotation 包含私人信息。
- **影响与证据：** 通过真实 `syncCoachBundles` 向临时 bare 发布，原版成功后远端确有合成私密 tag。修复后回放仍发布成功、远端 tags 为空，用户本地配置仍是 true。证据：`security/follow-tags-before.log` 与 `follow-tags-after.log`。
- **最小修复：** 仅给这次 push 增加 `-c push.followTags=false`，限制为所请求的数据分支；不修改用户配置。此缺口 main 同样存在。

### P1-L1：收到 POST 响应头后断流，不能接回已启动的后台任务（已修复）

- **位置：** `viewer/src/lib/taskClient.ts:59–63`。原 `response.json()` 在丢回执恢复 catch 外。
- **触发：** POST 已被接受并返回 202 headers，JSON body 读取中途断开。
- **影响与证据：** 客户端直接抛 socket/body 错误而不 GET 接回任务。真实 loopback server 发送部分 JSON 后关闭 socket：原版失败，修复版 GET 恢复同一新任务，POST 计数仍为 1。证据：`tasks/original-lifecycle-probes-http.log` 与 `patched-lifecycle-probes-http.log`。
- **最小修复：** fetch 与成功 JSON 读取进入同一恢复分支；通过 GET 对账，不自动重复 POST。

### P1-L2：旧的完成结果可能被误报为本次点击成功（已修复）

- **位置：** `viewer/src/lib/taskClient.ts:19,32–33,57,61`。原基线只来自该 client 过去观察到的 id。
- **触发：** 新 client 没有观察基线，或本页停止轮询后另一窗口已完成 B；本次 POST 没有送达/回执丢失，之后 GET 得到这个旧完成结果。
- **影响与证据：** 原版可显示已同步，但本次未创建新任务。两种情况都有修前失败、修后通过的冻结反例。
- **最小修复：** 每次明确启动先 GET 最新基线；若已有 running 则观察该任务，否则丢回执后只接纳不同于本次基线的 id。不在状态未知时自动重新 POST。
- **范围：** GET 与 POST 之间仍可有另一窗口启动任务；当前需求是观察共享后台任务，本轮没有扩成 request-ID 协议，不能证明一个新任务仅由本页发起。

### P1-C1：开始关服后仍能接受新数据任务（已修复）

- **位置：** `src/server.mjs:71–89,156–162`。
- **触发：** 任务业务已完成、通知仍在等待；close 捕获旧 completion 后，另一个 POST 创建新任务。
- **影响与证据：** 原请求仍返回 202，关服可能只等待旧 promise，新任务在进程退出时被中断。没有把合成反例扩大成真实发布数据损坏。两条 shutdown 回归的原始日志见 `collection/shutdown-before-both.log`。
- **最小修复：** 第一个 await 前同步设置 closing 门闩；写入口及异步 dispatch 后复查；close 幂等复用 promise。修后 replay/collection update/collection sync 三入口均返回 503，旧任务继续被等待。

### P1-C2：迟到的 POST body 可在 stop 后重新启动教练（已修复）

- **位置：** historical legacy integration; the live Coach route has since been removed from the public Replay source.
- **触发：** 合法 POST 只发送部分 body；服务已经 stop 教练、仍等待另一个后台任务；此时 body 才完整到达。
- **影响与证据：** 原版返回 200 并调用 start；修后返回 503、start 次数为 0。反例使用纯合成 runtime，没有真实模型或音频调用。
- **最小修复：** routes 接收只读 `isClosing` 回调，在 body await 后、动作之前重新核对。证据：`collection/shutdown-after.log`。

### P2：其它已修复项与保留边界

| 项目 | 原位置、触发与影响 | 本轮处置及证据 |
|---|---|---|
| 重复历史树遍历 | `sync-security.mjs:298–333`；每个 guard 对每个 commit 递归 ls-tree；历史增长导致数千 Git 子进程和重复路径输出 | 已改原始 tree 批处理；每个 guard 保留完整对象读取与 hash。性能见下一节 |
| 全卡目录指纹 | `sync-cache.mjs:82–91`；每生成一场，前后都读取全部缓存卡 JSON，包括无关卡 | 已按该回放实际可能读取的身份/关联面闭包取指纹，保留 DB/WAL/rules 全字节覆盖 |
| 旧完成污染新任务 | `viewer-task.mjs:17–25`；terminal 与通知准备处于不同 continuation，A 可给 B 写完成时间/通知 | 已捕获任务 id，并原子写入 terminal 元数据；精确微任务反例通过；没有宣称普通 HTTP 必然触发该精确窗口 |
| 迟到进度污染新任务 | `viewer-task.mjs:13–16`；A 保存的回调在 B 开始后继续写阶段 | 已按 id 和 running 状态拒绝；API 反例通过，未声称现有真实 workflow 已出现迟到回调 |
| 重新附着复用已取消观察 | `taskClient.ts:43,49,53,64`；同一 client abort 后尚未 settle 就 resume | 已跟踪 signal 和 promise 所有权，旧 finally 不清除新观察；反例通过 |
| 测试与实现脱节 | coach/collection fixture 没有转发或关闭 batch stdin；observer 测试仍假定 upload 负责导入；export 测试仍期待旧专用标题 | 只修 fixture 和过期断言。原 batch 单例 5 秒有界挂起；修后约 475 ms；observer 真实导入 1→3→5 后发布；原 export 失败亦独立复现 |
| 事件循环停顿仍存在 | `replay.mjs`、`log-reader.mjs`、`history.mjs` 及同步校验循环；函数有 async 不表示 CPU 工作移出主线程 | **保留。** 最终 500 场发布 max delay 约 1.13 s；短合成日志完整导入 max delay 83.56 ms。30 s 节流减少频率，不等于 worker 隔离 |
| 显式锁恢复的旧竞态 | `collection-update.mjs:91–96`；两个显式恢复命令交错，先来的 unlink 可删掉后来取得的活 operation 锁 | **保留的既有 P2。** 合成反例证明第二 reader 可在第一 reader 未完成时进入；未证明 save.lock 失效或数据损坏。建议独立恢复门闩，正常网页未暴露此命令 |
| 本地保存与错误语义不一致 | `collection-update.mjs:55–64`；快照指针已提交，后续诊断状态写失败 | **保留的既有 P2。** 受控 symlink 拒绝使 API 报错，但合成快照数量已从 3 变 4，哨兵未改变。建议区分提交前失败与提交后诊断失败；不能声称任何报错都保留旧当前值 |

最后两个收藏边界在 main 与目标的核心代码中完全相同。本轮不扩展既有收藏锁或双文件事务协议。账户切换保护还有限制：`collection.mjs:288–301` 是数量不减少/异常增长的启发式，没有账户身份字段，无法区分同收藏或小幅超集的另一个账号；不能将它描述为已绑定账户身份。

## 二、实际性能对照

### 方法与范围

同一 Linux / Node v24.19.0，按规模串行执行。每组总归档 N=10/100/500，远端预存 N−10 场，每个旧回放一个 commit，本次固定新增 10 场。每场相同 8 张已知公共卡和一个短动作；缓存预填 N×10 个卡 JSON；全新同步工作副本、临时 bare remote。计时内实际调用 `syncReplayHistory`，完成扫描、生成、pending、全部安全门、commit 和 push，最后独立核对 bare 的 index 数量及唯一性。

准备旧历史、依赖导入、配置、写入 archive，以及最终额外断言/清理均在计时外。页面观察和日志导入另测。fetch 被禁止并计数为 0，gh 可见性是固定合成 PRIVATE 响应；真实 Git fetch/push 被限定重定向到本地 bare。没有跳过安全门或绑定真实数据仓库。

### 总墙钟与重复工作

| 总归档 / 本次新增 | fca8728 | 最终修复版 | 耗时下降 | 成功 ls-tree 调用 | 卡 JSON 指纹成功打开次数 |
|---|---:|---:|---:|---:|---:|
| 10 / 10 | 1.847 s | 1.227 s | 33.6% | 55 → 0 | 2,000 → 160 |
| 100 / 10 | 12.905 s | 2.373 s | 81.6% | 1,496 → 1 | 20,000 → 160 |
| 500 / 10 | 93.620 s | 15.203 s | 83.8% | 7,896 → 1 | 100,000 → 160 |

100/500 组剩余的一次 ls-tree 用于查询 origin/main 中 index.json 是否存在，完整 guard 内的逐 commit 递归枚举已被替换。固定 8 张卡 × 前后两次指纹 × 10 场，得到 160 次实际成功卡文件打开。

| 安全及读取证据 | 10 场，前 → 后 | 100 场，前 → 后 | 500 场，前 → 后 |
|---|---:|---:|---:|
| 完整 validation 调用 | 17 → 17 | 17 → 17 | 17 → 17 |
| 成功 rev-list 调用 | 18 → 18 | 21 → 21 | 21 → 21 |
| 成功 cat-file 调用 | 42 → 82 | 64 → 128 | 106 → 170 |
| batch blob 读取次数 | 293 → 293 | 6,090 → 6,090 | 31,690 → 31,690 |
| batch blob payload bytes | 705,443 → 705,443 | 39,684,508 → 39,684,508 | 810,240,108 → 810,240,108 |
| 单一对象最多读取次数 | 11 → 11 | 16 → 16 | 16 → 16 |
| Git stdout bytes | 945,541 → 865,221 | 76,138,255 → 47,750,547 | 1,755,564,913 → 966,339,379 |
| 最大事件循环延迟 | 10.28 → 12.74 ms | 177.47 → 166.46 ms | 1,224.74 → 1,132.46 ms |

cat-file 次数增加，是新增 tree 原始完整性校验所需的批处理。500 场修复版明确读取并验证 143,196,695 bytes tree payload；blob 读取字节完全保留。语义 checked/reused 同样不变，500 场为 2,005 / 29,685；没有通过省略对象或复用永久“安全通过”来提速。

**计数口径：** Git 数量/bytes 是计时区间内经生产 runCommand 成功返回的调用；失败调用、mock gh 的辅助 HEAD 查询、传输前辅助 URL 查询不在计数中，但相应时间包含在总墙钟里。stdout 不是磁盘读取量或上传流量。对象数来自 cat-file batch，不覆盖其它 Git 内部访问。文件 open/bytes 是成功的逻辑读取，不是物理磁盘次数。

**阶段口径：** security/generating/cards 是最近一次进度标签下的墙钟区间，可能包含后续 diff/commit、指纹或写入；不能当作某函数独占 CPU。实测输出的顶层 `phase_ms` 按进度标签累计保存，报告不把它与历史实机的 56% 做严格函数级对应。

**外推限制：** 每组一个样本，无统计置信区间。全新工作副本不代表冷磁盘缓存；setup 刚写过文件，页缓存可能温热。没有真实卡库/WAL 体量、缺卡网络、复杂长对局、真实 GitHub HTTPS 或用户常驻工作目录的复测。因此原记录 383.581 秒没有被重新测量，不能据此承诺“真实 6 分 24 秒已降为 15 秒”。

### 本地日志观察与事件循环

独立脚本实际执行 `createLocalReplayHistory → importReplayLogs → buildReplays → archiveReplays`。每场四条合成记录、两条 GRE 状态、无卡对象；显式空 SQLite、合法跨小时 timestamp 和唯一 msgId；500 场日志仅约 0.85 MB。

| 合成场数 | 首次完整导入 | 导入 max event-loop delay | 无变化 observer | 持久 import-cache 命中 |
|---|---:|---:|---:|---:|
| 10 | 67.13 ms | 6.13 ms | 0.69 ms | 21.05 ms |
| 100 | 106.35 ms | 12.46 ms | 0.68 ms | 23.52 ms |
| 500 | 277.32 ms | 83.56 ms | 0.65 ms | 20.21 ms |

无变化 observer 的 workflow 调用均为 0；持久缓存命中仍核对完整指纹。1 ms histogram 的 idle 对照 max 约 1.2 ms，导入采样数 61/62/86；末尾保留 5 ms 采样 drain，elapsed/CPU 不含 warmup/drain。所有归档数、时间和 fetch=0 断言通过。此结果支持同步 CPU 仍能拖延主事件循环的判断，未测试真实大型日志的 UI 响应时间。

## 三、安全覆盖与优化凭据

原安全 scanner、白名单、隐藏信息策略、shared lock、remote 私有性/URL、stage 后校验和 pending 重试机制保持原有门槛。新 guard 每次重新枚举 refs、读 commit/tree/blob 原始字节并校验 Git 摘要；仅在一次发布 invocation 内复用已验证内容的语义判断。不同路径、JSON/text 及批准文档上下文仍分别检查。

本次覆盖的反例包括：成功后新增 ref 的恶意祖先、tree/commit/blob 同 hash 路径下替换内容、stage 后注入秘密、相同 subtree 在另一前缀下的路径白名单、JSON/text 语义差异、批准文档删除/恢复/merge parent 改动、跨 repo/branch/rules session 失效、SHA-1/SHA-256、PRIVATE 变更、多 push URL、失败 pending 保留及重试不多 commit。真正不可达且不在 index 的 dangling 对象不在此 guard 范围；指定分支 push 不携带它们，没有宣称它们已扫描。

卡指纹闭包共用生成的 `collectIdentities` 和关联面 resolver，覆盖循环、传递关联和缺失 DB 行的 linked ID；缺失 JSON 本身也入键，随后到达/删除/改写都会失效。DB/WAL、规则源码、回放和中文名仍全字节/内容绑定；新 metadata-v2 标识拒绝沿用旧键。同大小、mtime 恢复后改内容的测试仍能使缓存失效。

### 本轮交叉审查中发现并修正的候选风险

这两项属于本轮候选补丁，**不归因于原 fca8728**：

1. **瞬时 DB 读取失败。** 前后 resolver 失败但中间生成成功时，初版闭包可能漏绑定实际读过的 linked metadata。独立 EIO 反例使 101 从 `Scry 1.` 改为 `Scry 2.`，原候选键仍相同。现要求 resolver 完整，否则 null；生成使用 DB fallback 时不写 receipt；全部 observed ID 必须被 after.metadataIds 覆盖，并逐个复核实际 JSON。修后同触发均拒绝建立不可信指纹。
2. **BOM 文件/目录名。** TextDecoder 默认移除开头 BOM，初版 raw tree 解析可能把祖先中的 BOM+README/BOM+latest 误认为许可路径。原 fca 两例拒绝，未修候选两例漏检，修后两例拒绝。现对文件名进行解码后字节往返一致核对；不改变通用 JSON 正文解码。

没有新增原子数据库快照协议；原设计中外部进程在哈希完成后瞬时改库的窗口不能据此声称完全消失。也没有将所有历史 tree bytes 的增长改成严格线性：不断扩展的历史目录本身仍可能带来二次累计体量。

## 四、后台、收藏、通知与 UI 的验收边界

| 能力 | 本轮实际证据 | 边界 |
|---|---|---|
| 页面停止观察后后台继续 | abort 客户端观察后真实 task/workflow 仍 running；新 client GET 同 id；第三个 client 仍读到完成结果；POST 总计 1 | Node 合成协议执行；没有真实浏览器关闭/重开的视觉验收 |
| 暂时断线及丢 POST 回执 | GET 重连；完整/部分响应丢失都不重复 mutation；已知旧 id 不误报成功 | POST 与 GET 间另一窗口的全局任务仍可被接管观察 |
| Node 生命周期 | 关服门闩阻止新任务并等待已接受任务 | task 状态仍存进程内；Node 重启不恢复 job。持久 pending/snapshot 不等于跨进程自动续传 |
| 完成结果与通知 | 已去除旧 6 秒自动清空；通知失败不改变 succeeded；固定内容/argv、有 3 秒上限 | osascript accepted 仅为系统接受，不能证明横幅可见；本轮未发真实 macOS 通知 |
| 收藏读取与重试 | 固定 update/sync 路径、非交互 sudo；读/校验失败保留原快照；仅上传重试不再次 reader；bare 发布检查 namespace/pending/互斥 | 未读取真实 Arena 内存，未核对客户端真实数量；提交后错误语义和账户识别限制见 P2 |
| 跨类型与跨进程锁 | operation 或 shared sync 锁由独立子进程持有，竞争方 reader=0、externalCalls=0；replay/collection 不互带未发布 commit | 显式双恢复的旧 operation 锁竞态单列，未扩大成普通锁整体失效 |
| 隔离服务 | cloud-dev 显式关闭 replay sync、collection、local logs，合成检查通过 | 不代表完整 Viewer 构建或真实数据权限验收 |
| 已接受 UI | 45/45 原导出哈希匹配；19/19 受限 Viewer 文件仍缺失；未改紧凑卡图、箭头或纯自有按钮布局 | 不补取或分发受限源码，无法完整检查卡图/CSS/store 集成和视觉 |

收藏四个核心文件 `collection.mjs`、`collection-reader.mjs`、`collection-update.mjs`、`collection-sync.mjs` 在 main 与 fca 字节相同，本轮也未修改。未绑定真实数据仓库或放宽账户/密码/任意路径执行边界。

## 五、本次实际验证与失败记账

完整命令、UTC 起止、退出码、超时和 stdout/stderr 随证据附件提供。以下是本次独立执行，不复用历史“通过”记录。

| 验证 | 结果 | 证据 |
|---|---|---|
| 源码身份 | fca 161 文件、main 134 文件 Git blob 全匹配；两提交及其 tree/blob 还原为原 SHA，git fsck --full --strict 通过 | `logs/reconstruct-original-git-final.log`；范围是目标分支和 main 祖先链，不是其它无关分支 |
| 出库检查 | `npm run check:release` 通过；检查最终工作区、暂存区、目标祖先树与提交元数据，另有 git diff --check | `logs/release-check-final.log`；没有把其它未合入分支计入扫描范围 |
| 依赖安装 | 官方 registry 的 npm ci --ignore-scripts；root 与 viewer 均 exit 0 | `logs/npm-ci.log`、`npm-ci-viewer.log` |
| 最终全部后端 | **332 项：322 PASS、2 FAIL、8 SKIP；exit 1**，2026-10-10 04:38:47–04:39:06 UTC | `logs/full-backend-final.log`；未写成全绿 |
| Portable Viewer | **59 PASS，exit 0** | `logs/final-viewer-portable.log`；排除三个依赖受限 store 的测试文件 |
| 最终安全专项 | **33 PASS，exit 0**；包含最终 BOM 文件/目录名回归 | `logs/final-security.log`；与完整后端重叠，不另加到总数 |
| 后台/client 定向 | 24 PASS；7 个冻结探针原 0/7、修后 7/7 | `tasks/patched-task-suites.log`、`*-lifecycle-probes-http.log`；24 与 7 场景重叠，不能相加为独立 31 项 |
| 自有按钮类型检查 | 三个按钮和 taskClient strict tsc exit 0 | `tasks/task-components-typecheck.log` |
| 收藏 core/server/cloud | 35 PASS；收藏本地 bare 发布 13 PASS | `collection/collection-core-after.log`、`collection-sync-after.log`；与完整后端有重叠 |
| 新卡指纹及生成 | 5 个 cache + 6 个 coach-cards 测试通过；瞬时 DB 失败另经独立反例验证 | `logs/fingerprint-regressions-final.log`、`collection/fingerprint-transient-db-after.log` |
| 完整 Viewer build | **exit 2，未通过**；缺失已排除的类型/store/GameBoard 等导致 TS2307 及后续类型错误 | `logs/viewer-full-build.log`；不通过补入受限源码制造构建成功 |

后端两项剩余失败均在 launcher 的 `/bin/ps` 身份查询。原提交的 server/task/standby 独立组合为 38 项、36 PASS/2 FAIL，修后仍同两项。独立探针显示 Node 的 PID 为 5，而 `/proc/self/stat` 为 6735，原 ps 调用报 `fatal library error, lookup self`。这证明当前执行环境不适合验收该身份路径，不能据此判定 Mac 启动器坏了；生产身份检查未放宽。八项跳过由测试入口明确要求未提供的私有语料；也没有下载该语料。

早期完整后端为 330 项、318 PASS/4 FAIL/8 SKIP，其中另两项是过期 observer/export 断言，已分别在原版复现并修正测试。batch stdin fixture 原先的有界挂起单独保留；不能把这些测试问题解释为缺依赖。开发过程中的失败尝试、优化候选反例与最终通过日志均保留，不删除不利证据。

## 六、交接与可复现入口

修复分支面向本机复验，尚未部署。优先在拥有合法完整 Viewer 的本地 checkout 集成本分支，再验证：真实关闭/重开页面接回同一任务；实际收藏数量与错误后的当前快照；launcher 身份复用；系统接受通知和横幅可见分别记录。实机性能应在相同日志、卡库、缓存、历史和新增场数下做前后对照，单列日志整理、补卡网络与 GitHub 传输。

不需要真实数据即可重跑合成工具：

```sh
node scripts/benchmark-replay-sync.mjs --source=/absolute/original-checkout --size=500 --output=/tmp/replay-before.json
node scripts/benchmark-replay-sync.mjs --source=/absolute/review-checkout --size=500 --output=/tmp/replay-after.json
node scripts/benchmark-local-import.mjs --source=/absolute/review-checkout --size=500 --output=/tmp/import-after.json
node scripts/reproduce-sync-tree-replacement.mjs /absolute/original-checkout/src/sync-security.mjs /tmp/tree-proof.json
```

前两条必须使用同一脚本、分别指向对应源码，并为各 checkout 安装其锁定依赖。10 和 100 场同样用 `--size` 重跑。安全专用微基准和祖先替身证明脚本的参数以各脚本头部为准；不要直接把示例 source 路径替换为真实数据目录。微基准历史 wall time 有并发影响，只作为计数支持证据，最终主要耗时表来自 root 串行对照。

后续值得单独做的工程工作是事件循环隔离/有界让出、真实卡库与网络补卡剖析、显式收藏锁恢复协议和提交后错误语义；本轮没有用宽泛重写替代这些各自需要验证的设计。
