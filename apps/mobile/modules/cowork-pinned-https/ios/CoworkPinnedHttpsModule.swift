import CryptoKit
import ExpoModulesCore
import Foundation
import Security

internal struct PinnedHttpsRequest: Record {
  @Field
  var url: String

  @Field
  var method: String = "GET"

  @Field
  var headers: [String: String]?

  @Field
  var body: String?

  @Field
  var certSha256: String

  @Field
  var spkiSha256: String

  @Field
  var streamId: String?
}

public final class CoworkPinnedHttpsModule: Module {
  private var streamTasks: [String: URLSessionDataTask] = [:]
  private let streamTasksQueue = DispatchQueue(
    label: "co.weinbach.cowork.mobile.pinnedhttps.streamTasks"
  )

  public func definition() -> ModuleDefinition {
    Name("CoworkPinnedHttps")

    Events("pinnedHttpsStreamEvent")

    AsyncFunction("fetchPinnedHttps") { (request: PinnedHttpsRequest) async throws -> [String: Any] in
      guard let url = URL(string: request.url) else {
        throw InvalidPinnedHttpsUrlException(request.url)
      }

      var urlRequest = URLRequest(url: url)
      urlRequest.httpMethod = request.method
      urlRequest.httpBody = request.body?.data(using: .utf8)
      for (name, value) in request.headers ?? [:] {
        urlRequest.setValue(value, forHTTPHeaderField: name)
      }

      let delegate = PinnedHttpsSessionDelegate(
        certSha256: request.certSha256,
        spkiSha256: request.spkiSha256
      )
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
      defer { session.finishTasksAndInvalidate() }

      let (data, response) = try await session.data(for: urlRequest)
      guard let httpResponse = response as? HTTPURLResponse else {
        throw InvalidPinnedHttpsResponseException()
      }

      return [
        "status": httpResponse.statusCode,
        "headers": httpResponse.allHeaderFields.reduce(into: [String: String]()) { result, item in
          if let name = item.key as? String {
            result[name] = String(describing: item.value)
          }
        },
        "body": String(data: data, encoding: .utf8) ?? "",
      ]
    }

    AsyncFunction("openPinnedHttpsStream") { (request: PinnedHttpsRequest) throws -> Void in
      try self.openPinnedHttpsStream(request)
    }

    AsyncFunction("closePinnedHttpsStream") { (streamId: String) -> Void in
      self.removeStreamTask(for: streamId)?.cancel()
    }
  }

  private func openPinnedHttpsStream(_ request: PinnedHttpsRequest) throws {
    guard let streamId = request.streamId else {
      throw MissingStreamIdException()
    }
    guard let url = URL(string: request.url) else {
      throw InvalidPinnedHttpsUrlException(request.url)
    }

    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = request.method
    urlRequest.httpBody = request.body?.data(using: .utf8)
    for (name, value) in request.headers ?? [:] {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }

    let delegate = PinnedHttpsStreamDelegate(
      streamId: streamId,
      certSha256: request.certSha256,
      spkiSha256: request.spkiSha256,
      onEvent: { [weak self] event in
        self?.sendEvent("pinnedHttpsStreamEvent", event)
      },
      onComplete: { [weak self] in
        self?.removeStreamTask(for: streamId)
      }
    )
    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: urlRequest)
    setStreamTask(task, for: streamId)
    task.resume()
  }

  private func setStreamTask(_ task: URLSessionDataTask, for streamId: String) {
    streamTasksQueue.sync {
      streamTasks[streamId] = task
    }
  }

  private func removeStreamTask(for streamId: String) -> URLSessionDataTask? {
    streamTasksQueue.sync {
      streamTasks.removeValue(forKey: streamId)
    }
  }
}

private class PinnedHttpsSessionDelegate: NSObject, URLSessionDelegate {
  private let certSha256: String
  private let spkiSha256: String

  init(certSha256: String, spkiSha256: String) {
    self.certSha256 = certSha256.lowercased()
    self.spkiSha256 = spkiSha256
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let certificate = SecTrustGetCertificateAtIndex(trust, 0)
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }

    let certData = SecCertificateCopyData(certificate) as Data
    let certHash = sha256Hex(certData)
    let keyHash = subjectPublicKeyInfo(fromCertificateDer: certData).map(sha256Base64Url)

    if certHash == certSha256 || keyHash == spkiSha256 {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
}

private final class PinnedHttpsStreamDelegate: PinnedHttpsSessionDelegate, URLSessionDataDelegate {
  private let streamId: String
  private let onEvent: ([String: Any?]) -> Void
  private let onComplete: () -> Void
  private var pendingUtf8 = Data()
  private var didSendTerminalEvent = false

