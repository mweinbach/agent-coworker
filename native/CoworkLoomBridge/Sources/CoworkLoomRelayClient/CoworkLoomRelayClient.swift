import Foundation
import Loom

import CoworkLoomRelayCore

public struct CoworkLoomRelayClientConfiguration: Sendable, Equatable {
    public var peerID: String?
    public var deviceID: UUID
    public var deviceName: String
    public var serviceType: String
    public var discoveryTimeout: Duration

    public init(
        peerID: String? = nil,
        deviceID: UUID = UUID(),
        deviceName: String = "Cowork iOS",
        serviceType: String = RelayProtocolConstants.serviceType,
        discoveryTimeout: Duration = .seconds(15)
    ) {
        self.peerID = peerID
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.serviceType = serviceType
        self.discoveryTimeout = discoveryTimeout
    }
}

public final class RelaySocket: @unchecked Sendable {
    public let messages: AsyncStream<String>

    private let sendHandler: @Sendable (String) async throws -> Void
    private let closeHandler: @Sendable () async -> Void

    init(
        events: AsyncStream<RelayChannelEvent>,
        sendHandler: @escaping @Sendable (String) async throws -> Void,
        closeHandler: @escaping @Sendable () async -> Void
    ) {
        self.sendHandler = sendHandler
        self.closeHandler = closeHandler
        self.messages = AsyncStream { continuation in
            Task {
                for await event in events {
                    switch event {
                    case let .text(text):
                        continuation.yield(text)
                    case .opened:
                        continue
                    case .closed, .error:
                        continuation.finish()
                        return
                    }
                }
                continuation.finish()
            }
        }
    }

    public func send(text: String) async throws {
        try await sendHandler(text)
    }

    public func close() {
        Task {
            await closeHandler()
        }
    }
}

@MainActor
public final class CoworkLoomRelayClient {
    private let configuration: CoworkLoomRelayClientConfiguration
    private let node: LoomNode
    private let multiplexer = RelayChannelMultiplexer()

    private var discovery: LoomDiscovery
    private var session: LoomAuthenticatedSession?
    private var relayStream: LoomMultiplexedStream?
    private var readTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?

    public init(configuration: CoworkLoomRelayClientConfiguration = .init()) {
        self.configuration = configuration
        self.node = LoomNode(
            configuration: LoomNetworkConfiguration(
                serviceType: configuration.serviceType,
                enabledDirectTransports: [.tcp]
            )
        )
        self.discovery = node.makeDiscovery(localDeviceID: configuration.deviceID)
    }

    public func connect(workspaceId: String, resumeSessionId: String? = nil) async throws -> RelaySocket {
        try await ensureRelayStream()

        let channelId = RelayChannelMultiplexer.makeChannelID()
        let events = await multiplexer.register(channelId: channelId)
        try await sendEnvelope(
            .openSocket(
                .init(
                    channelId: channelId,
                    workspaceId: workspaceId,
                    resumeSessionId: resumeSessionId
                )
            )
        )
        try await multiplexer.waitUntilOpened(channelId: channelId)

        return RelaySocket(
            events: events,
            sendHandler: { [weak self] text in
                guard let self else {
                    throw RelayError.notConnected
                }
                try await self.sendEnvelope(.socketText(.init(channelId: channelId, text: text)))
            },
            closeHandler: { [weak self] in
                guard let self else { return }
                try? await self.sendEnvelope(.socketClosed(.init(channelId: channelId, code: nil, reason: nil)))
                await self.multiplexer.unregister(channelId: channelId)
            }
        )
    }

    public func disconnect() async {
        discovery.stopDiscovery()
        if let session {
            await session.cancel()
        }
        await handleDisconnect()
    }

