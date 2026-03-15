import Foundation
import Testing

@testable import CoworkLoomRelayCore
@testable import CoworkLoomRelayHost

private final class MockRelayTunnel: RelayTunnel, @unchecked Sendable {
    private let stream: AsyncStream<RelayTunnelEvent>
    private let continuation: AsyncStream<RelayTunnelEvent>.Continuation

    private(set) var sentTexts: [String] = []
    private(set) var closeCalls: [(Int?, String?)] = []

    init() {
        let (stream, continuation) = AsyncStream.makeStream(of: RelayTunnelEvent.self)
        self.stream = stream
        self.continuation = continuation
    }

    func makeEventStream() -> AsyncStream<RelayTunnelEvent> {
        stream
    }

    func send(text: String) async throws {
        sentTexts.append(text)
    }

    func close(code: Int?, reason: String?) async {
        closeCalls.append((code, reason))
        continuation.finish()
    }
}

@Test
func relayHostRejectsUnpublishedWorkspace() async {
    actor EnvelopeRecorder {
        var envelopes: [RelayEnvelope] = []
        func append(_ envelope: RelayEnvelope) {
            envelopes.append(envelope)
        }
        func all() -> [RelayEnvelope] { envelopes }
    }

    let recorder = EnvelopeRecorder()
    let controller = RelayHostController(
        sendEnvelope: { envelope in
            await recorder.append(envelope)
        },
        tunnelFactory: { _, _ in
            MockRelayTunnel()
        }
    )

    await controller.handle(.openSocket(.init(channelId: "channel-1", workspaceId: "workspace-1", resumeSessionId: nil)))
    let envelopes = await recorder.all()

    #expect(envelopes.contains {
        if case let .socketError(error) = $0 {
            return error.channelId == "channel-1" && error.retryable == false
        }
        return false
    })
}

@Test
func peerDisconnectClosesAllOpenRelayChannels() async throws {
    actor EnvelopeRecorder {
        var envelopes: [RelayEnvelope] = []
        func append(_ envelope: RelayEnvelope) {
            envelopes.append(envelope)
        }
    }

    let recorder = EnvelopeRecorder()
    let tunnel = MockRelayTunnel()
    let controller = RelayHostController(
        sendEnvelope: { envelope in
            await recorder.append(envelope)
        },
        tunnelFactory: { _, _ in
            tunnel
        }
    )

    await controller.setPublishedWorkspace(
        PublishedWorkspace(
            workspaceId: "workspace-1",
            workspaceName: "Workspace",
            serverURL: URL(string: "ws://127.0.0.1:7337/ws")!
        )
    )
    await controller.handle(.openSocket(.init(channelId: "channel-1", workspaceId: "workspace-1", resumeSessionId: nil)))
    #expect(await controller.openChannelCount() == 1)

    await controller.handlePeerDisconnected()

    #expect(await controller.openChannelCount() == 0)
    #expect(tunnel.closeCalls.count == 1)
}

@Test
func relayTunnelAppendsResumeSessionQueryItem() {
    let url = URLSessionRelayTunnel.makeWebSocketURL(
        url: URL(string: "ws://127.0.0.1:7337/ws?existing=1")!,
        request: .init(channelId: "channel-1", workspaceId: "workspace-1", resumeSessionId: "session-123")
    )

    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)

    #expect(components?.queryItems?.contains(URLQueryItem(name: "existing", value: "1")) == true)
    #expect(components?.queryItems?.contains(URLQueryItem(name: "resumeSessionId", value: "session-123")) == true)
}
