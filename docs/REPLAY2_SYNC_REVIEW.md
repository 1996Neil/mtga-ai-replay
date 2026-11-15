# Replay 2.0：后台任务与收藏入口审查

本次同步发布的是已有私有源码仓库的新分支 `codex/replay2-sync-collection-20261010`。运行中的 macOS 应用已更新；数据仓库、真实回放历史和账户配置没有纳入源码提交。

## 2026-10-14 private PR #3 status

Following explicit user authorization, the 19 hash-pinned adapted Viewer sources are now included in private PR #3 so CI can run the complete Viewer suite and production build. Upstream attribution and the no-declared-license status remain unchanged; this does not grant public redistribution rights. Historical measurements and validation records below describe their original runs and are not updated to imply new performance or test results.

## 当前行为

- 回放上传仍复用 `syncReplayHistory → syncCoachCatalog → canonical publisher`：扫描已归档回放、核对远端、处理缺失/待重试及最新记录、补齐卡牌并生成产物、完整安全验证、Git 提交和上传。
- 新任务由 Node 服务持有。关闭或刷新浏览器只停止观察；重新打开通过 GET 接回当前运行或完成结果，不重发 POST。
- 观察请求有超时，临时失联显示“状态未知”并重新连接。启动 POST 回执丢失时仅 GET 核对，不能将旧结果误认成新任务成功。
- 完成结果保留到下一次任务或后台服务退出，移除了六秒自动消失。固定内容的 macOS 通知有三秒执行上限，提交成功只表示系统接受，不能证明横幅已显示。
- 页面加入“更新收藏”，使用既有 validated update/sync 引擎。读取不在网页收密码；需要授权时仍交给本机终端。读取成功但上传失败保留 partial 和数量，可反复只上传，不重新读取 Arena。
- 同一类型运行任务去重；回放上传与收藏任务互斥；保留既有跨进程锁。严格 loopback Host/Origin、固定 action、无参数 POST。只有 Replay 模式 standby 服务显式开启收藏，隔离语料服务默认禁用。
- 当前卡图保持纯图片和桌面 300×420 上限；关系箭头保留。第三方 Viewer 文件仍排除；当前文件哈希更新供已有授权本机复现。

## 性能证据与待优化范围

实际最近一次保存的成功结果：2026-10-08，新增 10 场，本地 47 场、已有 37 场，总计 383581ms（约 6 分 24 秒）。这不是本次改动后的性能验收。

| 阶段 | 毫秒 | 约占总时长 |
| --- | ---: | ---: |
| 安全检查 | 214422 | 55.9% |
| 补齐卡牌 | 104048 | 27.1% |
| 生成文件 | 36614 | 9.5% |
| 核对远端 | 14545 | 3.8% |
| 最后上传 | 13532 | 3.5% |
| 其他 | 420 | 0.1% |

源代码可见：prepareCheckout 多处完整验证；每项发布的 stage/commit 也验证；rev-list/ls-tree 会反复枚举历史。验证 session 的缓存并不自动消除所有历史树遍历或 blob 读取。候选项的 coachInputFingerprint 还反复读取源代码、DB/WAL 与所有 cards JSON；这可能随对局/缓存增加产生增长成本。具体复杂度与最优修复尚未证明。

Pro 应同时检查本地日志导入/同步中的同步计算是否阻塞 Node 事件循环并造成页面状态请求延迟。不能通过移除历史/秘密校验、降低隐私边界或放宽锁来提速。

## 验证记录

运行源码：服务器/任务 14/14、完整 Viewer 68/68、收藏更新/同步与 launcher 37/37、standby CLI 24/24 通过，TypeScript/Vite 构建和 diff whitespace 检查通过。最后增加合成测试全局目录 guard 自检后，CLI 收藏集成 1/1 通过。

GitHub 导出后单独验证：服务器/任务与 standby CLI 合并 38/38，通过；本机授权 materialize 后完整 Viewer 68/68 与构建通过；云端入口/发布策略 5/5 通过，包含禁用本地日志观察与收藏的断言；发布扫描检查工作区、索引、全部 Git 历史和提交元数据。全量后台套件尚未重跑，不能把这些结果写成全量通过。

独立审查已复核：完成按钮误重跑、卸载观察泄漏、上传失败重试丢失 partial、轮询强行重开详情均已修；未发现未解决阻塞问题。

旧 standby 集成首次运行出现冷启动 deadline 失败。发现合成 harness 的默认目录发现可能读取真实用户日志；已把测试子进程 homedir 限定到 fixture，并固定拒绝全局应用路径读取，独立命名导出自检验证 guard 有效。隔离后 24/24 通过。这不是生产上传提速证据。

实际服务 health 宣告 replay-sync、collection-update。应用内浏览器实际看到“上传回放”和“更新收藏”两个可用按钮。没有执行真实收藏读取、真实上传压测或实际通知横幅验收。Chrome 自动化曾阻止本地页访问，后来使用应用内既有页面核对入口；截图仅留本机，没有纳入 GitHub。

关闭后台进程仍可能中断任务。未实现跨进程自动续传；原持久 pending 与收藏快照机制继续保留。本次不声称真实上传速度已经改善。

## 源码复现边界

`docs/replay2-runtime-export.json` 对本次 scoped owned 文件记录运行源码和导出源码哈希；`docs/restricted-viewer.json` 记录不能分发的 19 个 Viewer 文件。源码包沿用 generic collection 仓库绑定及云端开发脚本，不携带凭据、授权、私有日志、收藏、钱包、真实回放 fixtures 或图像。

GitHub 新 clone 可运行自有代码测试，但完整 Viewer 构建依赖排除文件。拥有已有本机源文件使用授权时，可按原工具显式 materialize：

```sh
npm run viewer:materialize -- --source-dir /path/to/authorized/runtime
```

不能下载不明源码补洞、假造测试结果或将授权未明的文件上传。
