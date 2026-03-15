import Foundation

import CoworkLoomRelayCore

public struct BridgePeerState: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let state: String

    public init(id: String, name: String, state: String) {
        self.id = id
        self.name = name
        self.state = state
    }
}

public struct BridgeDiscoveredPeerState: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let deviceId: String

    public init(id: String, name: String, deviceId: String) {
        self.id = id
        self.name = name
        self.deviceId = deviceId
    }
}

public struct BridgeState: Codable, Sendable, Equatable {
    public let supported: Bool
    public let advertising: Bool
    public let peer: BridgePeerState?
    public let localDeviceId: String
    public let localDeviceName: String
    public let discoveredPeers: [BridgeDiscoveredPeerState]
    public let publishedWorkspaceId: String?
    public let publishedWorkspaceName: String?
    public let openChannelCount: Int
    public let lastError: String?

    public init(
        supported: Bool,
        advertising: Bool,
        peer: BridgePeerState?,
        localDeviceId: String,
        localDeviceName: String,
        discoveredPeers: [BridgeDiscoveredPeerState],
        publishedWorkspaceId: String?,
        publishedWorkspaceName: String?,
        openChannelCount: Int,
        lastError: String?
    ) {
        self.supported = supported
        self.advertising = advertising
        self.peer = peer
        self.localDeviceId = localDeviceId
        self.localDeviceName = localDeviceName
        self.discoveredPeers = discoveredPeers
        self.publishedWorkspaceId = publishedWorkspaceId
        self.publishedWorkspaceName = publishedWorkspaceName
        self.openChannelCount = openChannelCount
        self.lastError = lastError
    }
}

public enum BridgeLogLevel: String, Codable, Sendable, Equatable {
    case info
    case warning
    case error
}

public enum BridgeCommand: Sendable, Equatable {
    case start(deviceName: String?)
    case stop
    case connectPeer(peerId: String)
    case disconnectPeer
    case publishWorkspace(workspaceId: String, workspaceName: String, serverUrl: String)
    case unpublishWorkspace(workspaceId: String)
    case getState
}

extension BridgeCommand: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case deviceName
        case peerId
        case workspaceId
        case workspaceName
        case serverUrl
    }

    private enum Kind: String, Codable {
        case start = "bridge_start"
        case stop = "bridge_stop"
        case connectPeer = "bridge_connect_peer"
        case disconnectPeer = "bridge_disconnect_peer"
        case publishWorkspace = "bridge_publish_workspace"
        case unpublishWorkspace = "bridge_unpublish_workspace"
        case getState = "bridge_get_state"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .type)
        switch kind {
        case .start:
            self = .start(deviceName: try container.decodeIfPresent(String.self, forKey: .deviceName))
        case .stop:
            self = .stop
        case .connectPeer:
            self = .connectPeer(peerId: try container.decode(String.self, forKey: .peerId))
        case .disconnectPeer:
            self = .disconnectPeer
        case .publishWorkspace:
            self = .publishWorkspace(
                workspaceId: try container.decode(String.self, forKey: .workspaceId),
                workspaceName: try container.decode(String.self, forKey: .workspaceName),
                serverUrl: try container.decode(String.self, forKey: .serverUrl)
            )
        case .unpublishWorkspace:
            self = .unpublishWorkspace(workspaceId: try container.decode(String.self, forKey: .workspaceId))
        case .getState:
            self = .getState
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .start(deviceName):
            try container.encode(Kind.start, forKey: .type)
            try container.encodeIfPresent(deviceName, forKey: .deviceName)
        case .stop:
            try container.encode(Kind.stop, forKey: .type)
        case let .connectPeer(peerId):
            try container.encode(Kind.connectPeer, forKey: .type)
            try container.encode(peerId, forKey: .peerId)
        case .disconnectPeer:
            try container.encode(Kind.disconnectPeer, forKey: .type)
        case let .publishWorkspace(workspaceId, workspaceName, serverUrl):
            try container.encode(Kind.publishWorkspace, forKey: .type)
            try container.encode(workspaceId, forKey: .workspaceId)
            try container.encode(workspaceName, forKey: .workspaceName)
            try container.encode(serverUrl, forKey: .serverUrl)
        case let .unpublishWorkspace(workspaceId):
            try container.encode(Kind.unpublishWorkspace, forKey: .type)
            try container.encode(workspaceId, forKey: .workspaceId)
        case .getState:
            try container.encode(Kind.getState, forKey: .type)
        }
    }
}

public enum BridgeEvent: Sendable, Equatable {
    case ready
    case state(BridgeState)
    case log(level: BridgeLogLevel, message: String)
    case fatal(message: String)
}

extension BridgeEvent: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case supported
        case advertising
        case peer
        case localDeviceId
        case localDeviceName
        case discoveredPeers
        case publishedWorkspaceId
        case publishedWorkspaceName
        case openChannelCount
        case lastError
        case level
        case message
    }

    private enum Kind: String, Codable {
        case ready = "bridge_ready"
        case state = "bridge_state"
        case log = "bridge_log"
        case fatal = "bridge_fatal"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .type)
        switch kind {
        case .ready:
            self = .ready
        case .state:
            self = .state(
                .init(
                    supported: try container.decode(Bool.self, forKey: .supported),
                    advertising: try container.decode(Bool.self, forKey: .advertising),
                    peer: try container.decodeIfPresent(BridgePeerState.self, forKey: .peer),
                    localDeviceId: try container.decode(String.self, forKey: .localDeviceId),
                    localDeviceName: try container.decode(String.self, forKey: .localDeviceName),
                    discoveredPeers: try container.decodeIfPresent([BridgeDiscoveredPeerState].self, forKey: .discoveredPeers) ?? [],
                    publishedWorkspaceId: try container.decodeIfPresent(String.self, forKey: .publishedWorkspaceId),
                    publishedWorkspaceName: try container.decodeIfPresent(String.self, forKey: .publishedWorkspaceName),
                    openChannelCount: try container.decode(Int.self, forKey: .openChannelCount),
                    lastError: try container.decodeIfPresent(String.self, forKey: .lastError)
                )
            )
        case .log:
            self = .log(
                level: try container.decode(BridgeLogLevel.self, forKey: .level),
                message: try container.decode(String.self, forKey: .message)
            )
        case .fatal:
            self = .fatal(message: try container.decode(String.self, forKey: .message))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ready:
            try container.encode(Kind.ready, forKey: .type)
        case let .state(state):
            try container.encode(Kind.state, forKey: .type)
            try container.encode(state.supported, forKey: .supported)
            try container.encode(state.advertising, forKey: .advertising)
            try container.encodeIfPresent(state.peer, forKey: .peer)
            try container.encode(state.localDeviceId, forKey: .localDeviceId)
            try container.encode(state.localDeviceName, forKey: .localDeviceName)
            try container.encode(state.discoveredPeers, forKey: .discoveredPeers)
            try container.encodeIfPresent(state.publishedWorkspaceId, forKey: .publishedWorkspaceId)
            try container.encodeIfPresent(state.publishedWorkspaceName, forKey: .publishedWorkspaceName)
            try container.encode(state.openChannelCount, forKey: .openChannelCount)
            try container.encodeIfPresent(state.lastError, forKey: .lastError)
        case let .log(level, message):
            try container.encode(Kind.log, forKey: .type)
            try container.encode(level, forKey: .level)
            try container.encode(message, forKey: .message)
        case let .fatal(message):
            try container.encode(Kind.fatal, forKey: .type)
            try container.encode(message, forKey: .message)
        }
    }
}
