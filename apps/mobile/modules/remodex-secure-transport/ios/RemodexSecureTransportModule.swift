import ExpoModulesCore

public class RemodexSecureTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RemodexSecureTransport")

    Events("stateChanged", "plaintextMessage", "secureError", "socketClosed")

    Function("getState") { () -> [String: Any?] in
      return [
        "status": "idle",
        "transportMode": "unsupported",
        "connectedMacDeviceId": nil,
        "relay": nil,
        "sessionId": nil,
        "trustedMacs": [],
        "lastError": nil
      ]
    }

    AsyncFunction("listTrustedMacs") { () -> [[String: Any?]] in
      return []
    }

    AsyncFunction("forgetTrustedMac") { (_ macDeviceId: String) -> [String: Any?] in
      return [
        "status": "idle",
        "transportMode": "unsupported",
        "connectedMacDeviceId": nil,
        "relay": nil,
        "sessionId": nil,
        "trustedMacs": [],
        "lastError": nil
      ]
    }

    AsyncFunction("connectFromQr") { (_ payload: [String: Any]) -> [String: Any?] in
      return [
        "status": "error",
        "transportMode": "unsupported",
        "connectedMacDeviceId": payload["macDeviceId"] as? String,
        "relay": payload["relay"] as? String,
        "sessionId": payload["sessionId"] as? String,
        "trustedMacs": [],
        "lastError": "Native secure transport is not implemented yet."
      ]
    }

    AsyncFunction("connectTrusted") { (_ macDeviceId: String) -> [String: Any?] in
      return [
        "status": "error",
        "transportMode": "unsupported",
        "connectedMacDeviceId": macDeviceId,
        "relay": nil,
        "sessionId": nil,
        "trustedMacs": [],
        "lastError": "Native secure transport is not implemented yet."
      ]
    }

    AsyncFunction("disconnect") { () -> [String: Any?] in
      return [
        "status": "idle",
        "transportMode": "unsupported",
        "connectedMacDeviceId": nil,
        "relay": nil,
        "sessionId": nil,
        "trustedMacs": [],
        "lastError": nil
      ]
    }

    AsyncFunction("sendPlaintext") { (_ text: String) in
      throw Exception(name: "ERR_REMODEX_TRANSPORT_UNAVAILABLE", description: "Native secure transport is not implemented yet.")
    }
  }
}
