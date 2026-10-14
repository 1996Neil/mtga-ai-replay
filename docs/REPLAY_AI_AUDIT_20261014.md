# Replay 2.0 AI 复盘：独立审查与最小修改决策

日期：2026-10-14（北京时间）。审查对象：PR #2 的 `2b4c328baf5dc89807d780e8bbd52ad490c27417`。

写作结构：先核对代码身份和阻塞问题，再比较复用方案，最后界定最小修改与验收条件。

结论：一期的独立报告层和动作锚点值得保留，但当前任务生命周期、上下文投影和失效判定不足以直接作为可靠产品交付。先修复这些边界，再调整工具布局和切断语音依赖。没有进行收费模型调用，没有修改历史对局或历史笔记，没有合并 PR。

## 版本与并行修改保护

初次在线核查时 PR #2 为 **OPEN**，head 为上述提交，base 为 `codex/replay2-sync-collection-20261010`（`fca8728`）。`main` 为 `30d9300`。另有未合并的同步修复 PR #3，head `e6f55a4`。三条分支不能当成同一版本。

本机桌面入口运行另一份嵌套在数据仓库中的源码，PID 对应 `live-coach serve --enable --standby --mode replay`，源码有大量未提交修改；该服务 health 无 AI review 能力。当前聊天目录 remote 则属于中文补丁维护仓库。两处都不适合作为直接覆盖目标。

本轮新建隔离工作树和 `codex/replay2-ai-audit-20261014` 分支，从 PR #2 的确切提交出发；不切换原分支，不改 PR #2 head，不合并或重置桌面源码。提交前再次在线核对 PR 状态。若 PR #2 合并或 head 改变，必须重新核对祖先关系及最终 diff。

## 按影响排序的发现

| 等级 | 位置（审查基线） | 触发与影响 | 最小修复 |
|---|---|---|---|
| P1 | `src/review/review-model.mjs:139–156` | 实际 canonical snapshot 使用 `activePlayer`、`priorityPlayer`；投影读取 snake_case，全部真实样本均变成 null。法术力、实例 ID、阻挡/目标关系也被丢弃。模型无法可靠区分同名生物或战斗关系 | 单一可见局面投影；保留实际字段和关系；复用投影，明确“最后观测”而非证明合法性 |
| P1 | `src/server.mjs:87–97`、`src/review/review-generator.mjs:65–103` | 一个 HTTP POST 持有全流程；8 节点两并发 + 总结，5 批 × 60 秒可达约 300 秒。关闭页面或服务不取消后续请求，也没有服务器任务状态/进度 | POST 202、单任务状态与取消、总时限、关闭门闩；不自动重试收费请求 |
| P1 | `src/review/review-model.mjs:13–19`、`src/server.mjs:91–94` | 指纹没有包含 replay/game warnings、分析策略版本；生成完成未再次读取当前回放。完整性条件改变仍可标成 current，或生成中刷新后写入旧报告 | 指纹包含分析输入与策略；发布前重新读取并核对；旧报告保留但不显示成有效 |
| P1 | `viewer/src/components/ReplayReviewCoach.tsx:45–64` | 同一比赛刷新只有 steps 变化，GET effect 仅依赖 id/game；旧报告持续显示。自动播放到 before note 时界面可能仍为 after 局面 | 跟随回放 revision 重新检查；自动到达 before 标记不展示成当前 after 判断 |
| P1 | `src/review/review-model.mjs:78–94`、`src/review/review-generator.mjs:95–97` | 模型自报 high 即可得到 critical；未校验输出文字是否引用隐藏/未知牌；总结接收尚未降级的原始 severity | 未证明替代行动合法性时模型错误标记最多 tip；先规范化节点，再输入总结；卡名仅认证可见英文身份，文字断言仍不能证明正确 |
| P2 | `src/review/review-model.mjs:13–19` | 每次验证同步 stringify 全部状态。807 动作真实回放约 25.34 MB，每次指纹 95–102 ms；重复 GET 可拖延事件循环 | 哈希流式按 frame 更新、基于可信 revision 复用验证结果；不按对象身份缓存可变输入 |
| P2 | `src/review/review-model.mjs:148` | `action` 原对象直接传给模型，不能依赖 canonical 的上游过滤作为唯一防线 | 明确允许的动作字段；隐藏卡及目标递归净化；不含账号/原始日志 |
| P2 | `tests/replay-review.test.mjs:43–52` | fixture 多次复用同一个 before 对象，测试修改对手手牌后又比较原指纹，基线 7 PASS / 1 FAIL | 每次返回独立 fixture，保留真实修改失效的断言 |

未确认 P0。严重程度是工程判断，不代表模型的“critical”事实成立。独立审查相对于一期作者；本轮后续修改仍需最终 diff 审查，且不会自动合并。

## 成熟项目比较

标准：当前可核查的维护记录、实际许可证、React/动作锚点适配、运行依赖与退出成本。信息于本轮在线核查；npm 解包大小不是浏览器 gzip 包大小。

