package expo.modules.remodexsecuretransport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemodexSecureTransportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RemodexSecureTransport")

    Events(
      "stateChanged",
      "plaintextMessage",
      "secureError",
      "socketClosed"
    )

    Function("getState") {
      mapOf(
        "status" to "idle",
        "transportMode" to "unsupported",
        "connectedMacDeviceId" to null,
        "relay" to null,
        "sessionId" to null,
        "lastError" to null,
        "trustedMacs" to emptyList<Map<String, Any?>>()
      )
    }

    AsyncFunction("listTrustedMacs") {
      emptyList<Map<String, Any?>>()
    }

    AsyncFunction("forgetTrustedMac") { _: String ->
      mapOf(
        "status" to "idle",
        "transportMode" to "unsupported",
        "connectedMacDeviceId" to null,
        "relay" to null,
        "sessionId" to null,
        "lastError" to null,
        "trustedMacs" to emptyList<Map<String, Any?>>()
      )
    }

    AsyncFunction("connectFromQr") { payload: Map<String, Any?> ->
      val macDeviceId = payload["macDeviceId"] as? String
      mapOf(
        "status" to "error",
        "transportMode" to "unsupported",
        "connectedMacDeviceId" to macDeviceId,
        "relay" to null,
        "sessionId" to null,
        "lastError" to "Native secure transport is not implemented yet.",
        "trustedMacs" to emptyList<Map<String, Any?>>()
      )
    }

    AsyncFunction("connectTrusted") { macDeviceId: String ->
      mapOf(
        "status" to "error",
        "transportMode" to "unsupported",
        "connectedMacDeviceId" to macDeviceId,
        "relay" to null,
        "sessionId" to null,
        "lastError" to "Native secure transport is not implemented yet.",
        "trustedMacs" to emptyList<Map<String, Any?>>()
      )
    }

    AsyncFunction("disconnect") {
      sendEvent(
        "socketClosed",
        mapOf(
          "code" to 1000,
          "reason" to "Disconnected"
        )
      )
      mapOf(
        "status" to "idle",
        "transportMode" to "unsupported",
        "connectedMacDeviceId" to null,
        "relay" to null,
        "sessionId" to null,
        "lastError" to null,
        "trustedMacs" to emptyList<Map<String, Any?>>()
      )
    }

    AsyncFunction("sendPlaintext") { text: String ->
      sendEvent(
        "plaintextMessage",
        mapOf("text" to text)
      )
      mapOf("ok" to true)
    }
  }
}
