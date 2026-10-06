# Replay 2.0 桌面入口

这是自定义语音回放项目 `mtga-gpt-replay` 的入口，固定使用本机 `127.0.0.1:57015`。与 Replay 1.0 的 `MTGA Replay.app`、Python 原版 mtgacoach 分别独立。

在已有完整本地 Replay 2.0 项目的包根目录运行：

```sh
node tools/replay2-launcher/install.mjs
```

需要现有 Node 24+、`bin/mtga-gpt-replay.mjs`、已生成的 `viewer/dist/index.html` 和现有本地回放资料。安装器只生成两个桌面 `.command` 文件，不安装依赖、不构建 Viewer、不创建开机任务。私有源码归档不包含私人回放资料及受上游限制的完整 Viewer；克隆源码库并不等于完整本地运行环境。

- `Replay 2.0.command`：双击打开。现有服务通过健康检查、进程来源检查和教练状态检查后复用。重复点击及同时点击不会额外启动服务。
- `停止 Replay 2.0.command`：关闭教练并静音。仅对本启动器创建且 PID、启动时间、CLI 路径匹配的服务发送 SIGTERM 正常退出。对其他入口启动的服务只关闭教练并静音，保留进程；若要退出该服务，在原终端按 Ctrl+C。

保留原命令行用法；也可在包根目录运行：

```sh
node tools/replay2-launcher/launch.mjs start
node tools/replay2-launcher/launch.mjs status
node tools/replay2-launcher/launch.mjs stop
```

## 启动边界

冷启动明确使用 `live-coach serve --enable --standby --mode replay --no-open --port 57015`。`--enable` 打开功能入口；控制器仍为 `enabled=false, muted=true`。`--standby` 仅用于回放 serve，不能与 `--offline` 或 live 模式组合；跳过启动时模型目录查询，但保留原供应商实现供后续现有 UI 操作使用。启动器自身只访问本机健康/状态/停止路由。

打开后先在现有配置界面明确读取实际账户模型目录、选择型号和现成音色，再明确“启用本次会话”。目录操作、启用/解除静音和生成前均检查原保存授权与剩余额度；供应商内部 token/目录等待结束后的预算预留及外部请求也复核保存授权。DeepSeek 仍需独立的 metadata/inference/型号/到期时间及现金额度授权；SIWC 的计划额度确认、MiniMax/Eleven 权限和原持久化预算保持有效。没有有效授权或足够余量时阻断，UI 操作不会创建授权、重置用量或切换后端。

待机模式保留原 CLI 启动读取本机配置、凭据和用量账本的行为，尚未实现把所有凭据读取延后到点击；这些读取不是网络请求。没有后台轮询生成、GamePlan 或新授权界面。`--offline` 仍是原有持续离线模式，不能由页面解除；该参数的行为未改。

冷启动与复用都要求状态包含 `standby_guard_version=replay-standby-v1`，并在最后响应再次确认 replay、enabled=false、muted=true，才打开页面并报告待机成功。标记只在全部待机 hooks 安装后设置。旧普通 serve/旧 --offline 服务没有标记，会在关闭教练及静音后明确失败，保留进程且不开页面，提示在原终端 Ctrl+C 正常退出后重开；状态在检查期间改变也失败。入口不自动升级进程或强杀。此候选尚未安装到用户当前运行服务。

端口被别的服务占用、身份不符、项目/Node/Viewer 缺失、进程启动失败、启动超时均显示原因；失败窗口等待回车，以便读清。不会自动安装或强杀。若服务启动失败，查看本机 `~/Library/Application Support/Replay 2.0/startup.log`。该目录仅本用户可访问，日志可能含本机配置/回放摘要，不应上传。

本机每个 HTTP 请求同时使用 1500ms 空闲超时和 1500ms 绝对总截止。持续小块响应也会在总截止时终止并显示原因；完成或失败后清理截止计时器。启动/停止路径不会因这类响应无限等待，失败后释放操作锁。

启动/停止操作使用有界锁。陈旧锁回收核对目录身份和 owner 快照，避免回收期间删除另一个入口的新锁。残留回收标记会在超时后报错；先确认没有启动/停止操作在运行，再手动处理本机锁目录，入口不会无限等待或强杀进程。

## 验收范围

自动测试使用合成 HTTP/CLI，没有外部模型、TTS、私人资料或安装行为：

```sh
node --test tests/replay2-launcher.test.mjs tests/live-coach-standby.test.mjs
```

覆盖待机冷启动、重复点击、同时点击、陈旧锁并发回收、残留回收标记的有界失败、复用外部服务并关闭教练、保留外部进程、端口冲突、进程失败、缺少 Viewer、正常退出后重开、桌面路径引用和同名文件保护，以及持续小块不结束的请求总截止、启动/停止有界失败、正常 JSON 与解析失败。

本机真实程序另在隔离回环端口及临时配置中验证冷启动、同 PID 复用、正常退出、换 PID 重开和最终退出；外网连接阻断探针记录 0 次外网连接尝试。既有 57015 服务保留，只验证桌面入口复用及教练关闭/静音。未将隔离端口验收描述为已退出原有 57015 进程，也未验收付费模型/TTS或战术质量。

新增待机集成测试运行真实 CLI 和原路由、适配器及预算实现，但使用临时合成配置/凭据/回放/供应商响应；任何非回环 socket 连接都会被阻断并计数。覆盖默认零请求、明确点击后 SIWC/DeepSeek 与语音原路径、无/过期/撤销授权、metadata-only、不足额度、取消、旧视图、token/音色目录等待期间撤销、最后一次模型额度仍可生成已授权语音，以及启动器真实 CLI 的冷启动/同 PID 复用/正常退出/新 PID 重开。合成音频仅验证传输，不证明真实语音、策略或延迟质量。

CLI `--data-dir`、`--viewer-dir` 可显式指定既有数据/Viewer目录，默认路径保持原值；测试用它们避免读取私人回放或本机配置。没有复制或发布受限制 Viewer 与私人资料。
