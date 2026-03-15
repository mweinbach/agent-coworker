import Foundation

public enum RelayProtocolConstants {
    public static let protocolVersion = 1
    public static let serviceType = "_cowrelay._tcp"
    public static let streamLabel = "cowork-relay.v1"
    public static let hostMetadataRole = "desktop-relay"
    public static let clientMetadataRole = "ios-client"
    public static let protocolMetadataKey = "cowork.relay.protocol"
    public static let roleMetadataKey = "cowork.relay.role"
    public static let workspaceIdMetadataKey = "cowork.relay.workspace_id"
    public static let workspaceNameMetadataKey = "cowork.relay.workspace_name"
}

public enum RelayError: Error, LocalizedError, Sendable, Equatable {
    case notConnected
    case channelRejected(String)
    case channelClosed(code: Int?, reason: String?)
    case invalidState(String)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Relay session is not connected."
        case let .channelRejected(message):
            return message
        case let .channelClosed(code, reason):
            if let code, let reason {
                return "Relay channel closed (\(code)): \(reason)"
            }
            if let code {
                return "Relay channel closed (\(code))."
            }
            if let reason {
                return "Relay channel closed: \(reason)"
            }
            return "Relay channel closed."
        case let .invalidState(message):
            return message
        case let .transport(message):
            return message
        }
    }
}

public enum RelayChannelEvent: Sendable, Equatable {
    case opened
    case text(String)
    case closed(code: Int?, reason: String?)
    case error(message: String, retryable: Bool)
}
