import Foundation

private final class FakeTask: URLSessionDataTask, @unchecked Sendable {
  var cancellationCount = 0

  override func cancel() {
    cancellationCount += 1
  }
}

private struct TestFailure: Error, CustomStringConvertible {
  let description: String
}

private func require(_ condition: Bool, _ message: String) throws {
  if !condition {
    throw TestFailure(description: message)
  }
}

@main
private enum NativeLifecycleTests {
  static func main() {
    do {
      switch CommandLine.arguments[1] {
      case "url-validation":
        for value in ["http://desktop.test/rpc", "file:///etc/hosts", "/rpc", "https:"] {
          try require(pinnedHttpsUrl(value) == nil, "Accepted unsafe endpoint: \(value)")
        }
        for value in ["https://127.0.0.1:9443/rpc", "HTTPS://desktop.local/events", "https://[::1]:9443"] {
          try require(pinnedHttpsUrl(value) != nil, "Rejected HTTPS endpoint: \(value)")
        }
      case "owner-release":
        let task = FakeTask()
        var registry: PinnedHttpsStreamRegistry? = PinnedHttpsStreamRegistry()
        registry?.insert(task, for: "stream")
        registry = nil
        try require(task.cancellationCount == 1, "Releasing the native owner left its stream running")
      case "invalidate":
        let registry = PinnedHttpsStreamRegistry()
        let activeTask = FakeTask()
        registry.insert(activeTask, for: "active")
        registry.invalidate()
        registry.invalidate()
        try require(activeTask.cancellationCount == 1, "Teardown must cancel a stream exactly once")
        let lateTask = FakeTask()
        registry.insert(lateTask, for: "late")
        try require(lateTask.cancellationCount == 1, "A stream survived registration after teardown")
        try require(registry.remove(for: "late") == nil, "Teardown retained a late stream")
      case "stale-completion":
        let registry = PinnedHttpsStreamRegistry()
        let oldTask = FakeTask()
        let replacementTask = FakeTask()
        registry.insert(oldTask, for: "stream")
        registry.insert(replacementTask, for: "stream")
        registry.complete(oldTask, for: "stream")
        registry.invalidate()
        try require(oldTask.cancellationCount == 1, "Replacing a stream did not cancel its old task")
        try require(replacementTask.cancellationCount == 1, "Stale completion removed the replacement")
      case "completed-stream":
        let registry = PinnedHttpsStreamRegistry()
        let task = FakeTask()
        registry.insert(task, for: "stream")
        registry.complete(task, for: "stream")
        registry.invalidate()
        try require(task.cancellationCount == 0, "Teardown retained and cancelled an already-complete stream")
      default:
        throw TestFailure(description: "Unknown test case")
      }
    } catch {
      print(error)
      exit(1)
    }
  }
}
