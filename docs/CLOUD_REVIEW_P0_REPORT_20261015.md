# Replay 2.0 云端复盘 P0 中文审查报告

2026-10-15。交付定位：**隔离实现与 Draft PR 候选**，尚未部署或真实写入私有数据仓库。本文先核对整合来源，再说明协议和安全结论，随后提供测试与真实回放证据，最后列出后续授权与产品化边界。

## 版本事实与整合范围

本轮起始时 PR #1–#4 都未合并：#1 `fca8728` → #2 `2b4c328` → #4 `d96202d`；#3 是另一条含 #1 的分支，head `d86f5f9`，与 #4 共同祖先为 `fca8728`。本机两份源码工作树干净，但外层维护仓库和桌面运行目录有未提交修改。

隔离分支 `codex/replay2-cloud-review-p0-20261015` 先从 #4 提交架构审查/任务契约 `b77651c`，再以本地 merge commit `a505e0d` 整合 #3。没有合并 GitHub 旧 PR、修改其 head 或替换原桌面目录。#3 的 task journal、精确 revision 发布、Git 对象批处理、上传重试及完整 Viewer 源材料保持原实现；仅解决与 #4 server/legacy wrapper 的必要接口冲突。

## P0 已实现

1. **跨端协议**：[Schema](../schemas/MTGA_AI_REVIEW_V1.schema.json)、TS 类型、共享 JS 结构校验器及 ready/missing/stale 三个合成样例。报告单独存放 reviews/match/game，保留 provenance、coverage、中文依据和限制。没有增加运行依赖。
2. **独立权限**：允许精确合法 review 进入仓库历史验证；比赛与收藏发布器的 isCoachSyncPath/isCollectionSyncPath 没有扩大。review 路径对应独立 schema 和语义缓存身份。凭据、机器路径、内部 ID、隐藏手牌结构、任意额外字段、非法 UTF-8、重复 key、超大对象和 Git mode 均拒绝。
3. **安全写入契约**：prepareCloudReviewWrite/publishCloudReview 生成唯一 review 文件的受限计划，检查预期 head、原 blob、私有仓库及源 hash，要求原子 CAS 并验证回执。没有默认网络写入器；真正的 GitHub 连接器仍待单场试点，不把临时 bare remote 模拟称为正式接入。
4. **来源一致性**：index/manifest/file SHA-256/bytes/content_hash 联合校验，使用已有 codec 完整解析 parts，再校验确切 game、anchor、真实边界及当时可见英文牌名。源或政策改变则 stale；不会移到最近帧，也不会把未抽查动作评价为正确。
5. **本地云端读取接口**：独立 fetch-only checkout/锁，独立 SQLite 缓存与已核实分支 receipt；同源云端同步 POST + GET 轮询。原本地 generate/cancel 410，Replay runtime 不再 import 模型生成器或读取模型密钥。#4 浮窗、摘要、标记、中文完整性和高级工具保留，旧 Notes 表不迁移。

完整接口和约束见 [协议说明](CLOUD_REVIEW_PROTOCOL_V1.md)，云端操作与权限边界见 [Agent 契约](CLOUD_AGENT_REVIEW_CONTRACT.md)。

## 独立审查与修复

独立只读审查先发现 P1：缓存指纹只覆盖当前 game，而遗漏 deck、starting_hand、其他局及背景字段。已改成整份 replay 的完整输入指纹；首次缓存仍要求本地 bundle 重现发布 content_hash，写缓存前再次读取核对。新增同步后字段改变、发布前并发 deck 变化的负向测试。

另一项 P2 是分支缓存隔离，随后复核又找出“新分支报告先解析失败”和“旧 fetch 晚到回拨目标”路径。目标仓库/分支现在在同一 fetch lease 内核实并持久化，早于不可信报告解析；锁外写 report 不再改变 target。加入真实 fetch + 临时 bare remote 的默认分支切换/非法报告/重启和跨 reader 锁顺序回归。

最终独立复核结论：**未发现阻塞本轮 Draft PR 的问题**；独立重跑 reader 7 项和真实 fetch 分支/锁 2 项均通过。该结论不批准合并或部署，也不证明真实 GitHub 写入适配器、生产 UI 性能、进程中断恢复或真实 Agent 策略质量。

## 验证证据

### 临时 bare Git 端到端

实际执行 Git 对象与引用操作，网络路由限定为全新本地 bare repository：

`比赛上传 → 模拟 Agent CAS 新增 review → 只读 fetch → 比赛更新/再上传`

