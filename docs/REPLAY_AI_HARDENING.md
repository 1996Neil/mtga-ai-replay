# Replay 2.0 本轮接口、运行与回退

先读 [独立审查与方案比较](REPLAY_AI_AUDIT_20261014.md)。本轮不改变比赛或 Coach Notes 数据格式；AI 报告继续使用独立 `reviews.sqlite3`。

## 报告与任务边界

- `GET /api/matches/:id/review?game=N` 返回 `missing / stale / running / ready`，可包含任务状态和进度。
- `POST .../review/generate?game=N` 返回 **202**，开始服务器拥有的任务。相同局的并发点击复用同一个任务；另一个比赛的生成返回 409。
- `POST .../review/cancel?game=N` 取消分析；使用 `review-cancel` action header。生成仍使用 `review-generate`。
- POST 必须 loopback、完全同源 Origin、自定义 action header、空 body、唯一 game 参数。没有配置模型时 501，不请求任何模型。
- 浏览器轮询和恢复只发 GET，不自动重试付费 POST。切换比赛或刷新后不接收旧客户端 epoch 的结果。
- 任务总时限 180 秒；单模型请求 60 秒；最多 8 个决策、两并发、1 次总结，不切换 provider。单请求输入最多 128 KiB，响应流最多 160 KiB，输出预算上限 8×850+1600 = 8400 tokens。这是输出上限，不是 token 费用或总输入 token 的测量。
- 取消、总超时和服务关闭会 abort 后续模型任务，晚返回结果不能发布。已经发送的 API 请求可能已经计费，取消不能撤销供应商侧费用。
- 任务状态是有界内存状态（最多 32 个），进程崩溃后不恢复任务或自动重发；报告才持久化。再次主动点击才可能产生新任务。

报告指纹加入完整性 warnings 和策略版本，逐 frame 哈希并让出事件循环。生成时使用独立快照，保存前重新核对当前数据。算法改变后旧报告会显示过期，保留原记录直至用户主动成功生成新报告。不按可变对象身份缓存。

AI 的当前证据不能证明完整合法行动清单，因此模型错误标记最多为“策略提示”；置信度仅表示观察可信度。英文卡名标签取自当时可见的 canonical 英文身份；未知中文/占位名字不认证。对手手牌和原始账号字段不输入模型。中文自由文本仍可能含模型幻觉，不能把标签验证称为全部自然语言事实验证。

## 独立 Replay 与历史语音

新入口：`npm run replay:serve`（默认端口 57016）或 `npm run replay:launch`。不会启动实时 Coach、授予语音权限、观察日志重写历史，也不自动调用模型；手动同步/收藏入口仍由原固定接口控制。通过 `--data-dir`、`--viewer-dir` 和 `--port` 可指定隔离环境。

Replay App 无 LiveCoachPanel 导入，`src/server.mjs` 无实时教练模块导入。实时历史 CLI 显式经过 `src/legacy-coach-server.mjs` 注入通用扩展，原语音 backend/UI 文件保留在 Git 中；共享历史和赛后 AI API 不依赖它。

原桌面入口和原服务本轮没有替换、终止或覆盖。新版启动器使用独立端口和 PID/start time/source entry 检查，拒绝复用别的项目或实时教练服务，不发送强制退出信号。

回退基线 tag：`replay2-legacy-before-ai-hardening-20261014`，对应 `2b4c328`。回退时新建独立 worktree，按 DEVELOPMENT.md 使用已授权的同版本本机 Viewer 材料构建；不要 reset 含未提交工作的桌面目录。旧启动器 `tools/replay2-launcher/launch.mjs` 和 legacy CLI 均保留。原桌面入口可继续使用自己的未覆盖版本。

## UI 与完整性

分析抽屉中“数据完整性”显示去重后的中文限制，已知英文有固定中文；未知 warning 以中文解释并折叠保留原文。默认折叠的“高级工具”包含锚点调试和 Coach Context 下载。原历史笔记列表继续显示。

AI 浮窗可折叠、关闭、拖动；标题栏方向键可移动，Escape 关闭。窗口和内容高度变化后限制位置。点击建议会跳到确切 anchor 和 before/after；直接播放到相同 anchor 时只有匹配当前边界才展示该条建议。所有来源信息与分析限制保留在浮窗中。

## 仓库改名门槛

目标名 `mtga-ai-replay-source` 只适用于源码仓库。需先满足最终验收，包括真实模型质量/性能；本轮没有付费授权，因此尚未改名。

改名前核查 source origin 与所有共享 worktree 的共同 config、PR #2/#3 的最终合并关系、README/审查提示中的旧源码链接、GitHub 默认分支和开放 PR、桌面路径配置。改名后核查 GitHub 新名称 API、remote URL、fetch/push 权限和文档链接。

数据同步目标是独立的比赛数据仓库，不应跟着 source 改名。检查本机固定 sync 配置和 catalog 来源、同步任务与 launcher 指向；保持数据 remote 原身份，不重新上传比赛。现有本机 heartbeat 只有一项已暂停的网络监控，与 source remote 无关。本轮未修改该 automation，也没有配置新的后台任务。
