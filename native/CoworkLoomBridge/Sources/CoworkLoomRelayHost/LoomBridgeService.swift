import Foundation
import Loom

import CoworkLoomRelayCore

@MainActor
final class ApprovedPeerTrustProvider: LoomTrustProvider {
    private var approvedDeviceIDs: Set<UUID> = []

    func setApprovedPeerID(_ rawPeerID: String?) {
        approvedDeviceIDs.removeAll()
        guard let rawPeerID else { return }
        let candidate = rawPeerID.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? rawPeerID
        if let uuid = UUID(uuidString: candidate) {
            approvedDeviceIDs.insert(uuid)
        }
    }

    func evaluateTrust(for peer: LoomPeerIdentity) async -> LoomTrustDecision {
        approvedDeviceIDs.contains(peer.deviceID) ? .trusted : .denied
    }

    func grantTrust(to peer: LoomPeerIdentity) async throws {
        approvedDeviceIDs.insert(peer.deviceID)
    }

    func revokeTrust(for deviceID: UUID) async throws {
        approvedDeviceIDs.remove(deviceID)
    }
}

public typealias BridgeEventEmitter = @Sendable (BridgeEvent) -> Void

@MainActor
public final class LoomBridgeService {
    private let emitEvent: BridgeEventEmitter
    private let trustProvider = ApprovedPeerTrustProvider()
    private lazy var relayHost = RelayHostController(
        sendEnvelope: { [weak self] envelope in
            try? await self?.sendEnvelope(envelope)
        },
        tunnelFactory: { url, _request in
            URLSessionRelayTunnel(url: url)
        }
    )

    private let localDeviceID: UUID
    private let node: LoomNode
    private let discovery: LoomDiscovery

    private var deviceName: String
    private var advertising = false
    private var peer: BridgePeerState?
    private var publishedWorkspace: PublishedWorkspace?
    private var lastError: String?
    private var session: LoomAuthenticatedSession?
    private var relayStream: LoomMultiplexedStream?
    private var incomingStreamTask: Task<Void, Never>?
    private var relayReadTask: Task<Void, Never>?
    private var sessionStateTask: Task<Void, Never>?

    public init(emitEvent: @escaping BridgeEventEmitter) {
        self.emitEvent = emitEvent
        self.localDeviceID = Self.loadOrCreateLocalDeviceID()
        self.deviceName = Host.current().localizedName ?? "Cowork Mac"
        self.node = LoomNode(
            configuration: LoomNetworkConfiguration(
                serviceType: RelayProtocolConstants.serviceType,
                enabledDirectTransports: [.tcp]
            ),
            identityManager: .shared,
            trustProvider: trustProvider
        )
        self.discovery = node.makeDiscovery(localDeviceID: localDeviceID)
        discovery.onPeersChanged = { [weak self] _ in
            Task { @MainActor in
                await self?.emitState()
            }
        }
    }

    public func emitReady() {
        emitEvent(.ready)
    }

    public func handle(_ command: BridgeCommand) async {
        do {
            switch command {
            case let .start(deviceName):
                try await startAdvertising(deviceName: deviceName)
            case .stop:
                await stopAdvertising()
            case let .connectPeer(peerId):
                try await connectPeer(peerId: peerId)
            case .disconnectPeer:
                await disconnectPeer(resetPeerIdentity: false)
            case let .publishWorkspace(workspaceId, workspaceName, serverUrl):
                try await publishWorkspace(workspaceId: workspaceId, workspaceName: workspaceName, serverUrl: serverUrl)
            case let .unpublishWorkspace(workspaceId):
                await unpublishWorkspace(workspaceId: workspaceId)
            case .getState:
                await emitState()
            }
        } catch {
            lastError = error.localizedDescription
            emitEvent(.log(level: .error, message: error.localizedDescription))
            await emitState()
        }
    }

