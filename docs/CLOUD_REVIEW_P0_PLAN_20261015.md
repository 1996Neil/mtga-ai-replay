# 云端复盘 P0：架构审查、协议与实施契约

2026-10-15。实现模式。依据 issue #5 和本轮用户指令，先确认版本与安全冲突，再定义跨端契约，最后实现并提交隔离测试证据。状态：当前进行协议与同步边界实现；随后运行回归和独立审查。

## 已核实版本

PR #1–#4 都为 OPEN、未合并。#1=`fca8728`，#2=`2b4c328`（包含 #1），#4=`d96202d`（包含 #2）；#3=`d86f5f9`，从 main 集成 #1 及同步可靠性修复，与 #4 的共同祖先为 `fca8728`。源码两份工作树干净；原桌面工作目录和外层维护仓库有未提交修改，不作为本轮写入目标。

本轮从 #4 精确提交建立独立分支，再在本轮分支内整合 #3；这不合并 GitHub 旧 PR。原 #4 的浮窗、标记、完整性、高级工具和 legacy 语音解耦保留。PR #3 的受控 Git、批量对象校验、上传重试与测试可靠性修复作为集成基线。

## 冲突与决定

云端 Agent 写入 `reviews/<match-id>/game-<N>.json`，本机仅下载、校验和展示。比赛与 AI 内容独立哈希，不把 reviews 加入比赛/收藏发布器的写入白名单。

| 边界 | 当前问题 | 最小方案 |
| --- | --- | --- |
| 可验证历史 | 任意 reviews 文件均被拒绝，会阻断后续比赛上传 | 严格限定 review 路径及 V1 Schema，复用全部凭据/隐私/对象校验；语义缓存按路径及格式分隔 |
| 本地发布 | 若直接扩大原白名单，会授权比赛发布器写 review | 保持 isCoachSyncPath/isCollectionSyncPath 不变，独立 isReviewSyncPath；检查 staged/outgoing 的 namespace |
| 云端写入 | GitHub repo 权限不提供目录级权限 | 独立工具操作契约和受限写入适配器，只允许精确 review 文件；校验源 revision/hash，CAS 更新分支引用。不能把应用层限制宣传成 GitHub IAM 目录 ACL |
| Git 提交身份 | 已有 validator 要求 author/committer 为 GitHub noreply | Agent 使用专用 noreply 身份；不豁免任意云端个人邮箱，不关闭 metadata 检查 |
| 源一致性 | 最近帧或本地指纹不等于发布 content_hash | 同时验证 index、manifest、所有声明文件字节哈希及 content_hash；解析局面引用后按 exact game/anchor/boundary 校验 |
| 本地 API | #4 默认装载收费模型生成器 | Replay 运行时移除生成器依赖和生成入口，接入纯读取 review provider；原生成器保留历史但不执行 |

## V1 契约

独立 JSON Schema、JS 运行时验证和 TS 类型，三个合成状态样例（ready/missing/stale）。报告必含 schema、match_id、game_number、source_content_hash、policy_version、generated_at、generator/provenance、coverage、summary、notes。每条记录的 game、anchor、边界和可见英文卡名必须经过真实源数据校验；未知字段、隐藏牌、未解析引用、重复锚点及过大对象拒绝，不默默丢弃后声称通过。

coverage 记录实际检查的 anchor/boundary，不把未抽查动作评价为正确。旧 Notes 保持独立；旧 sidecar 报告可读作历史，但不能冒充已经绑定发布 hash 的云端报告。

## 本轮完成条件

1. 合成和畸形输入可重复验证；同局不同 game、跨比赛、hash/anchor/隐藏信息等负向测试失败关闭。
2. 在临时 bare remote 中实际执行“比赛上传→模拟 Agent CAS 写 review→比赛再上传”，review 不被覆盖；并发源变化/写入冲突不能悄悄覆盖。
3. 原安全测试与上传/收藏回归通过；对完整回归失败、跳过和环境限制如实列出。8 场真实 Quick Draft 只读副本用于协议适配验证，最长 807 动作；不写原数据。
4. 云端协议适配到 #4 展示结构，Replay 运行时不能触发本地模型请求。只读同步与上传使用分离 checkout/锁；P1 的完整产品化不挤占本轮 P0。
5. 独立 Draft PR、中文报告、准确命令/结果及演示证据。高风险最终 diff 由独立上下文审查，最终合并仍交人类决定。

不合并旧 PR、不安装桌面、不修改真实比赛/Notes/收藏、不写真实数据 repo、不改名、不调用收费模型、不创建自动化。新增第三方运行依赖为零。真实 GitHub review 写入仅在后续单场试点获明确授权后执行；本轮只模拟连接器和临时 Git remote。
