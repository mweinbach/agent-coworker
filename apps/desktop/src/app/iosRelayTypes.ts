export type IosRelayPeer = {
  id: string;
  name: string;
  state: "disconnected" | "connecting" | "connected";
};

export type IosRelayState = {
  supported: boolean;
  advertising: boolean;
  peer: IosRelayPeer | null;
  publishedWorkspaceId: string | null;
  openChannelCount: number;
  lastError: string | null;
};

export type IosRelayConfig = {
  rememberedPeerId: string | null;
  rememberedPeerName: string | null;
  deviceName: string | null;
};

export function createDefaultIosRelayState(supported = false): IosRelayState {
  return {
    supported,
    advertising: false,
    peer: null,
    publishedWorkspaceId: null,
    openChannelCount: 0,
    lastError: supported ? null : "iOS Relay is only available on macOS desktop builds.",
  };
}

export function createDefaultIosRelayConfig(): IosRelayConfig {
  return {
    rememberedPeerId: null,
    rememberedPeerName: null,
    deviceName: null,
  };
}