    public func emitState() async {
        let state = BridgeState(
            supported: true,
            advertising: advertising,
            peer: peer,
            localDeviceId: localDeviceID.uuidString.lowercased(),
            localDeviceName: deviceName,
            discoveredPeers: bridgeDiscoveredPeers(),
            publishedWorkspaceId: publishedWorkspace?.workspaceId,
            publishedWorkspaceName: publishedWorkspace?.workspaceName,
            openChannelCount: await relayHost.openChannelCount(),
            lastError: lastError
        )
        emitEvent(.state(state))
    }

    private func bridgeDiscoveredPeers() -> [BridgeDiscoveredPeerState] {
        discovery.discoveredPeers.map { discoveredPeer in
            BridgeDiscoveredPeerState(
                id: discoveredPeer.id.rawValue,
                name: discoveredPeer.name,
                deviceId: discoveredPeer.deviceID.uuidString.lowercased()
            )
        }
    }

    private func startAdvertising(deviceName: String?) async throws {
        if let deviceName, !deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.deviceName = deviceName
        }

        if !discovery.isSearching {
            discovery.startDiscovery()
        }

        guard !advertising else {
            await emitState()
            return
        }

        _ = try await node.startAuthenticatedAdvertising(
            serviceName: self.deviceName,
            helloProvider: { [weak self] in
                guard let self else {
                    throw RelayError.notConnected
                }
                return await self.makeHelloRequest()
            },
            onSession: { [weak self] session in
                Task { @MainActor in
                    await self?.acceptIncomingSession(session)
                }
            }
        )
        advertising = true
        lastError = nil
        emitEvent(.log(level: .info, message: "Loom relay advertising started."))
        await emitState()
    }

    private func stopAdvertising() async {
        advertising = false
        discovery.stopDiscovery()
        await node.stopAdvertising()
        await disconnectPeer(resetPeerIdentity: true)
        emitEvent(.log(level: .info, message: "Loom relay advertising stopped."))
        await emitState()
    }

    private func connectPeer(peerId: String) async throws {
        if !discovery.isSearching {
            discovery.startDiscovery()
        }

        trustProvider.setApprovedPeerID(peerId)
        let knownName = discovery.discoveredPeers.first(where: { $0.id.rawValue == peerId || $0.deviceID.uuidString.lowercased() == peerId.lowercased() })?.name ?? "Unknown Peer"
        peer = BridgePeerState(id: peerId, name: knownName, state: "connecting")
        await emitState()

        guard let discoveredPeer = discovery.discoveredPeers.first(where: {
            $0.id.rawValue == peerId || $0.deviceID.uuidString.lowercased() == peerId.lowercased()
        }) else {
            throw RelayError.transport("Requested Loom peer was not found in discovery results.")
        }

        let session = try await node.connect(
            to: discoveredPeer.endpoint,
            using: .tcp,
            hello: makeHelloRequest()
        )
        try await activateSession(
            session,
            peerId: discoveredPeer.id.rawValue,
            peerName: discoveredPeer.name,
            shouldOpenOutboundStream: true
        )
    }

    private func publishWorkspace(workspaceId: String, workspaceName: String, serverUrl: String) async throws {
        guard let url = URL(string: serverUrl) else {
            throw RelayError.invalidState("Workspace relay publish URL is invalid.")
        }
        publishedWorkspace = PublishedWorkspace(workspaceId: workspaceId, workspaceName: workspaceName, serverURL: url)
        await relayHost.setPublishedWorkspace(publishedWorkspace)
        lastError = nil
        await emitState()
    }

    private func unpublishWorkspace(workspaceId: String) async {
        guard publishedWorkspace?.workspaceId == workspaceId else {
            return
        }
        publishedWorkspace = nil
        await relayHost.setPublishedWorkspace(nil)
        await emitState()
    }

    private func acceptIncomingSession(_ session: LoomAuthenticatedSession) async {
        let context = await session.context
        guard let context else {
            await session.cancel()
            return
        }
        do {
            try await activateSession(
                session,
                peerId: context.peerIdentity.deviceID.uuidString.lowercased(),
                peerName: context.peerIdentity.name,
                shouldOpenOutboundStream: false
            )
        } catch {
            lastError = error.localizedDescription
            emitEvent(.log(level: .error, message: error.localizedDescription))
            await session.cancel()
            await emitState()
        }
    }

    private func activateSession(
        _ session: LoomAuthenticatedSession,
        peerId: String,
        peerName: String,
        shouldOpenOutboundStream: Bool
    ) async throws {
        await disconnectPeer(resetPeerIdentity: false)

        self.session = session
        self.peer = BridgePeerState(id: peerId, name: peerName, state: "connected")
        self.lastError = nil
        startObservingSession(session)

        if shouldOpenOutboundStream {
            let stream = try await session.openStream(label: RelayProtocolConstants.streamLabel)
            bindRelayStream(stream)
        } else {
            incomingStreamTask = Task { [weak self] in
                guard let self else { return }
                let streams = session.makeIncomingStreamObserver()
                for await stream in streams {
                    if stream.label == RelayProtocolConstants.streamLabel {
                        self.bindRelayStream(stream)
                        return
                    }
                }
            }
        }

        await emitState()
    }

    private func bindRelayStream(_ stream: LoomMultiplexedStream) {
        relayStream = stream
        relayReadTask?.cancel()
        relayReadTask = Task { [weak self] in
            guard let self else { return }
            for await payload in stream.incomingBytes {
                do {
                    let envelope = try RelayEnvelopeCodec.decode(payload)
                    await relayHost.handle(envelope)
                } catch {
                    lastError = "Invalid relay payload: \(error.localizedDescription)"
                    emitEvent(.log(level: .error, message: lastError ?? "Invalid relay payload."))
                    await disconnectPeer(resetPeerIdentity: false)
                    return
                }
            }
            await disconnectPeer(resetPeerIdentity: false)
        }

        Task { [weak self] in
            guard let self else { return }
            try? await self.sendEnvelope(
                .hello(
                    .init(
                        protocolVersion: RelayProtocolConstants.protocolVersion,
                        appVersion: "1",
                        peerName: deviceName
                    )
                )
            )
        }
    }

    private func startObservingSession(_ session: LoomAuthenticatedSession) {
        sessionStateTask?.cancel()
        sessionStateTask = Task { [weak self] in
            guard let self else { return }
            let states = await session.makeStateObserver()
            for await state in states {
                switch state {
                case .cancelled:
                    await disconnectPeer(resetPeerIdentity: false)
                    return
                case let .failed(message):
                    lastError = message
                    await disconnectPeer(resetPeerIdentity: false)
                    return
                default:
                    continue
                }
            }
        }
    }

    private func disconnectPeer(resetPeerIdentity: Bool) async {
        incomingStreamTask?.cancel()
        relayReadTask?.cancel()
        sessionStateTask?.cancel()
        incomingStreamTask = nil
        relayReadTask = nil
        sessionStateTask = nil

        if let session {
            await session.cancel()
        }
        session = nil
        relayStream = nil
        await relayHost.handlePeerDisconnected()

        if resetPeerIdentity {
            trustProvider.setApprovedPeerID(nil)
            peer = nil
        } else if let currentPeer = peer {
            peer = BridgePeerState(id: currentPeer.id, name: currentPeer.name, state: "disconnected")
        }
        await emitState()
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
            deviceID: localDeviceID,
            deviceType: .mac,
            metadata: [
                "cowork.relay.protocol": String(RelayProtocolConstants.protocolVersion),
                "cowork.relay.role": RelayProtocolConstants.hostMetadataRole,
            ]
        )
        return LoomSessionHelloRequest(
            deviceID: localDeviceID,
            deviceName: deviceName,
            deviceType: .mac,
            advertisement: advertisement
        )
    }

    private static func loadOrCreateLocalDeviceID() -> UUID {
        let url = applicationSupportDirectory().appendingPathComponent("device-id.txt")
        if let contents = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let existing = UUID(uuidString: contents) {
            return existing
        }

        let created = UUID()
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? created.uuidString.lowercased().write(to: url, atomically: true, encoding: .utf8)
        return created
    }

    private static func applicationSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        return base.appendingPathComponent("CoworkLoomBridge", isDirectory: true)
    }
}
