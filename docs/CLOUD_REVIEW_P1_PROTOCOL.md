# 云端复盘 P1：受限发布与独立判断维度

实现定位：基于 P0 的增量候选，尚未替换桌面或开放真实数据仓库写入。本文先说明连接器缺口和实际发布边界，再说明 V2 的兼容语义，最后给出缓存、计算和运行限制。

## 连接器与受限适配器

当前 GitHub 连接器 create_commit 的工具声明只有 repository、tree、parent、additional parents 和 message，没有 author/committer；update_ref 提供 expected_sha。后者不能补足前者缺失的身份契约。没有创建默认身份提交后豁免历史验证，也没有声称实际观察到某个默认邮箱。

[github-review-writer.mjs](../src/review/github-review-writer.mjs) 的 createGitHubReviewWriter 是单场单局能力：调用方必须显式准入精确仓库名、numeric ID、node ID、默认分支、match 和 game。它不注册浏览器写入接口，不接受通用 API URL、命令、身份、路径或 token 参数。仅供受信任工具进程调用，使用现有 gh 登录，凭据不进入报告、源码或 UI。

发布流程：

1. 核对 PRIVATE、双 ID、名称、默认分支及未归档/禁用；以独立临时 Git 目录 fetch 全部远端 heads，执行原有完整历史检查，不复用比赛上传工作树。
2. 固定 head 读取原 blob；重新验证 index、manifest、parts、来源 hash、局数、锚点、coverage 和可见英文牌名。重新生成 P0 计划，拒绝伪造身份、消息、内容和范围。
3. [REST Git create commit](https://docs.github.com/en/rest/git/commits#create-a-commit) 显式设置 author 与 committer 为专用 mtga-cloud-review noreply 身份，唯一父是 expectedHeadOid，tree 只替换精确 review 的 100644 blob。
4. 独立 GET 提交回执；下载尚未发布的 candidate 到临时 verifier，核对原始 commit 双身份、唯一 parent、tree，以及实际 tree 仅一个路径改变、blob OID 和 SHA-256，再执行完整历史安全检查。服务器 JSON 不代替原始 Git 对象验证。
5. [GraphQL updateRefs](https://docs.github.com/en/graphql/reference/git#updaterefs) 使用 beforeOid=expectedHeadOid、afterOid=candidate、force=false。在线 introspection 与真实隔离竞态均核实预期旧值约束；不以单纯快进检查冒充 CAS。
6. 再核实私有目标、实际 head、提交身份及内容回执。并发、超时或响应不确定均停止，不自动重试、rebase、force 或回滚已接受提交。上传了未被分支引用的候选对象不等于发布成功。

GitHub Contents write 是仓库权限，目录限制由受信任适配器执行，不是目录 ACL。这里没有安装新 MCP 服务、配置专用凭据或授权普通云端会话自动运行适配器；真实比赛准入和部署须另行明确批准。CAS 约束提交瞬间的 OID，不检测外部管理员先回拨又恢复相同 OID 的操作历史。

网络复现入口 [verify-cloud-github.mjs](../scripts/verify-cloud-github.mjs) 必须显式传入新建、空、PRIVATE、专用描述且名称匹配的 sandbox，以及全新的本机目录。仅发布测试夹具构造的 synthetic-match-one；拒绝现有非空仓库、生产和源码仓库名称。

## V2：重要程度、判断性质、置信度

[V2 Schema](../schemas/MTGA_AI_REVIEW_V2.schema.json) 和 [合成样例](../examples/cloud-review/ready-v2.json) 增加独立维度。V1 字节格式和历史文件不变；校验仍拒绝未知字段，来源隐私政策仍为 cloud-visible/1，schema 标识区分新展示语义。

| 维度 | 允许值 | UI 表达 |
| --- | --- | --- |
| importance | critical / major / normal | 关键决策 / 重要决策 / 一般建议，决定关注顺序 |
| assessment | suggestion / possible_error / positive | 策略建议 / 建议核查 / 值得保留，注明 AI 判断 |
| confidence | high / medium / low | 较高 / 中等 / 较低，单独显示 |

关键、低置信度、疑似问题显示为醒目的关键决策与“建议核查”，不会降成一般蓝色提示；提高置信度不会变成“确定错误”。confidence 是 Agent 自报判断，不是经过校准的概率。目前没有完整规则/可行动作验证器，因此不提供 confirmed_error 枚举，不接受自称 proof 的额外字段。橙色表示关注程度，不能当作规则裁定。

V1 critical/major 保留关注等级，保守适配为 possible_error；tip 为一般策略建议；positive 为正向评价，置信度原样保留。响应中旧 severity 提示字段继续保守为 tip，避免旧版 Viewer 误称确定重大问题；新版 Viewer 按独立 importance/assessment 选择醒目程度，不受这个兼容字段降级。旧本地模型模块和历史测试继续使用原保守归一化规则，不重算或改写旧记录。

## 失效、并发和计算

P0 的 fetch-only 目录/锁、全历史检查、源字节及完整本地输入指纹全部保留。纯计算通过已有有界 worker pool 执行：Git 历史 JSON 语义扫描、来源解析/绑定、本地 bundle 重建、完整指纹和展示归一化。网络、凭据、Git、缓存与 SQLite 写入留在所属主进程；opaque source verdict 不跨线程传递。没有复盘文件时也校验来源，不以 missing 跳过检查。

sidecar 增加每个 repo/branch/match/game 的已观察 revision 与状态，fetch lease 内先记录 revision，再解析源/报告；缓存写入在同步 SQLite 事务内核对当前 revision 和分支。旧任务晚到不能覆盖新报告；stale 持久化并清掉旧缓存，重启不显示旧标记；同步另一场不使其他场全部失效。只迁移自有缓存，不迁移源比赛、Notes 或收藏。

[benchmark-cloud-review.mjs](../scripts/benchmark-cloud-review.mjs) 在全新进程、空缓存、本地 bare Git 路由下测量 Node CPU、含 worker 的进程 RSS、事件循环及独立进程 HTTP 探针。真实回放只留在本机。单次测量不代表真实 GitHub 网络分位数或模型性能。首次计算仍有明显时间和内存成本，worker 保障主线程响应，不宣称消除了计算工作。
