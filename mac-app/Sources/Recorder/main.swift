import AppKit
import Foundation
import RecorderCore

func usage() -> Never {
  print("""
  Usage: open42-recorder --output <dir> --task <name> --description <text>

  Captures CGEvents + AX snapshots + periodic screenshots into <dir>/events.jsonl
  and <dir>/session.json. Stop with Ctrl-C.
  """)
  exit(0)
}

let args = CommandLine.arguments
if args.contains("--version") { print("open42-recorder 0.0.1"); exit(0) }
if args.contains("--help") { usage() }
// Lightweight self-probe used by `open42 doctor` to ask the recorder binary
// whether Accessibility is granted to ITS cdhash. Exits 0 if granted, 1 if not.
if args.contains("--check-accessibility") {
  exit(Permissions.hasAccessibility() ? 0 : 1)
}

func arg(_ flag: String) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}

guard let outDir = arg("--output"),
      let taskName = arg("--task"),
      let taskDesc = arg("--description") else { usage() }

Permissions.ensureOrDie()

let outURL = URL(fileURLWithPath: (outDir as NSString).expandingTildeInPath)
let writer = try TrajectoryWriter(
  directory: outURL, taskName: taskName, taskDescription: taskDesc
)
let screenshotter = Screenshotter(writer: writer)

// All cua-driver shellouts and writer appends happen on this serial queue,
// NOT on the CGEventTap callback's run-loop thread. CGEventTap has a kernel
// timeout (~1s); doing 2-3 sync subprocess calls inside the callback would
// trip it and disable the tap. The tap handler enqueues work and returns.
let ingest = DispatchQueue(label: "open42.ingest")

let tap = EventTap { event in
  let pid: Int32
  switch event {
  case .click(let e): pid = e.pid
  case .key(let e): pid = e.pid
  case .scroll(let e): pid = e.pid
  }

  ingest.async {
    var axNode: AXNode? = nil
    let app = pid > 0 ? NSRunningApplication(processIdentifier: pid_t(pid)) : nil
    if pid > 0 {
      if let windows = try? CuaDriver.listWindows(pid: pid), let first = windows.first {
        screenshotter.setTarget(pid: pid, windowId: first.windowId)
        if let state = try? CuaDriver.getWindowState(pid: pid, windowId: first.windowId) {
          axNode = state.axTree
        }
      }
    }
    let screenshotRef = screenshotter.captureNow()
    do {
      try writer.appendEvent(
        event,
        axTree: axNode,
        screenshotRef: screenshotRef,
        bundleId: app?.bundleIdentifier,
        appName: app?.localizedName
      )
    } catch {
      FileHandle.standardError.write("append failed: \(error)\n".data(using: .utf8)!)
    }
  }
}

screenshotter.start()
try tap.start()

signal(SIGINT, SIG_IGN)
let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigSrc.setEventHandler {
  print("\nFinalizing trajectory...")
  tap.stop()
  screenshotter.stop()
  // Drain in-flight ingest work before finalizing so the last few events make
  // it into events.jsonl. ingest.sync waits for the queue to flush.
  ingest.sync {}
  do {
    try writer.finalize()
    print("Wrote: \(outURL.path)")
    exit(0)
  } catch {
    FileHandle.standardError.write("finalize failed: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
}
sigSrc.resume()

print("[open42-recorder] recording → \(outURL.path)")
print("[open42-recorder] perform your task. Ctrl-C when done.")
CFRunLoopRun()