    private func ensureRelayStream() async throws {
        if relayStream != nil {
            return
        }

        if !discovery.isSearching {
            discovery.startDiscovery()
        }

        let peer = try await waitForPeer()
        let session = try await node.connect(
            to: peer.endpoint,
            using: .tcp,
            hello: makeHelloRequest()
        )
        let stream = try await session.openStream(label: RelayProtocolConstants.streamLabel)
        self.session = session
        self.relayStream = stream
        startConsuming(stream: stream, session: session)
        try await sendEnvelope(
            .hello(
                .init(
                    protocolVersion: RelayProtocolConstants.protocolVersion,
                    appVersion: "1",
                    peerName: configuration.deviceName
                )
            )
        )
    }

    private func waitForPeer() async throws -> LoomPeer {
        let deadline = ContinuousClock.now + configuration.discoveryTimeout
        while ContinuousClock.now < deadline {
            if let peer = resolvePeer() {
                return peer
            }
            try await Task.sleep(for: .milliseconds(250))
        }

        throw RelayError.transport("No Loom relay peer matching the requested device was discovered.")
    }

    private func resolvePeer() -> LoomPeer? {
        let eligiblePeers = discovery.discoveredPeers.filter(isEligibleRelayHost(_:))
        if let peerID = configuration.peerID?.lowercased(), !peerID.isEmpty {
            return eligiblePeers.first {
                $0.id.rawValue == peerID || $0.deviceID.uuidString.lowercased() == peerID
            }
        }
        return eligiblePeers.first
    }

    private func isEligibleRelayHost(_ peer: LoomPeer) -> Bool {
        let metadata = peer.advertisement.metadata
        return metadata[RelayProtocolConstants.roleMetadataKey] == RelayProtocolConstants.hostMetadataRole
            && metadata[RelayProtocolConstants.protocolMetadataKey] == String(RelayProtocolConstants.protocolVersion)
    }

    private func startConsuming(stream: LoomMultiplexedStream, session: LoomAuthenticatedSession) {
        readTask?.cancel()
        stateTask?.cancel()

        readTask = Task { [weak self] in
            guard let self else { return }
            for await payload in stream.incomingBytes {
                do {
                    let envelope = try RelayEnvelopeCodec.decode(payload)
                    await multiplexer.handle(envelope)
                } catch {
                    await multiplexer.failAll(.transport("Invalid relay payload: \(error.localizedDescription)"))
                    await handleDisconnect()
                    return
                }
            }
            await handleDisconnect()
        }

        stateTask = Task { [weak self] in
            guard let self else { return }
            let states = await session.makeStateObserver()
            for await state in states {
                switch state {
                case .cancelled:
                    await handleDisconnect()
                    return
                case let .failed(message):
                    await multiplexer.failAll(.transport(message))
                    await handleDisconnect()
                    return
                default:
                    continue
                }
            }
        }
    }

    private func handleDisconnect() async {
        relayStream = nil
        session = nil
        readTask?.cancel()
        stateTask?.cancel()
        readTask = nil
        stateTask = nil
        await multiplexer.failAll(.notConnected)
    }

    private func sendEnvelope(_ envelope: RelayEnvelope) async throws {
        guard let relayStream else {
            throw RelayError.notConnected
        }
        let data = try RelayEnvelopeCodec.encode(envelope)
        try await relayStream.send(data)
    }

    private func makeHelloRequest() -> LoomSessionHelloRequest {
        let advertisement = LoomPeerAdvertisement(
            deviceID: configuration.deviceID,
            deviceType: currentDeviceType(),
            metadata: [
                RelayProtocolConstants.protocolMetadataKey: String(RelayProtocolConstants.protocolVersion),
                RelayProtocolConstants.roleMetadataKey: RelayProtocolConstants.clientMetadataRole,
            ]
        )
        return LoomSessionHelloRequest(
            deviceID: configuration.deviceID,
            deviceName: configuration.deviceName,
            deviceType: currentDeviceType(),
            advertisement: advertisement
        )
    }

    private func currentDeviceType() -> DeviceType {
        #if os(iOS)
        return .iPhone
        #elseif os(visionOS)
        return .vision
        #elseif os(macOS)
        return .mac
        #else
        return .unknown
        #endif
    }
}
