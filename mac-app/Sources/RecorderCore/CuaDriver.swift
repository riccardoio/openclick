import Foundation

public enum CuaDriverError: Error {
  case binaryNotFound
  case nonZeroExit(Int32, String)
  case parseError(String)
  case timedOut(TimeInterval)
}

public enum CuaDriver {
  /// Per-call cua-driver timeout. Long enough for a 4K screenshot; short enough
  /// that a hung daemon doesn't wedge the recorder for the session.
  public static let defaultTimeoutSeconds: TimeInterval = 30

  public static func parseWindowState(_ data: Data) throws -> WindowState {
    do {
      return try JSONDecoder().decode(WindowState.self, from: data)
    } catch {
      throw CuaDriverError.parseError("\(error)")
    }
  }

  public static func getWindowState(pid: Int32, windowId: Int) throws -> WindowState {
    let args = "{\"pid\":\(pid),\"window_id\":\(windowId),\"capture_mode\":\"ax\"}"
    let data = try run(["get_window_state", args])
    return try parseWindowState(data)
  }

  public static func screenshot(pid: Int32, windowId: Int, outPath: String) throws {
    let args = "{\"pid\":\(pid),\"window_id\":\(windowId)}"
    _ = try run(["screenshot", args, "--image-out", outPath])
  }

  public struct WindowInfo: Codable, Equatable {
    public let pid: Int32
    public let windowId: Int
    enum CodingKeys: String, CodingKey { case pid; case windowId = "window_id" }
  }

  public static func listWindows(pid: Int32) throws -> [WindowInfo] {
    let args = "{\"pid\":\(pid)}"
    let data = try run(["list_windows", args])
    struct Resp: Codable { let windows: [WindowInfo] }
    return try JSONDecoder().decode(Resp.self, from: data).windows
  }

  /// Spawns cua-driver with the given args. Drains stdout AND stderr concurrently
  /// before waitUntilExit so a child writing >64KB to stdout doesn't deadlock on
  /// a full pipe. Times out after `timeout` seconds.
  private static func run(_ args: [String], timeout: TimeInterval = defaultTimeoutSeconds) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: try resolveBinary())
    process.arguments = args
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    do { try process.run() } catch { throw CuaDriverError.binaryNotFound }

    let group = DispatchGroup()
    var outData = Data()
    var errData = Data()
    let drainQueue = DispatchQueue(label: "openclick.cua-driver.drain", attributes: .concurrent)
    drainQueue.async(group: group) {
      outData = stdout.fileHandleForReading.readDataToEndOfFile()
    }
    drainQueue.async(group: group) {
      errData = stderr.fileHandleForReading.readDataToEndOfFile()
    }
    if group.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      _ = group.wait(timeout: .now() + 1)
      throw CuaDriverError.timedOut(timeout)
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
      let err = String(data: errData, encoding: .utf8) ?? ""
      throw CuaDriverError.nonZeroExit(process.terminationStatus, err)
    }
    return outData
  }

  private static func resolveBinary() throws -> String {
    if let env = ProcessInfo.processInfo.environment["CUA_DRIVER"], FileManager.default.isExecutableFile(atPath: env) {
      return env
    }
    let candidates = [
      "/usr/local/bin/cua-driver",
      "/opt/homebrew/bin/cua-driver",
      "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    ]
    for path in candidates {
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    throw CuaDriverError.binaryNotFound
  }
}
