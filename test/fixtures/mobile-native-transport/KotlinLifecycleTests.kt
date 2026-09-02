package co.weinbach.cowork.mobile.pinnedhttps

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URL
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection

private class FakeConnection(
  private val failureStage: String? = null,
  private val status: Int = 200,
) : HttpsURLConnection(URL("https://desktop.test/rpc")) {
  var disconnectCount = 0
  var responseCloseCount = 0
  val requestBody = ByteArrayOutputStream()

  override fun disconnect() {
    disconnectCount += 1
  }

  private fun failAt(stage: String) {
    if (failureStage == stage) throw IOException("$stage failed")
  }

  override fun getResponseCode(): Int {
    failAt("response")
    return status
  }

  override fun getOutputStream(): OutputStream = object : OutputStream() {
    override fun write(value: Int) {
      failAt("write")
      requestBody.write(value)
    }
  }

  private fun responseStream(): InputStream = object : ByteArrayInputStream("response".toByteArray()) {
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      failAt("read")
      return super.read(buffer, offset, length)
    }

    override fun close() {
      responseCloseCount += 1
      super.close()
    }
  }

  override fun getInputStream(): InputStream = responseStream()
  override fun getErrorStream(): InputStream = responseStream()

  override fun getHeaderFields(): MutableMap<String?, MutableList<String>> {
    failAt("headers")
    return mutableMapOf(null to mutableListOf("HTTP/1.1 $status"), "content-type" to mutableListOf("text/plain"))
  }

  override fun connect() = Unit
  override fun usingProxy() = false
  override fun getCipherSuite() = "test"
  override fun getLocalCertificates(): Array<Certificate>? = null
  override fun getServerCertificates(): Array<Certificate> = emptyArray()
}

fun main(args: Array<String>) {
  val testCase = args.single()
  if (testCase.startsWith("fetch-failure-")) {
    val connection = FakeConnection(failureStage = testCase.removePrefix("fetch-failure-"))
    try {
      readPinnedHttpsResponse(connection, "request")
      error("Expected a connection failure")
    } catch (_: IOException) {
      check(connection.disconnectCount == 1) { "Failed fetch did not disconnect its connection" }
    }
    return
  }

  when (testCase) {
    "fetch-response" -> {
      for (status in listOf(200, 401, 503)) {
        val connection = FakeConnection(status = status)
        val response = readPinnedHttpsResponse(connection, "request")
        check(response["status"] == status && response["body"] == "response")
        check(response["headers"] == mapOf("content-type" to "text/plain"))
        check(connection.requestBody.toString("UTF-8") == "request")
        check(connection.responseCloseCount == 1 && connection.disconnectCount == 1)
      }
    }
    "url-validation" -> {
      for (value in listOf("http://desktop.test/rpc", "file:///etc/hosts", "/rpc", "https:")) {
        check(runCatching { pinnedHttpsUrl(value) }.isFailure) { "Accepted unsafe endpoint: $value" }
      }
      for (value in listOf("https://127.0.0.1:9443/rpc", "HTTPS://desktop.local/events", "https://[::1]:9443")) {
        check(pinnedHttpsUrl(value).host.isNotEmpty()) { "Rejected HTTPS endpoint: $value" }
      }
    }
    "close-before-start" -> {
      val registry = PinnedHttpsStreamRegistry()
      val stream = registry.register("stream")
      registry.close("stream")
      val connection = FakeConnection()
      check(!stream.attach(connection)) { "Closed stream accepted a new connection" }
      check(connection.disconnectCount == 1)
      registry.complete("stream", stream)
      check(connection.disconnectCount == 1) { "Stream completed with duplicate disconnects" }
    }
    "close-after-completion" -> {
      val registry = PinnedHttpsStreamRegistry()
      val stream = registry.register("stream")
      val connection = FakeConnection()
      check(stream.attach(connection))
      registry.complete("stream", stream)
      registry.close("stream")
      registry.close("stream")
      check(connection.disconnectCount == 1)
      val nextStream = registry.register("stream")
      check(nextStream.attach(FakeConnection())) { "A stale cancellation marker closed a new stream" }
      registry.complete("stream", nextStream)
    }
    "invalidate" -> {
      val registry = PinnedHttpsStreamRegistry()
      val activeStream = registry.register("active")
      val activeConnection = FakeConnection()
      check(activeStream.attach(activeConnection))
      val pendingStream = registry.register("pending")
      registry.invalidate()
      registry.invalidate()
      check(activeConnection.disconnectCount == 1)
      val lateConnection = FakeConnection()
      check(!pendingStream.attach(lateConnection)) { "A starting stream survived module teardown" }
      check(lateConnection.disconnectCount == 1)
      check(runCatching { registry.register("late") }.isFailure) { "Destroyed registry accepted a stream" }
    }
    "stale-completion" -> {
      val registry = PinnedHttpsStreamRegistry()
      val oldStream = registry.register("stream")
      registry.close("stream")
      val replacement = registry.register("stream")
      val connection = FakeConnection()
      check(replacement.attach(connection))
      registry.complete("stream", oldStream)
      registry.invalidate()
      check(connection.disconnectCount == 1) { "Stale worker removed the replacement stream" }
    }
    else -> error("Unknown test case")
  }
}
