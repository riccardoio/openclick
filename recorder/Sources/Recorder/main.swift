import Foundation

let args = CommandLine.arguments
if args.contains("--version") {
  print("showme-recorder 0.0.1")
  exit(0)
}
print("showme-recorder: stub. Use --version.")
