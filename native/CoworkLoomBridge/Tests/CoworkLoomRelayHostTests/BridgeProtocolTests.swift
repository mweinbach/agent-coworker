import Foundation
import Testing

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
