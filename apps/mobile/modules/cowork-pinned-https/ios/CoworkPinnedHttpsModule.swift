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
      self.streamTasks.removeValue(forKey: streamId)?.cancel()
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
        self?.streamTasks.removeValue(forKey: streamId)
      }
    )
    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: urlRequest)
    streamTasks[streamId] = task
    task.resume()
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
    var keyHash: String?
    if let publicKey = SecTrustCopyKey(trust),
       let keyData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
       let spkiData = ecP256SubjectPublicKeyInfo(fromRawKey: keyData) {
      keyHash = sha256Base64Url(spkiData)
    }

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
      onEvent([
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
    onEvent([
      "streamId": streamId,
      "type": "data",
      "data": String(data: data, encoding: .utf8) ?? "",
    ])
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    if let error {
      onEvent([
        "streamId": streamId,
        "type": "error",
        "message": error.localizedDescription,
      ])
    } else {
      onEvent([
        "streamId": streamId,
        "type": "close",
        "message": "Event stream closed.",
      ])
    }
    onComplete()
    session.finishTasksAndInvalidate()
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

private func ecP256SubjectPublicKeyInfo(fromRawKey rawKey: Data) -> Data? {
  guard rawKey.count == 65 else {
    return nil
  }
  let spkiHeader = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86,
    0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A,
    0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03,
    0x42, 0x00,
  ])
  return spkiHeader + rawKey
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
