import Foundation

public struct RelayHello: Codable, Sendable, Equatable {
    public let protocolVersion: Int
    public let appVersion: String
    public let peerName: String

    public init(protocolVersion: Int, appVersion: String, peerName: String) {
        self.protocolVersion = protocolVersion
        self.appVersion = appVersion
        self.peerName = peerName
    }
}

public struct RelayOpenSocket: Codable, Sendable, Equatable {
    public let channelId: String
    public let workspaceId: String
    public let resumeSessionId: String?

    public init(channelId: String, workspaceId: String, resumeSessionId: String?) {
        self.channelId = channelId
        self.workspaceId = workspaceId
        self.resumeSessionId = resumeSessionId
    }
}

public struct RelaySocketOpened: Codable, Sendable, Equatable {
    public let channelId: String

    public init(channelId: String) {
        self.channelId = channelId
    }
}

public struct RelaySocketText: Codable, Sendable, Equatable {
    public let channelId: String
    public let text: String

    public init(channelId: String, text: String) {
        self.channelId = channelId
        self.text = text
    }
}

public struct RelaySocketClosed: Codable, Sendable, Equatable {
    public let channelId: String
    public let code: Int?
    public let reason: String?

    public init(channelId: String, code: Int?, reason: String?) {
        self.channelId = channelId
        self.code = code
        self.reason = reason
    }
}

public struct RelaySocketError: Codable, Sendable, Equatable {
    public let channelId: String
    public let message: String
    public let retryable: Bool

    public init(channelId: String, message: String, retryable: Bool) {
        self.channelId = channelId
        self.message = message
        self.retryable = retryable
    }
}

public struct RelayPing: Codable, Sendable, Equatable {
    public let nonce: String

    public init(nonce: String) {
        self.nonce = nonce
    }
}

public struct RelayPong: Codable, Sendable, Equatable {
    public let nonce: String

    public init(nonce: String) {
        self.nonce = nonce
    }
}

public enum RelayEnvelope: Sendable, Equatable {
    case hello(RelayHello)
    case openSocket(RelayOpenSocket)
    case socketOpened(RelaySocketOpened)
    case socketText(RelaySocketText)
    case socketClosed(RelaySocketClosed)
    case socketError(RelaySocketError)
    case ping(RelayPing)
    case pong(RelayPong)
}

extension RelayEnvelope: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion
        case appVersion
        case peerName
        case channelId
        case workspaceId
        case resumeSessionId
        case text
        case code
        case reason
        case message
        case retryable
        case nonce
    }

    private enum Kind: String, Codable {
        case hello = "hello"
        case openSocket = "open_socket"
        case socketOpened = "socket_opened"
        case socketText = "socket_text"
        case socketClosed = "socket_closed"
        case socketError = "socket_error"
        case ping = "ping"
        case pong = "pong"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .type)
        switch kind {
        case .hello:
            self = .hello(
                .init(
                    protocolVersion: try container.decode(Int.self, forKey: .protocolVersion),
                    appVersion: try container.decode(String.self, forKey: .appVersion),
                    peerName: try container.decode(String.self, forKey: .peerName)
                )
            )
        case .openSocket:
            self = .openSocket(
                .init(
                    channelId: try container.decode(String.self, forKey: .channelId),
                    workspaceId: try container.decode(String.self, forKey: .workspaceId),
                    resumeSessionId: try container.decodeIfPresent(String.self, forKey: .resumeSessionId)
                )
            )
        case .socketOpened:
            self = .socketOpened(.init(channelId: try container.decode(String.self, forKey: .channelId)))
        case .socketText:
            self = .socketText(
                .init(
                    channelId: try container.decode(String.self, forKey: .channelId),
                    text: try container.decode(String.self, forKey: .text)
                )
            )
        case .socketClosed:
            self = .socketClosed(
                .init(
                    channelId: try container.decode(String.self, forKey: .channelId),
                    code: try container.decodeIfPresent(Int.self, forKey: .code),
                    reason: try container.decodeIfPresent(String.self, forKey: .reason)
                )
            )
        case .socketError:
            self = .socketError(
                .init(
                    channelId: try container.decode(String.self, forKey: .channelId),
                    message: try container.decode(String.self, forKey: .message),
                    retryable: try container.decode(Bool.self, forKey: .retryable)
                )
            )
        case .ping:
            self = .ping(.init(nonce: try container.decode(String.self, forKey: .nonce)))
        case .pong:
            self = .pong(.init(nonce: try container.decode(String.self, forKey: .nonce)))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(value):
            try container.encode(Kind.hello, forKey: .type)
            try container.encode(value.protocolVersion, forKey: .protocolVersion)
            try container.encode(value.appVersion, forKey: .appVersion)
            try container.encode(value.peerName, forKey: .peerName)
        case let .openSocket(value):
            try container.encode(Kind.openSocket, forKey: .type)
            try container.encode(value.channelId, forKey: .channelId)
            try container.encode(value.workspaceId, forKey: .workspaceId)
            try container.encodeIfPresent(value.resumeSessionId, forKey: .resumeSessionId)
        case let .socketOpened(value):
            try container.encode(Kind.socketOpened, forKey: .type)
            try container.encode(value.channelId, forKey: .channelId)
        case let .socketText(value):
            try container.encode(Kind.socketText, forKey: .type)
            try container.encode(value.channelId, forKey: .channelId)
            try container.encode(value.text, forKey: .text)
        case let .socketClosed(value):
            try container.encode(Kind.socketClosed, forKey: .type)
            try container.encode(value.channelId, forKey: .channelId)
            try container.encodeIfPresent(value.code, forKey: .code)
            try container.encodeIfPresent(value.reason, forKey: .reason)
        case let .socketError(value):
            try container.encode(Kind.socketError, forKey: .type)
            try container.encode(value.channelId, forKey: .channelId)
            try container.encode(value.message, forKey: .message)
            try container.encode(value.retryable, forKey: .retryable)
        case let .ping(value):
            try container.encode(Kind.ping, forKey: .type)
            try container.encode(value.nonce, forKey: .nonce)
        case let .pong(value):
            try container.encode(Kind.pong, forKey: .type)
            try container.encode(value.nonce, forKey: .nonce)
        }
    }
}
