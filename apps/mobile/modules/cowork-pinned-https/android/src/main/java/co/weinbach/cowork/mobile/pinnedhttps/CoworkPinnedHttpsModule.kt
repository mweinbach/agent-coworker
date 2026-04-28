package co.weinbach.cowork.mobile.pinnedhttps

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class PinnedHttpsRequest : Record {
  @Field
  var url: String = ""

  @Field
  var method: String = "GET"

  @Field
  var headers: Map<String, String>? = null

  @Field
  var body: String? = null

  @Field
  var certSha256: String = ""

  @Field
  var spkiSha256: String = ""

  @Field
  var streamId: String? = null
}

class CoworkPinnedHttpsModule : Module() {
  private val streamConnections = ConcurrentHashMap<String, HttpsURLConnection>()

  override fun definition() = ModuleDefinition {
    Name("CoworkPinnedHttps")

    Events("pinnedHttpsStreamEvent")

    AsyncFunction("fetchPinnedHttps") Coroutine { request: PinnedHttpsRequest ->
      fetchPinnedHttps(request)
    }

    AsyncFunction("openPinnedHttpsStream") Coroutine { request: PinnedHttpsRequest ->
      openPinnedHttpsStream(request)
    }

    AsyncFunction("closePinnedHttpsStream") Coroutine { streamId: String ->
      closePinnedHttpsStream(streamId)
    }
  }

  private fun fetchPinnedHttps(request: PinnedHttpsRequest): Map<String, Any?> {
    val trustManager = PinnedTrustManager(request.certSha256, request.spkiSha256)
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf(trustManager), SecureRandom())

    val connection = (URL(request.url).openConnection() as HttpsURLConnection).apply {
      sslSocketFactory = sslContext.socketFactory
      hostnameVerifier = HostnameVerifier { _, _ -> true }
      requestMethod = request.method
      connectTimeout = 15_000
      readTimeout = 0
      doInput = true
      request.headers?.forEach { (name, value) -> setRequestProperty(name, value) }
    }

    val requestBody = request.body
    if (requestBody != null) {
      connection.doOutput = true
      connection.outputStream.use { stream ->
        stream.write(requestBody.toByteArray(Charsets.UTF_8))
      }
    }

    val status = connection.responseCode
    val responseStream = if (status >= 400) connection.errorStream else connection.inputStream
    val responseBody = responseStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
    val responseHeaders = connection.headerFields
      .filterKeys { it != null }
      .mapKeys { it.key ?: "" }
      .mapValues { it.value.joinToString(",") }

    connection.disconnect()
    return mapOf(
      "status" to status,
      "headers" to responseHeaders,
      "body" to responseBody,
    )
  }

  private fun openPinnedHttpsStream(request: PinnedHttpsRequest) {
    val streamId = request.streamId ?: throw IllegalArgumentException("Missing stream id.")
    Thread {
      var connection: HttpsURLConnection? = null
      try {
        connection = openConnection(request).apply {
          readTimeout = 0
        }
        streamConnections[streamId] = connection

        val status = connection.responseCode
        if (status < 200 || status >= 300) {
          sendStreamEvent(streamId, "error", message = "Event stream failed with HTTP $status.")
          return@Thread
        }

        connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
          while (true) {
            val line = reader.readLine() ?: break
            sendStreamEvent(streamId, "data", data = "$line\n")
          }
        }
        sendStreamEvent(streamId, "close", message = "Event stream closed.")
      } catch (error: Exception) {
        sendStreamEvent(streamId, "error", message = error.message ?: error.toString())
      } finally {
        streamConnections.remove(streamId)
        connection?.disconnect()
      }
    }.apply {
      name = "CoworkPinnedHttps-$streamId"
      isDaemon = true
      start()
    }
  }

  private fun closePinnedHttpsStream(streamId: String) {
    streamConnections.remove(streamId)?.disconnect()
  }

  private fun sendStreamEvent(
    streamId: String,
    type: String,
    data: String? = null,
    message: String? = null,
  ) {
    sendEvent(
      "pinnedHttpsStreamEvent",
      mapOf(
        "streamId" to streamId,
        "type" to type,
        "data" to data,
        "message" to message,
      ),
    )
  }

  private fun openConnection(request: PinnedHttpsRequest): HttpsURLConnection {
    val trustManager = PinnedTrustManager(request.certSha256, request.spkiSha256)
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf(trustManager), SecureRandom())

    return (URL(request.url).openConnection() as HttpsURLConnection).apply {
      sslSocketFactory = sslContext.socketFactory
      hostnameVerifier = HostnameVerifier { _, _ -> true }
      requestMethod = request.method
      connectTimeout = 15_000
      readTimeout = 0
      doInput = true
      request.headers?.forEach { (name, value) -> setRequestProperty(name, value) }
    }
  }
}

private class PinnedTrustManager(
  certSha256: String,
  spkiSha256: String,
) : X509TrustManager {
  private val certSha256 = certSha256.lowercase()
  private val spkiSha256 = spkiSha256

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("Missing server certificate.")
    val certHash = sha256Hex(leaf.encoded)
    val keyHash = sha256Base64Url(leaf.publicKey.encoded)
    if (certHash != certSha256 && keyHash != spkiSha256) {
      throw CertificateException("Pinned HTTPS certificate mismatch.")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

private fun sha256Hex(bytes: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
  return digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
}

private fun sha256Base64Url(bytes: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
  return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
}
