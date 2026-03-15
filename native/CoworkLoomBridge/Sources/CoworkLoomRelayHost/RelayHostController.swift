import Foundation

import CoworkLoomRelayCore

public struct PublishedWorkspace: Sendable, Equatable {
    public let workspaceId: String
    public let workspaceName: String
    public let serverURL: URL

    public init(workspaceId: String, workspaceName: String, serverURL: URL) {
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.serverURL = serverURL
    }
}

public enum RelayTunnelEvent: Sendable, Equatable {
    case text(String)
    case closed(code: Int?, reason: String?)
    case error(message: String, retryable: Bool)
}

public protocol RelayTunnel: Sendable {
    func makeEventStream() -> AsyncStream<RelayTunnelEvent>
    func send(text: String) async throws
    func close(code: Int?, reason: String?) async
}

public actor RelayHostController {
    public typealias SendEnvelope = @Sendable (RelayEnvelope) async -> Void
    public typealias TunnelFactory = @Sendable (URL, RelayOpenSocket) async throws -> any RelayTunnel

    private struct ChannelState {
        let tunnel: any RelayTunnel
        let task: Task<Void, Never>
    }

    private let sendEnvelope: SendEnvelope
    private let tunnelFactory: TunnelFactory
    private var publishedWorkspace: PublishedWorkspace?
    private var channels: [String: ChannelState] = [:]

    public init(sendEnvelope: @escaping SendEnvelope, tunnelFactory: @escaping TunnelFactory) {
        self.sendEnvelope = sendEnvelope
        self.tunnelFactory = tunnelFactory
    }

    public func setPublishedWorkspace(_ workspace: PublishedWorkspace?) async {
        let previousWorkspaceId = publishedWorkspace?.workspaceId
        publishedWorkspace = workspace
        if previousWorkspaceId != workspace?.workspaceId {
            await closeAllChannels(reason: "Workspace relay publication changed.")
        }
    }

    public func handle(_ envelope: RelayEnvelope) async {
        switch envelope {
        case let .openSocket(request):
            await openChannel(for: request)
        case let .socketText(message):
            await forwardSocketText(message)
        case let .socketClosed(message):
            await closeChannel(channelId: message.channelId, code: message.code, reason: message.reason)
        case let .ping(payload):
            await sendEnvelope(.pong(.init(nonce: payload.nonce)))
        default:
            break
        }
    }

    public func handlePeerDisconnected() async {
        await closeAllChannels(reason: "Relay peer disconnected.")
    }

    public func openChannelCount() -> Int {
        channels.count
    }

    private func openChannel(for request: RelayOpenSocket) async {
        guard let workspace = publishedWorkspace, workspace.workspaceId == request.workspaceId else {
            await sendEnvelope(
                .socketError(
                    .init(
                        channelId: request.channelId,
                        message: "Workspace relay is not currently published.",
                        retryable: false
                    )
                )
            )
            await sendEnvelope(.socketClosed(.init(channelId: request.channelId, code: 4404, reason: "Workspace relay unavailable.")))
            return
        }

        if let existing = channels.removeValue(forKey: request.channelId) {
            existing.task.cancel()
            await existing.tunnel.close(code: nil, reason: "Replacing existing relay channel.")
        }

        do {
            let tunnel = try await tunnelFactory(workspace.serverURL, request)
            let events = tunnel.makeEventStream()
            let task = Task { [weak self] in
                guard let self else { return }
                for await event in events {
                    await self.handleTunnelEvent(event, channelId: request.channelId)
                }
            }
            channels[request.channelId] = ChannelState(tunnel: tunnel, task: task)
            await sendEnvelope(.socketOpened(.init(channelId: request.channelId)))
        } catch {
            await sendEnvelope(
                .socketError(
                    .init(
                        channelId: request.channelId,
                        message: error.localizedDescription,
                        retryable: true
                    )
                )
            )
        }
    }

    private func forwardSocketText(_ message: RelaySocketText) async {
        guard let channel = channels[message.channelId] else {
            await sendEnvelope(
                .socketError(
                    .init(
                        channelId: message.channelId,
                        message: "Relay channel is not open.",
                        retryable: false
                    )
                )
            )
            return
        }

        do {
            try await channel.tunnel.send(text: message.text)
        } catch {
            await sendEnvelope(
                .socketError(
                    .init(
                        channelId: message.channelId,
                        message: error.localizedDescription,
                        retryable: true
                    )
                )
            )
        }
    }

    private func closeChannel(channelId: String, code: Int?, reason: String?) async {
        guard let channel = channels.removeValue(forKey: channelId) else {
            return
        }
        channel.task.cancel()
        await channel.tunnel.close(code: code, reason: reason)
        await sendEnvelope(.socketClosed(.init(channelId: channelId, code: code, reason: reason)))
    }

    private func handleTunnelEvent(_ event: RelayTunnelEvent, channelId: String) async {
        switch event {
        case let .text(text):
            await sendEnvelope(.socketText(.init(channelId: channelId, text: text)))
        case let .closed(code, reason):
            if let channel = channels.removeValue(forKey: channelId) {
                channel.task.cancel()
            }
            await sendEnvelope(.socketClosed(.init(channelId: channelId, code: code, reason: reason)))
        case let .error(message, retryable):
            if let channel = channels.removeValue(forKey: channelId) {
                channel.task.cancel()
            }
            await sendEnvelope(.socketError(.init(channelId: channelId, message: message, retryable: retryable)))
        }
    }

    private func closeAllChannels(reason: String) async {
        let entries = channels
        channels.removeAll()
        for (channelId, channel) in entries {
            channel.task.cancel()
            await channel.tunnel.close(code: nil, reason: reason)
            await sendEnvelope(.socketClosed(.init(channelId: channelId, code: nil, reason: reason)))
        }
    }
}
