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
        "connectedMacDeviceId" to null,
        "lastError" to null,
        "trustedMacs" to emptyList<Map<String, Any?>>()
      )
    }

    AsyncFunction("listTrustedMacs") {
      emptyList<Map<String, Any?>>()
    }

    AsyncFunction("forgetTrustedMac") { _: String ->
      mapOf("ok" to true)
    }

    AsyncFunction("connectFromQr") { _: String ->
      sendEvent(
        "stateChanged",
        mapOf(
          "status" to "connected",
          "connectedMacDeviceId" to "stub-mac",
          "lastError" to null
        )
      )
      mapOf(
        "status" to "connected",
        "connectedMacDeviceId" to "stub-mac",
        "lastError" to null
      )
    }

    AsyncFunction("connectTrusted") { macDeviceId: String ->
      sendEvent(
        "stateChanged",
        mapOf(
          "status" to "connected",
          "connectedMacDeviceId" to macDeviceId,
          "lastError" to null
        )
      )
      mapOf(
        "status" to "connected",
        "connectedMacDeviceId" to macDeviceId,
        "lastError" to null
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
        "connectedMacDeviceId" to null,
        "lastError" to null
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
