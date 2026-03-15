import Foundation

public final class URLSessionRelayTunnel: RelayTunnel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let events: AsyncStream<RelayTunnelEvent>
    private let continuation: AsyncStream<RelayTunnelEvent>.Continuation

    public init(url: URL) {
        let session = URLSession(configuration: .default)
        self.task = session.webSocketTask(with: url)
        let (events, continuation) = AsyncStream.makeStream(of: RelayTunnelEvent.self)
        self.events = events
        self.continuation = continuation
        task.resume()
        receiveNext()
    }

    deinit {
        continuation.finish()
    }

    public func makeEventStream() -> AsyncStream<RelayTunnelEvent> {
        events
    }

    public func send(text: String) async throws {
        try await task.send(.string(text))
    }

    public func close(code: Int?, reason: String?) async {
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code ?? URLSessionWebSocketTask.CloseCode.normalClosure.rawValue)
            ?? .normalClosure
        task.cancel(with: closeCode, reason: reason?.data(using: .utf8))
        continuation.finish()
    }

    private func receiveNext() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let message = try await task.receive()
                switch message {
                case let .string(text):
                    continuation.yield(.text(text))
                    receiveNext()
                case .data:
                    continuation.yield(.error(message: "Binary WebSocket frames are not supported by the Cowork relay.", retryable: false))
                    continuation.finish()
                @unknown default:
                    continuation.yield(.error(message: "Received an unknown WebSocket payload type.", retryable: false))
                    continuation.finish()
                }
            } catch {
                continuation.yield(.closed(code: nil, reason: error.localizedDescription))
                continuation.finish()
            }
        }
    }
}