| 项目 | 维护和许可证据 | 适配与成本 | 决策 |
|---|---|---|---|
| [mtg-replay-viewer](https://github.com/m1kk3l/mtg-replay-viewer) | 非 archived；最近 push 2026-05-18；根目录无 LICENSE，GitHub license=null；当前适配已有 19 个受限文件 | 专用 Arena 状态/卡图回放，比通用视频库匹配；但重新引入会重复 parser/store，并扩大许可和数据语义负担 | 保留已有合法本机适配作为验收条件，不复制或上传受限源码；未获许可不把它当可发行依赖 |
| [react-rnd 10.5.3](https://github.com/bokuweb/react-rnd) | release 2026-03-10；push 2026-05-12；实际 LICENSE 为 MIT | 拖动、缩放、边界、受控位置匹配浮窗；自身解包 86,904 B；另有 re-resizable、react-draggable、tslib 及传递依赖 | 值得作为以后需要缩放/多窗口时的首选；本轮仅修拖动边界，现有 Pointer Events 足够，不增加依赖 |
| [videojs-markers 1.0.1](https://github.com/spchuang/videojs-markers) | 最近 push 2020-12-24；实际 `LICENSE-MIT` 为 MIT；旧 Grunt/Flow 构建 | 以视频秒数为坐标，peer 为 video.js >=4；Replay 是离散锚点和前后局面，没有 video.js player | 不引入；借鉴标记聚合/提示交互概念，无需复制实现 |
| [react-window 2.2.7](https://github.com/bvaughn/react-window) | push 2026-10-10；实际 LICENSE.md 为 MIT | React 18/19，运行无直接 dependencies；自身解包 208,972 B；适合长日志，但动态高度和精确锚点需要适配 | 可作为长时间线后续候选；先测 807 动作真实 UI 再决定，不为动作数量单独增加依赖 |
| [TanStack Virtual 3.14.19](https://github.com/TanStack/virtual) | push 2026-10-13；实际 LICENSE 为 MIT | headless React 适配，动态高度和 scrollToIndex 合适；React 包解包 63,728 B，另需 virtual-core 3.19.4 | 若长时间线实测卡顿，优先比较该方案；本轮不换现有日志 renderer |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | push 2026-09-12；GitHub 标注 MIT；本轮未锁定新版所有包许可/依赖 | 面向排序、拖放、多容器；浮窗单纯位置移动的整合成本较高 | 不引入；本轮无卡牌拖放或排序需求 |

来源为各仓库 API/内容和 npm 元数据。已实际读取 react-rnd、react-window、TanStack 的许可证；videojs-markers 使用 LICENSE-MIT 路径。未安装上述候选，新增运行依赖为零。

## Coach Notes 三种路线

| 路线 | 好处 | 负担/风险 | 决策 |
|---|---|---|---|
| 直接复用旧 Notes | 现成文字列表和 anchor 跳转 | 缺 game/boundary/fingerprint/provenance/置信度；新生成会混入人工历史，且 cannot invalidate safely | 不采用 |
| 扩展旧 Notes | 一份数据接口 | 必须解释历史无版本记录、默认 boundary、迁移和客户端兼容；人为笔记可能被 AI 刷新覆盖 | 不采用 |
| 独立结构化 AI 记录 | 明确局数、边界、来源、策略版本与失效；独立 sidecar | 需单独 API/状态 UI，但一期已具备基础 | 采用；保持原 coach_notes 表与历史 JSON，不迁移、不重写；未来只在呈现层联合浏览 |

## 最小实施范围和完成条件

1. 修复上下文、任务生命周期、失效判定、证据不足的严重错误展示；保留按节点独立请求、8 节点两并发的上限，无 provider fallback。
2. “重建说明”改成“数据完整性”：常见 warnings 有确定中文；未知项显示中文说明并提供原文，不猜译。新增默认折叠“高级工具”，迁入锚点调试、Coach Context 下载。
3. Replay App 不 import 实时 Coach UI；Replay backend 仅显式 legacy 参数才动态加载 Coach；新版独立入口直接 startReplayServer，不需要 enable/standby，也不授予语音权限。历史代码及原启动器保留于 Git 和 legacy 入口，文档给出回退步骤。
4. 使用本机真实 Quick Draft 的 340、387、545、548、561、807 等动作回放；数据只读，报告写入隔离 sidecar。验证浮窗、锚点 before/after、同局 revision、过期报告、失败和取消。模拟模型只证明任务/性能边界，不能当真实模型质量或网络时延。
5. 本轮禁止收费模型请求。真实模型质量、token/费用、网络性能若无法得到授权，不宣称验收完成。
6. 源码仓库改名仅在代码及实机验收全部满足后进行。改名目标是 source repo，数据仓库与同步目标保持原身份；先检查所有 remote、配置、文档和同步任务。条件未满足时交付核查清单，不提前改名。
