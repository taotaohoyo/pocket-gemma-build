import SwiftUI
import PocketCore

/// The app's model downloads in the iOS simulator (1.1.0 (240)): the same
/// background URLSession setup as ModelStore (identifier, cellular,
/// connections per host, not discretionary), the same requests
/// (ModelDownload.request) and the same check (ModelValidator), so iOS's
/// download daemon, App Transport Security and the Hub's redirects are all
/// in the path. Every file of every catalog model, a model's files side by
/// side as the app starts them; then E2B again after deleting it (the
/// phone's 0% case on 239), and a download stopped with resume data and
/// resumed. Prints DLPROBE lines of JSON; DLPROBE-DONE at the end.
@main
struct ProbeApp: App {
    @UIApplicationDelegateAdaptor(ProbeDelegate.self) private var delegate
    var body: some Scene { WindowGroup { Text("Download probe") } }
}

final class ProbeDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Task.detached { await Probe.shared.run() }
        return true
    }
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}

func emit(_ kind: String, _ fields: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])) ?? Data()
    let line = "\(kind) \(String(decoding: data, as: UTF8.self))\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

final class Probe: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = Probe()
    enum Outcome { case saved(URL, Int), failed(String, Data?) }
    private let lock = NSLock()
    private var waiters: [Int: CheckedContinuation<Outcome, Never>] = [:]
    /// Outcomes that came before anyone waited for them.
    private var early: [Int: Outcome] = [:]
    private var reports: [Int: Int] = [:]
    private let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("probe", isDirectory: true)

    /// As ModelStore's session.
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "app.pocketgemma.model-download")
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.allowsCellularAccess = true
        config.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    func run() async {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let leftovers = await session.allTasks
        emit("DLPROBE-START", ["leftover_tasks": leftovers.count, "files": ModelSpec.allFiles.count])
        leftovers.forEach { $0.cancel() }
        for model in ModelSpec.catalog {
            _ = await download(model.files, case: "catalog")
        }
        // The phone's case on 239: E2B deleted, then downloaded again.
        _ = await download([.e2b], case: "again-after-delete")
        // Stopped with resume data part of the way, then resumed: the
        // second request goes to the Hub's signed link from the first.
        await resume(.qwen25, after: 200_000_000)
        emit("DLPROBE-DONE", [:])
    }

    private func start(_ spec: ModelSpec, resumeData: Data? = nil) -> URLSessionDownloadTask {
        let task = resumeData.map { session.downloadTask(withResumeData: $0) }
            ?? session.downloadTask(with: ModelDownload.request(for: spec, cellular: false))
        task.taskDescription = spec.id
        task.resume()
        return task
    }

    private func outcome(of task: URLSessionTask) async -> Outcome {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let outcome = early.removeValue(forKey: task.taskIdentifier) {
                lock.unlock()
                continuation.resume(returning: outcome)
            } else {
                waiters[task.taskIdentifier] = continuation
                lock.unlock()
            }
        }
    }

    private func finish(_ task: URLSessionTask, _ outcome: Outcome) {
        lock.lock()
        let waiter = waiters.removeValue(forKey: task.taskIdentifier)
        if waiter == nil { early[task.taskIdentifier] = outcome }
        lock.unlock()
        waiter?.resume(returning: outcome)
    }

    /// One model's files side by side, as the app starts them; the figures
    /// every five seconds; each file checked as the app checks it.
    private func download(_ files: [ModelSpec], case name: String) async -> Bool {
        let started = Date()
        let tasks = files.map { start($0) }
        let watcher = Task { await watch(tasks, case: name) }
        var allSaved = true
        await withTaskGroup(of: Bool.self) { group in
            for (file, task) in zip(files, tasks) {
                group.addTask { await self.check(file, task: task, started: started, case: name) }
            }
            for await saved in group { allSaved = allSaved && saved }
        }
        watcher.cancel()
        emit("DLPROBE-MODEL", ["case": name, "files": files.map(\.id), "ok": allSaved,
                               "seconds": Int(Date().timeIntervalSince(started))])
        return allSaved
    }

    private func check(_ file: ModelSpec, task: URLSessionDownloadTask, started: Date, case name: String) async -> Bool {
        switch await outcome(of: task) {
        case .failed(let error, _):
            emit("DLPROBE-FILE", ["case": name, "id": file.id, "ok": false, "error": error])
            return false
        case .saved(let url, let status):
            let downloaded = Date().timeIntervalSince(started)
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? -1
            var fields: [String: Any] = ["case": name, "id": file.id, "status": status, "bytes": size,
                                         "download_seconds": Int(downloaded)]
            do {
                let checkStart = Date()
                try ModelValidator.validate(url, spec: file)
                fields["ok"] = true
                fields["sha256"] = "match"
                fields["check_seconds"] = Int(Date().timeIntervalSince(checkStart))
            } catch {
                fields["ok"] = false
                fields["error"] = error.localizedDescription
            }
            try? FileManager.default.removeItem(at: url)
            emit("DLPROBE-FILE", fields)
            return fields["ok"] as? Bool ?? false
        }
    }

    /// What iOS's daemon reports for each task while it runs; a task that
    /// has received nothing new for 120 seconds is reported and stopped.
    private func watch(_ tasks: [URLSessionDownloadTask], case name: String) async {
        var last: [Int: (Int64, Date)] = [:]
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            for task in tasks where task.state == .running || task.state == .suspended {
                let received = task.countOfBytesReceived
                let response = task.response as? HTTPURLResponse
                lock.lock(); let count = reports[task.taskIdentifier] ?? 0; lock.unlock()
                emit("DLPROBE-TICK", ["case": name, "id": task.taskDescription ?? "?", "state": task.state.rawValue,
                                      "received": received, "expected": task.countOfBytesExpectedToReceive,
                                      "status": response?.statusCode ?? 0, "host": task.currentRequest?.url?.host ?? "",
                                      "progress_reports": count])
                let previous = last[task.taskIdentifier]
                if previous == nil || received > previous!.0 {
                    last[task.taskIdentifier] = (received, Date())
                } else if Date().timeIntervalSince(previous!.1) > 120 {
                    emit("DLPROBE-STALL", ["case": name, "id": task.taskDescription ?? "?", "received": received])
                    task.cancel()
                }
            }
        }
    }

    /// Stops a download with resume data once it has the given bytes, then
    /// resumes it from that data and checks the file.
    private func resume(_ spec: ModelSpec, after bytes: Int64) async {
        let started = Date()
        let task = start(spec)
        let waiting = Task { await outcome(of: task) }
        while task.countOfBytesReceived < bytes && task.state == .running {
            try? await Task.sleep(for: .milliseconds(200))
        }
        let stoppedAt = task.countOfBytesReceived
        let data = await task.cancelByProducingResumeData()
        _ = await waiting.value
        emit("DLPROBE-RESUME-DATA", ["id": spec.id, "stopped_at": stoppedAt, "resume_data": data?.count ?? 0])
        guard let data else { return }
        let resumed = start(spec, resumeData: data)
        let saved = await check(spec, task: resumed, started: started, case: "resume")
        emit("DLPROBE-MODEL", ["case": "resume", "files": [spec.id], "ok": saved,
                               "seconds": Int(Date().timeIntervalSince(started))])
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        lock.lock(); reports[downloadTask.taskIdentifier, default: 0] += 1; lock.unlock()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            let body = (try? String(contentsOf: location, encoding: .utf8)).map { String($0.prefix(300)) } ?? ""
            finish(downloadTask, .failed("HTTP \(status) \(body)", nil))
            return
        }
        let kept = folder.appendingPathComponent("\(downloadTask.taskDescription ?? "file")-\(downloadTask.taskIdentifier)")
        do {
            try FileManager.default.moveItem(at: location, to: kept)
            finish(downloadTask, .saved(kept, status))
        } catch {
            finish(downloadTask, .failed("move: \(error.localizedDescription)", nil))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error as NSError? else { return }
        let resumeData = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        finish(task, .failed("\(error.domain) \(error.code) \(error.localizedDescription)", resumeData))
    }
}
