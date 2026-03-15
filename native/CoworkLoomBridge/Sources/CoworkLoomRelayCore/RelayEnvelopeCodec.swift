import Foundation

public enum RelayEnvelopeCodec {
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    public static func encode(_ envelope: RelayEnvelope) throws -> Data {
        try encoder.encode(envelope)
    }

    public static func decode(_ data: Data) throws -> RelayEnvelope {
        try decoder.decode(RelayEnvelope.self, from: data)
    }
}
