import Foundation
import RecorderCore

func usage() -> Never {
  print("""
  Usage: showme-recorder --output <dir> --task <name> --description <text>

  Captures CGEvents + AX snapshots + periodic screenshots into <dir>/events.jsonl
  and <dir>/session.json. Stop with Ctrl-C.
  """)
  exit(0)
}

let args = CommandLine.arguments
if args.contains("--version") { print("showme-recorder 0.0.1"); exit(0) }
if args.contains("--help") { usage() }

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

let tap = EventTap { event in
  let pid: Int32
  switch event {
  case .click(let e): pid = e.pid
  case .key(let e): pid = e.pid
  case .scroll(let e): pid = e.pid
  }

  var axNode: AXNode? = nil
  if pid > 0 {
    if let windows = try? CuaDriver.listWindows(pid: pid), let first = windows.first {
      screenshotter.setTarget(pid: pid, windowId: first.windowId)
      if let state = try? CuaDriver.getWindowState(pid: pid, windowId: first.windowId) {
        axNode = state.axTree
      }
    }
  }

  // Single source of truth for the screenshot name: captureNow() writes the file
  // AND returns the name. If it fails or there's no target, screenshotRef is nil
  // and the LLM can correlate frames by timestamp.
  let screenshotRef = screenshotter.captureNow()

  do {
    try writer.appendEvent(event, axTree: axNode, screenshotRef: screenshotRef)
  } catch {
    FileHandle.standardError.write("append failed: \(error)\n".data(using: .utf8)!)
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
  try? writer.finalize()
  print("Wrote: \(outURL.path)")
  exit(0)
}
sigSrc.resume()

print("[showme-recorder] recording → \(outURL.path)")
print("[showme-recorder] perform your task. Ctrl-C when done.")
CFRunLoopRun()
