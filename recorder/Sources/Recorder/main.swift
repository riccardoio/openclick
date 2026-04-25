import Foundation
import RecorderCore

let args = CommandLine.arguments
if args.contains("--version") {
  print("showme-recorder 0.0.1")
  exit(0)
}

if args.contains("--smoke-tap") {
  Permissions.ensureOrDie()
  let tap = EventTap { event in
    let data = try? JSONEncoder().encode(event)
    if let s = data.flatMap({ String(data: $0, encoding: .utf8) }) {
      FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
  }
  try tap.start()
  print("[smoke] tap running. Click around, press keys. Ctrl-C to exit.")
  CFRunLoopRun()
}

print("showme-recorder: stub. Use --version.")
