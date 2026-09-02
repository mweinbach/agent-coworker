package co.weinbach.cowork.mobile.pinnedhttps

import java.net.URL
import javax.net.ssl.HttpsURLConnection

internal fun readPinnedHttpsResponse(connection: HttpsURLConnection, body: String?): Map<String, Any?> {
  try {
    if (body != null) {
      connection.doOutput = true
      connection.outputStream.use { stream ->
        stream.write(body.toByteArray(Charsets.UTF_8))
      }
    }

    val status = connection.responseCode
    val responseStream = if (status >= 400) connection.errorStream else connection.inputStream
    val responseBody = responseStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
    val responseHeaders = connection.headerFields
      .filterKeys { it != null }
      .mapKeys { it.key ?: "" }
      .mapValues { it.value.joinToString(",") }

    return mapOf(
      "status" to status,
      "headers" to responseHeaders,
      "body" to responseBody,
    )
  } finally {
    connection.disconnect()
  }
}

internal fun pinnedHttpsUrl(value: String): URL {
  val url = URL(value)
  require(url.protocol.equals("https", ignoreCase = true) && url.host.isNotEmpty()) {
    "Pinned HTTPS requires an HTTPS URL with a host."
  }
  return url
}

internal class PinnedHttpsStreamRegistry {
  private val streams = mutableMapOf<String, PinnedHttpsStream>()
  private var invalidated = false

  @Synchronized
  fun register(streamId: String): PinnedHttpsStream {
    check(!invalidated) { "Pinned HTTPS module has been destroyed." }
    require(!streams.containsKey(streamId)) { "Pinned HTTPS stream id is already in use." }
    return PinnedHttpsStream().also { streams[streamId] = it }
  }

  fun close(streamId: String) {
    val stream = synchronized(this) { streams.remove(streamId) }
    stream?.close()
  }

  fun complete(streamId: String, stream: PinnedHttpsStream) {
    synchronized(this) {
      if (streams[streamId] === stream) {
        streams.remove(streamId)
      }
    }
    stream.close()
  }

  fun invalidate() {
    val activeStreams = synchronized(this) {
      invalidated = true
      streams.values.toList().also { streams.clear() }
    }
    activeStreams.forEach { it.close() }
  }
}

internal class PinnedHttpsStream {
  private var connection: HttpsURLConnection? = null

  @Volatile
  var isClosed = false
    private set

  fun attach(connection: HttpsURLConnection): Boolean {
    val attached = synchronized(this) {
      if (isClosed) {
        false
      } else {
        this.connection = connection
        true
      }
    }
    if (!attached) connection.disconnect()
    return attached
  }

  fun close() {
    val connectionToClose = synchronized(this) {
      isClosed = true
      connection.also { connection = null }
    }
    connectionToClose?.disconnect()
  }
}