源 index 在 Agent 写入后字节不变，review 在随后比赛上传后字节不变，旧报告因源 hash 改变成为 stale。其他负向路径覆盖原 blob/head 冲突、并发 Agent CAS、review 被本地 stage/outgoing 发布的拒绝、同 blob 跨路径缓存、其他远端分支上的恶意 review、可执行/symlink/gitlink、分支切换及下载锁。没有调用真实数据仓库写入。

### 真实 Quick Draft 只读副本

8 场动作数：**340、382、387、391、545、548、561、807**。使用当前 builder 在隔离内存中生成发布格式，再以合成 review 验证整个协议；不是下载了真实云端 Agent 的成品，也不是真实模型策略评价。

全部 8 场通过 manifest/parts、内容 hash、本地 bundle 复现、8 个真实 before 点及过期判定；合计 64 个合成 note、128 个当时可见英文牌名标签。最长比赛有 72 个 parts。单场脚本总耗时 6.8–25.1 秒，包含源构建、完整解析/校验、适配和再次构建，且与回归并行；不能当作网络同步延迟、模型性能或正式 P95。

实机浏览器使用同一 Mac 的独立端口与隔离缓存：807 动作的 T38-A17 精确定位为第 725/807 动作、before 边界；同步合成过期报告后 8 个旧标记全部移除，比赛保持可查看。截图保留在本机交付目录的 screenshots/cloud-ready-807.jpg 和 cloud-stale-807.jpg，画面明确标注合成验收。未将回放、缓存、卡图或截图提交源码仓库。

### 自动测试

- 初轮协议/reader/Git/安全重点检查：46 PASS，0 FAIL。
- 修复后的 reader：7 PASS；真实 fetch 分支与锁回归：2 PASS；协议/旧 review/task 重点检查：20 PASS；server/CLI 集成修复：15 PASS；catalog retry 单项复测：1 PASS。不同组有重叠，不累加为总数。
- Viewer 完整测试：78 PASS，0 FAIL；最终类型检查和生产构建通过。V1 TS 类型单独检查通过。生成包 gzip 84.96 kB，无新增运行依赖。
- 首轮完整后端运行：392 项，381 PASS、3 FAIL、8 SKIP，0 CANCEL。失败为 CLI 的 20 秒子进程期限、catalog retry 的生成缓存断言，以及 PR #3 legacy 关闭测试与 #4 core 接口不一致。最后一项是实际整合缺口，已修复 wrapper 关闭门闩并将测试指向正确 legacy 入口。CLI 与 catalog 项复测均通过；前一轮还与真实数据脚本和源码修改并行，不能把那一轮称为全绿。
- 冻结主体运行时源码后，以 `node --test --test-concurrency=4 tests/*.test.mjs` 重跑完整后端：**400 项，392 PASS、0 FAIL、8 SKIP、0 CANCEL**，约 412 秒。8 项锁定私有语料测试继续明确跳过。末尾补充的写入器错误脱敏另以 CAS 单项复测，未调用外部写入。
- `npm run check:release` 通过：255 个路径、19 个 manifest 固定的 Viewer 文件，检查工作区/index 和已取得 refs 可达的 39 个提交树/提交元数据，shallow=false。最终补充文件和提交内容另做同规则增量核查，不把旧 scope 说成更新后的全历史扫描。
- 本轮前后的原数据库读取结果为 **161 场比赛、1 条 Coach Note**，全部原始逻辑行的 SHA-256 前后一致。此前报告中的 141 是旧快照数量；本轮从开始就观察到 161，未修改原比赛、Notes 或收藏。完整原始证据留在本机，不随源码发布。

## 剩余边界与待授权项

- 本轮没有真实 GitHub review 写入器的在线验收；真实试点需用户明确批准一场比赛和目的地后，核实实际连接器权限、noreply 身份、原子 CAS、回执和上传共存。
- 不把 GitHub 仓库级 Contents write 称为目录级权限；目录限制是受限工具/适配器的应用层边界。不得为适配身份方便关闭历史校验。
- 大比赛首次源验证和本地 bundle 重建有 CPU/内存成本，正式部署前还需使用已有 worker 架构测量响应性。进程中断后的 fetch.lock 保留，需要核实后人工恢复；没有自动删除未知锁。
- 未替换桌面应用、未合并旧 PR、未改名、未配置新后台任务，收费模型请求为 0。云端 Agent 推理质量、长期记忆效果和自动唤醒调度均未验收。
