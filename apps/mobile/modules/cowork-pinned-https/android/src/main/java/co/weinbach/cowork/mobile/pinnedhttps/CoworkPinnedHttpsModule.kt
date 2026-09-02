package co.weinbach.cowork.mobile.pinnedhttps

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
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
  private val streamRegistry = PinnedHttpsStreamRegistry()

  override fun definition() = ModuleDefinition {
    Name("CoworkPinnedHttps")

    Events("pinnedHttpsStreamEvent")

    OnDestroy {
      streamRegistry.invalidate()
    }

    AsyncFunction("fetchPinnedHttps") Coroutine { request: PinnedHttpsRequest ->
      fetchPinnedHttps(request)
    }

    AsyncFunction("openPinnedHttpsStream") Coroutine { request: PinnedHttpsRequest ->
      openPinnedHttpsStream(request)
    }

    AsyncFunction("closePinnedHttpsStream") Coroutine { streamId: String ->
      streamRegistry.close(streamId)
    }
  }

  private fun fetchPinnedHttps(request: PinnedHttpsRequest): Map<String, Any?> {
    return readPinnedHttpsResponse(openConnection(request, REQUEST_READ_TIMEOUT_MS), request.body)
  }

  private fun openPinnedHttpsStream(request: PinnedHttpsRequest) {
    val streamId = request.streamId ?: throw IllegalArgumentException("Missing stream id.")
    pinnedHttpsUrl(request.url)
    val stream = streamRegistry.register(streamId)
    try {
      Thread {
        try {
          val connection = openConnection(request)
          if (!stream.attach(connection) || stream.isClosed) {
            sendStreamEvent(streamId, "close", message = "Event stream closed.")
            return@Thread
          }

          val status = connection.responseCode
          if (stream.isClosed) {
            sendStreamEvent(streamId, "close", message = "Event stream closed.")
            return@Thread
          }
          if (status < 200 || status >= 300) {
            sendStreamEvent(streamId, "error", message = "Event stream failed with HTTP $status.")
            return@Thread
          }

          connection.inputStream.reader(Charsets.UTF_8).use { reader ->
            val buffer = CharArray(STREAM_BUFFER_SIZE)
            while (!stream.isClosed) {
              val charsRead = reader.read(buffer)
              if (charsRead == -1) {
                break
              }
              if (charsRead > 0 && !stream.isClosed) {
                sendStreamEvent(
                  streamId,
                  "data",
                  data = String(buffer, 0, charsRead),
                )
              }
            }
          }
          sendStreamEvent(streamId, "close", message = "Event stream closed.")
        } catch (error: Exception) {
          if (stream.isClosed) {
            sendStreamEvent(streamId, "close", message = "Event stream closed.")
          } else {
            sendStreamEvent(streamId, "error", message = error.message ?: error.toString())
          }
        } finally {
          streamRegistry.complete(streamId, stream)
        }
      }.apply {
        name = "CoworkPinnedHttps-$streamId"
        isDaemon = true
        start()
      }
    } catch (error: Exception) {
      streamRegistry.complete(streamId, stream)
      throw error
    }
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

  private fun openConnection(request: PinnedHttpsRequest, timeoutMs: Int = 0): HttpsURLConnection {
    val trustManager = PinnedTrustManager(request.certSha256, request.spkiSha256)
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf(trustManager), SecureRandom())

    return (pinnedHttpsUrl(request.url).openConnection() as HttpsURLConnection).apply {
      sslSocketFactory = sslContext.socketFactory
      hostnameVerifier = HostnameVerifier { _, _ -> true }
      requestMethod = request.method
      connectTimeout = 15_000
      readTimeout = timeoutMs
      // Paired endpoints never redirect; do not forward their authenticated requests.
      instanceFollowRedirects = false
      doInput = true
      request.headers?.forEach { (name, value) -> setRequestProperty(name, value) }
    }
  }
}

private const val REQUEST_READ_TIMEOUT_MS = 30_000
private const val STREAM_BUFFER_SIZE = 8 * 1024

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
