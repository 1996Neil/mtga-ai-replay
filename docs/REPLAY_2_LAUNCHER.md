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

冷启动明确使用 `live-coach serve --enable --offline --mode replay --no-open --port 57015`。`--enable` 打开功能入口；控制器仍为 `enabled=false, muted=true`。`--offline` 跳过启动时模型目录查询，并令模型及语音生成器为空。启动器不会调用模型、TTS 或授权/目录路由，不上传对局，不自动重试进程启动。健康检查轮询只访问本机服务。

复用已有服务时不会替换其运行参数；会检查回放模式，并在必要时通过本机 `/api/live-coach/stop` 关闭教练及静音，复核状态后打开浏览器。以后在页面中手动操作模型目录、语音目录或启用教练，需要独立授权；桌面入口不是付费调用授权。

端口被别的服务占用、身份不符、项目/Node/Viewer 缺失、进程启动失败、启动超时均显示原因；失败窗口等待回车，以便读清。不会自动安装或强杀。若服务启动失败，查看本机 `~/Library/Application Support/Replay 2.0/startup.log`。该目录仅本用户可访问，日志可能含本机配置/回放摘要，不应上传。

启动/停止操作使用有界锁。陈旧锁回收核对目录身份和 owner 快照，避免回收期间删除另一个入口的新锁。残留回收标记会在超时后报错；先确认没有启动/停止操作在运行，再手动处理本机锁目录，入口不会无限等待或强杀进程。

## 验收范围

自动测试使用合成 HTTP/CLI，没有外部模型、TTS、私人资料或安装行为：

```sh
node --test tests/replay2-launcher.test.mjs
```

覆盖离线冷启动、重复点击、同时点击、陈旧锁并发回收、残留回收标记的有界失败、复用外部服务并关闭教练、保留外部进程、端口冲突、进程失败、缺少 Viewer、正常退出后重开、桌面路径引用和同名文件保护。

本机真实程序另在隔离回环端口及临时配置中验证冷启动、同 PID 复用、正常退出、换 PID 重开和最终退出；外网连接阻断探针记录 0 次外网连接尝试。既有 57015 服务保留，只验证桌面入口复用及教练关闭/静音。未将隔离端口验收描述为已退出原有 57015 进程，也未验收付费模型/TTS或战术质量。
