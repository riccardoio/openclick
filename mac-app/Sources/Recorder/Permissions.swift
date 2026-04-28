import ApplicationServices
import Foundation

public enum Permissions {
  public static func hasAccessibility() -> Bool {
    return AXIsProcessTrusted()
  }

  public static func promptIfMissing() {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
  }

  public static func ensureOrDie() {
    if hasAccessibility() { return }
    print("""
    openclick-recorder requires Accessibility permission to capture human input.

    1. macOS just opened System Settings → Privacy & Security → Accessibility.
    2. Click the + and add this binary at:
       \(CommandLine.arguments[0])
    3. Re-run openclick-recorder.
    """)
    promptIfMissing()
    exit(2)
  }
}
