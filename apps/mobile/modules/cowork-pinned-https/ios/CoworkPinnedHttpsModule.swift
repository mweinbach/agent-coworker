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
}

public final class CoworkPinnedHttpsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CoworkPinnedHttps")

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
  }
}

private final class PinnedHttpsSessionDelegate: NSObject, URLSessionDelegate {
  private let certSha256: String
  private let spkiSha256: String

  init(certSha256: String, spkiSha256: String) {
    self.certSha256 = certSha256.lowercased()
    self.spkiSha256 = spkiSha256.lowercased()
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
       let keyData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? {
      keyHash = sha256Hex(keyData)
    }

    if certHash == certSha256 || keyHash == spkiSha256 {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
