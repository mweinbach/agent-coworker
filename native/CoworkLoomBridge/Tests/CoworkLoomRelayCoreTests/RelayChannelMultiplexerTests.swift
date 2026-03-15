import Foundation
import Testing

@testable import CoworkLoomRelayCore

@Test
func relayChannelMultiplexerPreservesOpenTextCloseOrdering() async throws {
    let multiplexer = RelayChannelMultiplexer()
    let channelId = "channel-1"
    let stream = await multiplexer.register(channelId: channelId)

    let collector = Task { () -> [RelayChannelEvent] in
        var events: [RelayChannelEvent] = []
        for await event in stream {
            events.append(event)
        }
        return events
    }

    await multiplexer.handle(.socketOpened(.init(channelId: channelId)))
    await multiplexer.handle(.socketText(.init(channelId: channelId, text: "hello")))
    await multiplexer.handle(.socketClosed(.init(channelId: channelId, code: 1000, reason: "done")))

    let events = await collector.value
    #expect(events == [
        .opened,
        .text("hello"),
        .closed(code: 1000, reason: "done"),
    ])
}
