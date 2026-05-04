import Foundation

struct MigrationIssue: Identifiable, Hashable {
  enum Kind: String {
    case oldApp
    case oldDaemon
    case staleTcc
  }

  let kind: Kind
  let title: String
  let detail: String

  var id: String { kind.rawValue }
}

enum MigrationDetector {
  static let oldBundleId = "com.trycua.driver"
  static let oldAppPath = "/Applications/CuaDriver.app"

  static func detect() -> [MigrationIssue] {
    var issues: [MigrationIssue] = []
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: oldAppPath) {
      issues.append(
        MigrationIssue(
          kind: .oldApp,
          title: "Remove old CuaDriver",
          detail: "Moves /Applications/CuaDriver.app to Trash."
        )
      )
    }
    if processExists(pattern: "cua-driver serve") {
      issues.append(
        MigrationIssue(
          kind: .oldDaemon,
          title: "Stop old daemon",
          detail: "Stops running cua-driver serve processes before setup continues."
        )
      )
    }
    if hasStaleTccEntries() {
      issues.append(
        MigrationIssue(
          kind: .staleTcc,
          title: "Clean old permission rows",
          detail: "Resets Accessibility and Screen Recording entries for com.trycua.driver."
        )
      )
    }
    return issues
  }

  static func cleanup() -> String {
    killOldDaemon()
    var messages: [String] = []
    if FileManager.default.fileExists(atPath: oldAppPath) {
      do {
        var trashed: NSURL?
        try FileManager.default.trashItem(
          at: URL(fileURLWithPath: oldAppPath),
          resultingItemURL: &trashed
        )
        messages.append("Moved CuaDriver.app to Trash.")
      } catch {
        messages.append("Could not move CuaDriver.app to Trash: \(error.localizedDescription)")
      }
    }
    resetTcc(service: "Accessibility")
    resetTcc(service: "ScreenCapture")
    messages.append("Reset old CuaDriver TCC entries.")
    return messages.joined(separator: " ")
  }

  static func killOldDaemon() {
    _ = run("/usr/bin/pkill", ["-f", "cua-driver serve"])
  }

  private static func processExists(pattern: String) -> Bool {
    run("/usr/bin/pgrep", ["-f", pattern]).status == 0
  }

  private static func hasStaleTccEntries() -> Bool {
    let db = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library")
      .appendingPathComponent("Application Support")
      .appendingPathComponent("com.apple.TCC")
      .appendingPathComponent("TCC.db")
    guard FileManager.default.isReadableFile(atPath: db.path) else { return false }
    let query = """
      select count(*) from access
      where client = '\(oldBundleId)'
      and service in ('kTCCServiceAccessibility', 'kTCCServiceScreenCapture');
      """
    let result = run("/usr/bin/sqlite3", [db.path, query])
    guard result.status == 0 else { return false }
    return Int(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0 > 0
  }

  private static func resetTcc(service: String) {
    _ = run("/usr/bin/tccutil", ["reset", service, oldBundleId])
  }

  private static func run(_ executable: String, _ arguments: [String]) -> (
    status: Int32,
    stdout: String
  ) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    } catch {
      return (1, "")
    }
  }
}
