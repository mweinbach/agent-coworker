import Foundation

internal func pinnedHttpsUrl(_ value: String) -> URL? {
  guard let url = URL(string: value),
        url.scheme?.lowercased() == "https",
        let host = url.host, !host.isEmpty else {
    return nil
  }
  return url
}

internal final class PinnedHttpsStreamRegistry {
  private var tasks: [String: URLSessionDataTask] = [:]
  private var invalidated = false
  private let queue = DispatchQueue(label: "co.weinbach.cowork.mobile.pinnedhttps.streamTasks")

  func insert(_ task: URLSessionDataTask, for streamId: String) {
    let taskToCancel: URLSessionDataTask? = queue.sync {
      if invalidated {
        return task
      }
      let previous = tasks.updateValue(task, forKey: streamId)
      return previous === task ? nil : previous
    }
    taskToCancel?.cancel()
  }

  func remove(for streamId: String) -> URLSessionDataTask? {
    queue.sync {
      tasks.removeValue(forKey: streamId)
    }
  }

  func complete(_ task: URLSessionTask, for streamId: String) {
    queue.sync {
      if tasks[streamId] === task {
        tasks.removeValue(forKey: streamId)
      }
    }
  }

  func invalidate() {
    let tasksToCancel = queue.sync {
      invalidated = true
      let activeTasks = Array(tasks.values)
      tasks.removeAll()
      return activeTasks
    }
    for task in tasksToCancel {
      task.cancel()
    }
  }

  deinit {
    invalidate()
  }
}
