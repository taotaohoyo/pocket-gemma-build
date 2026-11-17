import SwiftUI
import UIKit
import PocketCore

/// The app's model download (ModelStore, DownloadActivity, AppFiles and the
/// download record, compiled from PocketGemma-source.zip as they ship) in
/// the iOS simulator, driven by server.py (1.1.0 (293), Hachimoto さん's
/// directive of 2026-11-17 on downloads that failed in the background and
/// started again from nothing).
///
/// The one change to the store: its request goes to server.py's stand-in
/// for the Hub (`HarnessRequest`, put in by run-harness.sh), which serves
/// the real Qwen3 0.6B file with byte ranges, redirects like the Hub's,
/// links that run out, broken connections and wrong bytes when asked. The
/// harness asks the store what the app's buttons ask (download, 中止 keeping
/// or deleting what came) and posts what the store shows and keeps on the
/// phone once a second. Built twice: from 292's source (STORE_292) and
/// from 293's.
@main
struct HarnessApp: App {
    @UIApplicationDelegateAdaptor(HarnessDelegate.self) private var delegate
    @StateObject private var store = ModelStore.shared
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Text("Download harness").font(.headline)
                Text(store.statusText(for: Harness.spec)).font(.caption)
            }
            .task { Harness.shared.start() }
        }
    }
}

final class HarnessDelegate: NSObject, UIApplicationDelegate {
    /// From launch, also when iOS opens the app in the background for the
    /// download's events (no screen then).
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { Harness.shared.start() }
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            Harness.shared.event("background-session-events", detail: identifier)
            ModelStore.shared.attachBackgroundCompletion(completionHandler)
        }
    }
}

/// The store's request, to server.py.
enum HarnessRequest {
    static var server: URL? {
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--harness"),
           index + 1 < ProcessInfo.processInfo.arguments.count,
           let url = URL(string: ProcessInfo.processInfo.arguments[index + 1]) {
            UserDefaults.standard.set(url.absoluteString, forKey: "harness-server")
            return url
        }
        return UserDefaults.standard.string(forKey: "harness-server").flatMap(URL.init(string:))
    }

    static func request(for spec: ModelSpec, cellular: Bool) -> URLRequest {
        var request = ModelDownload.request(for: spec, cellular: cellular)
        if let server { request.url = server.appendingPathComponent("hub").appendingPathComponent(spec.fileName) }
        return request
    }
}

@MainActor
final class Harness {
    static let shared = Harness()
    static let spec = ModelSpec.qwen3
    private var started = false
    /// Kept across launches: a relaunch in a scenario must not run its
    /// commands again (until run 44029521508 it did).
    private var lastCommand = UserDefaults.standard.integer(forKey: "harness-last-command")
    private var postedLines = 0
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        return URLSession(configuration: config)
    }()

    func start() {
        guard !started, HarnessRequest.server != nil else { return }
        started = true
        let launch = UIApplication.shared.applicationState == .background ? "launched-in-background" : "launched"
        event(launch, detail: "pid \(ProcessInfo.processInfo.processIdentifier)")
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
                MainActor.assumeIsolated { Harness.shared.event(note.name == UIApplication.didEnterBackgroundNotification ? "background" : "foreground") }
            }
        }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            MainActor.assumeIsolated { Harness.shared.tick() }
        }
    }

    private var ticks = 0
    private func tick() {
        ticks += 1
        poll()
        if ticks % 2 == 0 { post("status", status()) }
    }

    private func poll() {
        guard let server = HarnessRequest.server else { return }
        var parts = URLComponents(url: server.appendingPathComponent("app/command"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "after", value: String(lastCommand))]
        session.dataTask(with: parts.url!) { data, _, _ in
            guard let data, let commands = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            Task { @MainActor in
                for command in commands {
                    guard let id = command["id"] as? Int, id > self.lastCommand, let name = command["name"] as? String else { continue }
                    self.lastCommand = id
                    UserDefaults.standard.set(id, forKey: "harness-last-command")
                    self.run(name)
                }
            }
        }.resume()
    }

    private func run(_ name: String) {
        let store = ModelStore.shared
        switch name {
        case "download": store.download(Self.spec)
        case "stop-keep":
            #if STORE_292
            store.cancelDownload(Self.spec)
            #else
            store.cancelDownload(Self.spec, keepingReceived: true)
            #endif
        case "stop-discard":
            #if STORE_292
            store.cancelDownload(Self.spec)
            #else
            store.cancelDownload(Self.spec, keepingReceived: false)
            #endif
        case "discard-kept":
            #if !STORE_292
            store.discardKept(Self.spec)
            #endif
        case "clear-error": store.error = nil
        default: break
        }
        event("ran", detail: name)
    }

    private func orNull<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }

    private func fileSize(_ url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size].flatMap { ($0 as? NSNumber)?.int64Value }
    }

    func status() -> [String: Any] {
        let store = ModelStore.shared
        let library = AppFiles.library
        let spec = Self.spec
        var status: [String: Any] = [
            "state": DownloadLog.appState,
            "restoring": store.isRestoring,
            "downloading": orNull(store.downloads[spec.id]),
            "installed": store.isInstalled(spec),
            "status_text": store.statusText(for: spec),
            "failure": orNull(store.failures[spec.id]),
            "error": orNull(store.error),
            "waiting": store.waitingIDs.contains(spec.id),
            "resume_bytes": orNull(fileSize(library.resumeURL(spec))),
            "pending_bytes": orNull(fileSize(library.pendingURL(spec))),
            "model_bytes": orNull(fileSize(library.modelURL(spec))),
            "receipt": FileManager.default.fileExists(atPath: library.receiptURL(spec).path),
        ]
        let record = library.stateDirectory.appendingPathComponent("\(spec.id).download")
        status["record"] = orNull(try? String(contentsOf: record, encoding: .utf8))
        #if !STORE_292
        status["kept"] = store.hasKept(spec)
        status["kept_progress"] = orNull(store.keptProgress(for: spec))
        #endif
        let lines = DownloadLog.shared.lines
        if postedLines > lines.count { postedLines = 0 }
        status["log"] = Array(lines.suffix(from: min(postedLines, lines.count)))
        postedLines = lines.count
        return status
    }

    func event(_ name: String, detail: String = "") {
        post("event", ["name": name, "detail": detail, "state": DownloadLog.appState])
    }

    private func post(_ kind: String, _ body: [String: Any]) {
        guard let server = HarnessRequest.server,
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: server.appendingPathComponent("app/\(kind)"))
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        session.dataTask(with: request).resume()
    }
}
