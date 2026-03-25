import ExpoModulesCore

public class RemodexSecureTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RemodexSecureTransport")

    Events("stateChanged", "plaintextMessage", "secureError", "socketClosed")

    Function("getState") { () -> [String: Any?] in
      return [
        "status": "idle",
        "connectionMode": nil,
        "activeMacDeviceId": nil,
        "activeSessionId": nil,
        "trustedMacCount": 0,
        "lastError": nil
      ]
    }

    AsyncFunction("listTrustedMacs") { () -> [[String: Any?]] in
      return []
    }

    AsyncFunction("forgetTrustedMac") { (_ macDeviceId: String) in
      return
    }

    AsyncFunction("connectFromQr") { (_ payload: [String: Any]) -> [String: Any?] in
      return [
        "status": "unsupported",
        "connectionMode": "qr",
        "activeMacDeviceId": payload["macDeviceId"] as? String,
        "activeSessionId": payload["sessionId"] as? String,
        "trustedMacCount": 0,
        "lastError": "Native secure transport is not implemented yet."
      ]
    }

    AsyncFunction("connectTrusted") { (_ macDeviceId: String) -> [String: Any?] in
      return [
        "status": "unsupported",
        "connectionMode": "trusted",
        "activeMacDeviceId": macDeviceId,
        "activeSessionId": nil,
        "trustedMacCount": 0,
        "lastError": "Native secure transport is not implemented yet."
      ]
    }

    AsyncFunction("disconnect") { () in
      return
    }

    AsyncFunction("sendPlaintext") { (_ text: String) in
      throw Exception(name: "ERR_REMODEX_TRANSPORT_UNAVAILABLE", description: "Native secure transport is not implemented yet.")
    }
  }
}
