import Foundation

public actor RelayChannelMultiplexer {
    private struct Entry {
        let continuation: AsyncStream<RelayChannelEvent>.Continuation
        var isOpened: Bool
        var waiters: [CheckedContinuation<Void, Error>]
    }

    private var entries: [String: Entry] = [:]

    public init() {}

    public static func makeChannelID() -> String {
        UUID().uuidString.lowercased()
    }

    public func register(channelId: String) -> AsyncStream<RelayChannelEvent> {
        let (stream, continuation) = AsyncStream.makeStream(of: RelayChannelEvent.self)
        entries[channelId] = Entry(continuation: continuation, isOpened: false, waiters: [])
        return stream
    }

    public func waitUntilOpened(channelId: String) async throws {
        guard var entry = entries[channelId] else {
            throw RelayError.invalidState("Relay channel \(channelId) is not registered.")
        }
        if entry.isOpened {
            return
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            entry.waiters.append(continuation)
            entries[channelId] = entry
        }
    }

    public func unregister(channelId: String) {
        guard let entry = entries.removeValue(forKey: channelId) else {
            return
        }
        for waiter in entry.waiters {
            waiter.resume(throwing: RelayError.channelClosed(code: nil, reason: "Relay channel removed."))
        }
        entry.continuation.finish()
    }

    public func handle(_ envelope: RelayEnvelope) {
        switch envelope {
        case let .socketOpened(payload):
            guard var entry = entries[payload.channelId] else { return }
            entry.isOpened = true
            let waiters = entry.waiters
            entry.waiters = []
            entries[payload.channelId] = entry
            entry.continuation.yield(.opened)
            for waiter in waiters {
                waiter.resume()
            }
        case let .socketText(payload):
            guard let entry = entries[payload.channelId] else { return }
            entry.continuation.yield(.text(payload.text))
        case let .socketClosed(payload):
            finish(
                channelId: payload.channelId,
                event: .closed(code: payload.code, reason: payload.reason),
                error: RelayError.channelClosed(code: payload.code, reason: payload.reason)
            )
        case let .socketError(payload):
            finish(
                channelId: payload.channelId,
                event: .error(message: payload.message, retryable: payload.retryable),
                error: RelayError.channelRejected(payload.message)
            )
        default:
            break
        }
    }

    public func failAll(_ error: RelayError) {
        let ids = Array(entries.keys)
        for channelId in ids {
            finish(channelId: channelId, event: .error(message: error.localizedDescription, retryable: false), error: error)
        }
    }

    private func finish(channelId: String, event: RelayChannelEvent, error: RelayError) {
        guard let entry = entries.removeValue(forKey: channelId) else {
            return
        }
        entry.continuation.yield(event)
        entry.continuation.finish()
        for waiter in entry.waiters {
            waiter.resume(throwing: error)
        }
    }
}
