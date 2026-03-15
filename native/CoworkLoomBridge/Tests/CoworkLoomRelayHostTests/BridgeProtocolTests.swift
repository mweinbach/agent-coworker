import Foundation
import Testing

import Loom

@testable import CoworkLoomRelayCore
@testable import CoworkLoomRelayHost

@Test
func bridgeStateCodableRoundTripPreservesPairingMetadata() throws {
    let event = BridgeEvent.state(
        .init(
            supported: true,
            advertising: true,
            peer: .init(id: "peer-live", name: "My iPhone", state: "connected"),
            localDeviceId: "mac-device-id",
            localDeviceName: "Cowork Mac",
            discoveredPeers: [
                .init(id: "peer-discovered", name: "Alex iPhone", deviceId: "ios-device-id"),
            ],
            publishedWorkspaceId: "ws_1",
            publishedWorkspaceName: "Agent Coworker",
            openChannelCount: 2,
            lastError: nil
        )
    )

    let data = try JSONEncoder().encode(event)
    let decoded = try JSONDecoder().decode(BridgeEvent.self, from: data)

    #expect(decoded == event)
}

@Test
func bridgeApprovalRequestRoundTripPreservesPeerIdentity() throws {
    let event = BridgeEvent.approvalRequested(
        .init(
            peerId: "peer-approval",
            peerName: "My iPhone"
        )
    )

    let data = try JSONEncoder().encode(event)
    let decoded = try JSONDecoder().decode(BridgeEvent.self, from: data)

    #expect(decoded == event)
}

@MainActor
@Test
func relayAdvertisementIncludesIdentityKeyAndPublishedWorkspaceMetadata() {
    let deviceID = UUID(uuidString: "65e38fae-e34f-4086-bf5d-682806bc5396")!
    let identityKeyID = "test-identity-key"

    let advertisement = LoomBridgeService.makeRelayAdvertisement(
        localDeviceID: deviceID,
        identityKeyID: identityKeyID,
        publishedWorkspaceId: "workspace-1",
        publishedWorkspaceName: "AIWorkspace"
    )

    #expect(advertisement.deviceID == deviceID)
    #expect(advertisement.identityKeyID == identityKeyID)
    #expect(advertisement.metadata[RelayProtocolConstants.roleMetadataKey] == RelayProtocolConstants.hostMetadataRole)
    #expect(advertisement.metadata[RelayProtocolConstants.protocolMetadataKey] == String(RelayProtocolConstants.protocolVersion))
    #expect(advertisement.metadata[RelayProtocolConstants.workspaceIdMetadataKey] == "workspace-1")
    #expect(advertisement.metadata[RelayProtocolConstants.workspaceNameMetadataKey] == "AIWorkspace")
}

@MainActor
@Test
func approvedPeerTrustProviderOnlyKeepsLatestApprovedPeer() async throws {
    let storageURL = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
        .appendingPathComponent("CoworkLoomBridge", isDirectory: true)
        .appendingPathComponent("approved-peer-id.txt")
    let originalContents = try? Data(contentsOf: storageURL)
    defer {
        if let originalContents {
            try? FileManager.default.createDirectory(at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? originalContents.write(to: storageURL)
        } else {
            try? FileManager.default.removeItem(at: storageURL)
        }
    }

    let provider = ApprovedPeerTrustProvider()
    provider.setApprovedPeerID(nil)

    let peerA = LoomPeerIdentity(
        deviceID: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
        name: "Phone A",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: nil,
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-a.local"
    )
    let peerB = LoomPeerIdentity(
        deviceID: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!,
        name: "Phone B",
        deviceType: .iPhone,
        iCloudUserID: nil,
        identityKeyID: nil,
        identityPublicKey: nil,
        isIdentityAuthenticated: true,
        endpoint: "peer-b.local"
    )

    try await provider.grantTrust(to: peerA)
    #expect(await provider.evaluateTrust(for: peerA) == .trusted)

    try await provider.grantTrust(to: peerB)

    #expect(await provider.evaluateTrust(for: peerA) == .requiresApproval)
    #expect(await provider.evaluateTrust(for: peerB) == .trusted)
}