  init(
    streamId: String,
    certSha256: String,
    spkiSha256: String,
    onEvent: @escaping ([String: Any?]) -> Void,
    onComplete: @escaping () -> Void
  ) {
    self.streamId = streamId
    self.onEvent = onEvent
    self.onComplete = onComplete
    super.init(certSha256: certSha256, spkiSha256: spkiSha256)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if let httpResponse = response as? HTTPURLResponse,
       !(200..<300).contains(httpResponse.statusCode) {
      sendTerminalEvent([
        "streamId": streamId,
        "type": "error",
        "message": "Event stream failed with HTTP \(httpResponse.statusCode).",
      ])
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    emitUtf8Data(data)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    if let error {
      sendTerminalEvent([
        "streamId": streamId,
        "type": "error",
        "message": error.localizedDescription,
      ])
    } else {
      flushUtf8Data()
      sendTerminalEvent([
        "streamId": streamId,
        "type": "close",
        "message": "Event stream closed.",
      ])
    }
    onComplete()
    session.finishTasksAndInvalidate()
  }

  private func emitUtf8Data(_ data: Data) {
    pendingUtf8.append(data)
    emitDecodableUtf8Prefix()
  }

  private func emitDecodableUtf8Prefix() {
    guard !pendingUtf8.isEmpty else {
      return
    }

    let maxCarryCount = min(3, pendingUtf8.count)
    for carryCount in 0...maxCarryCount {
      let prefixLength = pendingUtf8.count - carryCount
      if prefixLength == 0 {
        continue
      }
      let prefix = Data(pendingUtf8.prefix(prefixLength))
      if let text = String(data: prefix, encoding: .utf8) {
        sendDataEvent(text)
        pendingUtf8 = Data(pendingUtf8.suffix(carryCount))
        return
      }
    }

    guard pendingUtf8.count > 3 else {
      return
    }
    let prefixLength = pendingUtf8.count - 3
    sendDataEvent(String(decoding: pendingUtf8.prefix(prefixLength), as: UTF8.self))
    pendingUtf8 = Data(pendingUtf8.suffix(3))
  }

  private func flushUtf8Data() {
    guard !pendingUtf8.isEmpty else {
      return
    }
    if let text = String(data: pendingUtf8, encoding: .utf8) {
      sendDataEvent(text)
    } else {
      sendDataEvent(String(decoding: pendingUtf8, as: UTF8.self))
    }
    pendingUtf8.removeAll()
  }

  private func sendDataEvent(_ data: String) {
    guard !data.isEmpty else {
      return
    }
    onEvent([
      "streamId": streamId,
      "type": "data",
      "data": data,
    ])
  }

  private func sendTerminalEvent(_ event: [String: Any?]) {
    guard !didSendTerminalEvent else {
      return
    }
    didSendTerminalEvent = true
    onEvent(event)
  }
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func sha256Base64Url(_ data: Data) -> String {
  Data(SHA256.hash(data: data))
    .base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private struct DerElement {
  let tag: UInt8
  let contentRange: Range<Int>
  let fullRange: Range<Int>
}

private func readDerElement(in data: Data, offset: inout Int, limit: Int) -> DerElement? {
  guard offset < limit else {
    return nil
  }
  let start = offset
  let tag = data[offset]
  offset += 1

  guard offset < limit else {
    return nil
  }
  let firstLengthByte = data[offset]
  offset += 1

  let length: Int
  if firstLengthByte & 0x80 == 0 {
    length = Int(firstLengthByte)
  } else {
    let lengthByteCount = Int(firstLengthByte & 0x7f)
    guard
      lengthByteCount > 0,
      lengthByteCount <= MemoryLayout<Int>.size,
      offset + lengthByteCount <= limit
    else {
      return nil
    }

    var decodedLength = 0
    for _ in 0..<lengthByteCount {
      decodedLength = (decodedLength << 8) | Int(data[offset])
      offset += 1
    }
    length = decodedLength
  }

  let contentStart = offset
  guard length <= limit - contentStart else {
    return nil
  }
  let contentEnd = contentStart + length
  offset = contentEnd
  return DerElement(
    tag: tag,
    contentRange: contentStart..<contentEnd,
    fullRange: start..<contentEnd
  )
}

private func subjectPublicKeyInfo(fromCertificateDer certificateDer: Data) -> Data? {
  var certificateOffset = 0
  guard
    let certificate = readDerElement(
      in: certificateDer,
      offset: &certificateOffset,
      limit: certificateDer.count
    ),
    certificate.tag == 0x30
  else {
    return nil
  }

  var certificateContentOffset = certificate.contentRange.lowerBound
  guard
    let tbsCertificate = readDerElement(
      in: certificateDer,
      offset: &certificateContentOffset,
      limit: certificate.contentRange.upperBound
    ),
    tbsCertificate.tag == 0x30
  else {
    return nil
  }

  var tbsOffset = tbsCertificate.contentRange.lowerBound
  guard let firstTbsElement = readDerElement(
    in: certificateDer,
    offset: &tbsOffset,
    limit: tbsCertificate.contentRange.upperBound
  ) else {
    return nil
  }
  if firstTbsElement.tag != 0xA0 {
    tbsOffset = firstTbsElement.fullRange.lowerBound
  }

  for _ in 0..<5 {
    guard readDerElement(
      in: certificateDer,
      offset: &tbsOffset,
      limit: tbsCertificate.contentRange.upperBound
    ) != nil else {
      return nil
    }
  }

  guard
    let subjectPublicKeyInfo = readDerElement(
      in: certificateDer,
      offset: &tbsOffset,
      limit: tbsCertificate.contentRange.upperBound
    ),
    subjectPublicKeyInfo.tag == 0x30
  else {
    return nil
  }

  return certificateDer.subdata(in: subjectPublicKeyInfo.fullRange)
}

private final class InvalidPinnedHttpsUrlException: GenericException<String> {
  override var reason: String {
    "Invalid pinned HTTPS URL: \(param)"
  }
}

private final class InvalidPinnedHttpsResponseException: Exception {
  override var reason: String {
    "Pinned HTTPS request did not return an HTTP response."
  }
}

private final class MissingStreamIdException: Exception {
  override var reason: String {
    "Missing pinned HTTPS stream id."
  }
}
