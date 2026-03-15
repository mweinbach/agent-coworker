import Foundation

import CoworkLoomRelayCore

public final class URLSessionRelayTunnel: RelayTunnel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let events: AsyncStream<RelayTunnelEvent>
    private let continuation: AsyncStream<RelayTunnelEvent>.Continuation

    public init(url: URL, request: RelayOpenSocket? = nil) {
        let session = URLSession(configuration: .default)
        self.task = session.webSocketTask(with: Self.makeWebSocketURL(url: url, request: request))
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

    static func makeWebSocketURL(url: URL, request: RelayOpenSocket?) -> URL {
        guard
            let resumeSessionId = request?.resumeSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
            !resumeSessionId.isEmpty
        else {
            return url
        }

        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            let separator = url.absoluteString.contains("?") ? "&" : "?"
            return URL(string: "\(url.absoluteString)\(separator)resumeSessionId=\(resumeSessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? resumeSessionId)") ?? url
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "resumeSessionId" }
        queryItems.append(URLQueryItem(name: "resumeSessionId", value: resumeSessionId))
        components.queryItems = queryItems
        return components.url ?? url
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
