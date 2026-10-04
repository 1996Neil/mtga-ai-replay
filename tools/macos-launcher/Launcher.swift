import AppKit
import Foundation

// One-shot wrapper. All replay, archive, Viewer and sync behavior belongs to the CLI.
final class ReplayLauncher: NSObject, NSApplicationDelegate {
    private var child: Process?
    private var output: FileHandle?
    private let logs = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/MTGA Replay", isDirectory: true)
    private let started = ISO8601DateFormatter().string(from: Date())

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let logURL = logs.appendingPathComponent("latest-launch.log")
            try Data().write(to: logURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
            output = try FileHandle(forWritingTo: logURL)
            guard let url = Bundle.main.url(forResource: "LauncherConfig", withExtension: "plist"),
                  let config = NSDictionary(contentsOf: url) as? [String: Any],
                  let node = config["NodePath"] as? String,
                  let cli = config["CLIPath"] as? String,
                  let project = config["ProjectPath"] as? String,
                  let path = config["SearchPath"] as? String else {
                throw LaunchError("启动配置缺失，请重新安装 MTGA Replay。")
            }
            guard FileManager.default.isExecutableFile(atPath: node) else {
                throw LaunchError("找不到 Node.js，请重新安装启动入口。")
            }
            guard FileManager.default.isReadableFile(atPath: cli) else {
                throw LaunchError("无法读取复盘命令。请确认现有项目仍在原位置，且 App 有读取权限。")
            }
            let task = Process()
            task.executableURL = URL(fileURLWithPath: node)
            task.arguments = [cli, "latest"]
            task.currentDirectoryURL = URL(fileURLWithPath: project, isDirectory: true)
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = path
            task.environment = env
            task.standardOutput = output
            task.standardError = output
            task.terminationHandler = { [weak self] process in
                DispatchQueue.main.async { self?.finished(process) }
            }
            child = task
            record(state: "running", exitCode: nil)
            try task.run()
        } catch {
            fail(error.localizedDescription)
        }
    }

    // LaunchServices reuses this running instance: repeated clicks do not start a second CLI.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { false }

    private func finished(_ process: Process) {
        try? output?.close()
        output = nil
        record(state: "finished", exitCode: process.terminationStatus)
        if process.terminationReason == .exit && process.terminationStatus == 0 {
            NSApplication.shared.terminate(nil)
            return
        }
        let log = (try? String(contentsOf: logs.appendingPathComponent("latest-launch.log"), encoding: .utf8)) ?? ""
        let lines = log.split(separator: "\n").map(String.init)
        let reason = lines.last(where: { $0.hasPrefix("mtga-gpt-replay:") })
            ?? lines.last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
            ?? "复盘命令异常退出（\(process.terminationStatus)）。"
        fail(String(reason.prefix(420)), exitCode: process.terminationStatus)
    }

    private func fail(_ reason: String, exitCode: Int32? = nil) {
        try? output?.close()
        output = nil
        record(state: "failed", exitCode: exitCode)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "MTGA Replay 启动失败"
        alert.informativeText = reason
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        alert.runModal()
        NSApplication.shared.terminate(nil)
    }

    private func record(state: String, exitCode: Int32?) {
        var status: [String: Any] = ["state": state, "started_at": started, "launcher_pid": ProcessInfo.processInfo.processIdentifier]
        if state != "running" { status["finished_at"] = ISO8601DateFormatter().string(from: Date()) }
        if let code = exitCode { status["exit_code"] = code }
        if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]) {
            let url = logs.appendingPathComponent("last-launch.json")
            try? data.write(to: url, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }
}

struct LaunchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

let app = NSApplication.shared
let delegate = ReplayLauncher()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
