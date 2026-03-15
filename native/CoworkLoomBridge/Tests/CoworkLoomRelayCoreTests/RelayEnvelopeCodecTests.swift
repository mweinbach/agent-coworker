import Testing

@testable import CoworkLoomRelayCore

@Test
func relayEnvelopeCodecRoundTrip() throws {
    let envelope = RelayEnvelope.openSocket(
        .init(
            channelId: "channel-1",
            workspaceId: "workspace-1",
            resumeSessionId: "session-1"
        )
    )

    let encoded = try RelayEnvelopeCodec.encode(envelope)
    let decoded = try RelayEnvelopeCodec.decode(encoded)

    #expect(decoded == envelope)
}
