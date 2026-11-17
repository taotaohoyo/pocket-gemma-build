import Foundation
import Network
import SwiftUI
import PocketCore

// What the download's files ask of the rest of the app, in its place for
// the harness (Harness.swift): the network check's words for the record,
// the developer 12B check's files (none here), the attachments' folder,
// a model's symbol for the island, the card style of the record's card.

enum NetworkCheck {
    static let sessionPrefix = "app.pocketgemma.network-check"
    nonisolated static func describe(_ path: NWPath) -> String {
        path.availableInterfaces.map { "\($0.type)" }.joined(separator: "+")
    }
    nonisolated static func route(_ metrics: URLSessionTaskMetrics) -> String {
        metrics.transactionMetrics.map { step in
            "\(step.request.url?.path ?? "-") \((step.response as? HTTPURLResponse)?.statusCode ?? 0)"
        }.joined(separator: " → ")
    }
}

enum LargeModelProbeFiles {
    private static var base: URL { FileManager.default.temporaryDirectory.appendingPathComponent("harness-12b", isDirectory: true) }
    static var documentsFolder: URL { base.appendingPathComponent("documents", isDirectory: true) }
    static var folder: URL { base.appendingPathComponent("folder", isDirectory: true) }
    static func prepare() throws {}
    static var ownFileReady: Bool { false }
    static var ownModel: URL { folder.appendingPathComponent("none") }
    static func handedOver() {}
}

enum AttachmentStorage {
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PocketGemma/Attachments", isDirectory: true)
    }
}

struct ModelMark {
    let model: ModelSpec
    init(model: ModelSpec) { self.model = model }
    var symbol: String { "cpu" }
}

extension View {
    func fieluaCard(cornerRadius: CGFloat) -> some View { self }
}
