import AppKit
import ApplicationServices
import Foundation
import SwiftUI

// MARK: - Liquid-glass helpers (still used by the floating chat bar window setup)

private func isDarkAppearance(_ appearance: NSAppearance) -> Bool {
  appearance.bestMatch(from: [
    .darkAqua, .vibrantDark, .accessibilityHighContrastDarkAqua,
  ]) != nil
}

func liquidGlassBorderColor() -> NSColor {
  NSColor(name: nil) { appearance in
    isDarkAppearance(appearance)
      ? NSColor.white.withAlphaComponent(0.32)
      : NSColor.black.withAlphaComponent(0.12)
  }
}

/// AppKit visual effect view with the liquid-glass treatment. Still used by
/// the ActivityLogController, which is intentionally kept in pure AppKit.
final class GlassEffectView: NSVisualEffectView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    setup()
  }
  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }
  private func setup() {
    wantsLayer = true
    blendingMode = .behindWindow
    state = .active
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
    layer?.borderWidth = 1.5
    layer?.borderColor = liquidGlassBorderColor().cgColor
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    layer?.borderColor = liquidGlassBorderColor().cgColor
  }
  override func updateLayer() {
    super.updateLayer()
    layer?.borderColor = liquidGlassBorderColor().cgColor
  }
}

/// Onboarding panel — Superhuman-style dark glass surface hosted in SwiftUI.
@MainActor
final class OnboardingController: NSObject {
  static let hasSeenOnboardingKey = "open42.hasSeenOnboarding"
  static let defaults: UserDefaults = UserDefaults(suiteName: "dev.open42.app") ?? .standard

  private let window: NSWindow
  private let viewModel = OnboardingViewModel()
  private var isChecking = false
  private var daemonAutoRetryCount = 0

  override init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 720, height: 820),
      styleMask: [.titled, .closable, .fullSizeContentView, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    super.init()
    configureWindow()
    wireViewModel()
  }

  func show() {
    if !window.isVisible {
      window.center()
    }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    refreshProviderKeyState()
    runChecks()
  }

  // MARK: - Window setup

  private func configureWindow() {
    window.title = "open42"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.isMovableByWindowBackground = true
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    window.delegate = self

    let host = NSHostingView(rootView: OnboardingView(viewModel: viewModel))
    host.translatesAutoresizingMaskIntoConstraints = false
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor

    let root = NSView()
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.clear.cgColor
    root.layer?.cornerRadius = 28
    root.layer?.cornerCurve = .continuous
    root.layer?.masksToBounds = true
    root.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(host)
    window.contentView = root

    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      host.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      host.topAnchor.constraint(equalTo: root.topAnchor),
      host.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
  }

  private func wireViewModel() {
    viewModel.onRunCheck = { [weak self] in self?.runChecks() }
    viewModel.onDone = { [weak self] in self?.handleDone() }
    viewModel.onAction = { [weak self] kind in self?.handleAction(kind: kind) }
    viewModel.onProviderChanged = { [weak self] provider in
      Open42SettingsStore.saveProvider(provider)
      self?.refreshProviderKeyState()
      self?.runChecks()
    }
    viewModel.onSaveApiKey = { [weak self] key in self?.saveApiKey(key) }
    viewModel.onClearApiKey = { [weak self] in self?.clearApiKey() }
  }

  private func handleDone() {
    Self.defaults.set(true, forKey: Self.hasSeenOnboardingKey)
    window.orderOut(nil)
  }

  // MARK: - Doctor

  private func runChecks() {
    if isChecking { return }
    refreshProviderKeyState()
    isChecking = true
    viewModel.isChecking = true
    viewModel.footerMessage = "Checking permissions and preparing helper…"
    viewModel.footerTone = .checking
    for kind in PermissionKind.allCases {
      viewModel.update(kind: kind, status: .checking)
    }

    let env = ProcessInfo.processInfo.environment
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let result = OnboardingController.spawnDoctorJSON(env: env)
      guard let controller = self else { return }
      Task { @MainActor [controller, result] in
        controller.isChecking = false
        controller.viewModel.isChecking = false
        controller.applyDoctorResult(result)
      }
    }
  }

  private func applyDoctorResult(_ result: DoctorRunResult) {
    switch result {
    case .ok(let report):
      let byName = Dictionary(uniqueKeysWithValues: report.results.map { ($0.name, $0) })
      applySimple(.accessibility, name: "Accessibility (via cua-driver)", in: byName, okMessage: "Granted to CuaDriver. App control will work.")
      applySimple(.screenRecording, name: "Screen Recording (via cua-driver)", in: byName, okMessage: "Granted to CuaDriver. Screenshots will work.")
      applyCuaDriver(installed: byName["cua-driver installed"], daemon: byName["cua-driver daemon"])
      let apiKeyName = viewModel.provider == .openai ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
      applySimple(
        .apiKey,
        name: apiKeyName,
        in: byName,
        okMessage: "\(viewModel.provider.title) API key is configured."
      )
      if report.allOk {
        viewModel.footerMessage = "All set. You can close this window."
        viewModel.footerTone = .success
      } else {
        let failing = report.results.filter { $0.status == "fail" }.count
        if viewModel.items.contains(where: { $0.kind == .cuaDriver && $0.status == .checking }) {
          viewModel.footerMessage = "Preparing the background helper…"
          viewModel.footerTone = .checking
        } else {
          viewModel.footerMessage = "\(failing) item\(failing == 1 ? "" : "s") still need attention."
          viewModel.footerTone = .warning
        }
      }
    case .launchFailure(let detail):
      for kind in PermissionKind.allCases {
        viewModel.update(kind: kind, status: .missing(reason: "Unknown"), description: "Could not run `open42 doctor`.")
      }
      viewModel.footerMessage = "Could not run `open42 doctor`. \(detail)"
      viewModel.footerTone = .warning
    case .parseFailure(let detail):
      for kind in PermissionKind.allCases {
        viewModel.update(kind: kind, status: .missing(reason: "Unknown"), description: "Could not parse doctor output.")
      }
      viewModel.footerMessage = "open42 doctor returned unexpected output. \(detail)"
      viewModel.footerTone = .warning
    }
  }

  private func applySimple(_ kind: PermissionKind, name: String, in byName: [String: DoctorResult], okMessage: String) {
    guard let result = byName[name] else {
      viewModel.update(kind: kind, status: .missing(reason: "Unknown"), description: kind.defaultDescription)
      return
    }
    if result.status == "ok" {
      viewModel.update(kind: kind, status: .ok, description: okMessage, actionTitle: kind.defaultActionTitle)
    } else {
      viewModel.update(kind: kind, status: .missing(reason: "Missing"), description: kind.defaultDescription, actionTitle: kind.defaultActionTitle)
    }
  }

  private func applyCuaDriver(installed: DoctorResult?, daemon: DoctorResult?) {
    if installed?.status != "ok" {
      daemonAutoRetryCount = 0
      viewModel.update(
        kind: .cuaDriver,
        status: .missing(reason: "Not installed"),
        description: "CuaDriver isn’t installed yet. Click Install to copy the command.",
        actionTitle: "Copy Install Command"
      )
      return
    }
    if daemon?.status != "ok" {
      viewModel.update(
        kind: .cuaDriver,
        status: .checking,
        description: "Preparing the background helper automatically.",
        actionTitle: ""
      )
      if daemonAutoRetryCount < 3 {
        daemonAutoRetryCount += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
          self?.runChecks()
        }
      }
      return
    }
    daemonAutoRetryCount = 0
    viewModel.update(
      kind: .cuaDriver,
      status: .ok,
      description: "CuaDriver is installed and running.",
      actionTitle: ""
    )
  }

  // MARK: - Actions

  private func handleAction(kind: PermissionKind) {
    switch kind {
    case .accessibility:
      NativePermissionPrompts.requestAccessibility()
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
        self?.runChecks()
      }
    case .screenRecording:
      NativePermissionPrompts.requestScreenRecording()
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
        self?.runChecks()
      }
    case .cuaDriver:
      // Action varies based on row state — read it back via item title.
      if let item = viewModel.items.first(where: { $0.kind == .cuaDriver }) {
        if item.actionTitle.lowercased().contains("install") {
          CuaDriverActions.copyInstall()
        } else if item.actionTitle.lowercased().contains("check") {
          runChecks()
        } else {
          runChecks()
        }
      } else {
        runChecks()
      }
    case .apiKey:
      ApiKeyActions.copyExportCommand()
    }
  }

  private func refreshProviderKeyState() {
    let provider = Open42SettingsStore.provider()
    if let key = Open42Keychain.apiKey(provider: provider), !key.isEmpty {
      viewModel.updateProviderKeyState(
        provider: provider,
        masked: Open42Keychain.mask(key),
        source: "Saved in Keychain",
        saved: true
      )
      return
    }
    if let envKey = ProcessInfo.processInfo.environment[provider.envKeyName], !envKey.isEmpty {
      viewModel.updateProviderKeyState(
        provider: provider,
        masked: Open42Keychain.mask(envKey),
        source: "Available from app environment",
        saved: false
      )
      return
    }
    if provider == .anthropic,
      let envKey = ProcessInfo.processInfo.environment["OPEN42_API_KEY"],
      !envKey.isEmpty
    {
      viewModel.updateProviderKeyState(
        provider: provider,
        masked: Open42Keychain.mask(envKey),
        source: "Available from app environment",
        saved: false
      )
      return
    }
    viewModel.updateProviderKeyState(
      provider: provider,
      masked: "Not set",
      source: "Not configured",
      saved: false
    )
  }

  private func saveApiKey(_ key: String) {
    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      viewModel.footerMessage = "Paste a \(viewModel.provider.title) API key before saving."
      viewModel.footerTone = .warning
      return
    }
    if Open42Keychain.saveApiKey(trimmed, provider: viewModel.provider) {
      viewModel.footerMessage = "\(viewModel.provider.title) API key saved."
      viewModel.footerTone = .success
      refreshProviderKeyState()
      runChecks()
    } else {
      viewModel.footerMessage = "Could not save the \(viewModel.provider.title) API key."
      viewModel.footerTone = .warning
    }
  }

  private func clearApiKey() {
    Open42Keychain.deleteApiKey(provider: viewModel.provider)
    viewModel.footerMessage = "Saved \(viewModel.provider.title) API key removed."
    viewModel.footerTone = .warning
    refreshProviderKeyState()
    runChecks()
  }

  // MARK: - Subprocess

  private enum DoctorRunResult: Sendable {
    case ok(DoctorReport)
    case launchFailure(String)
    case parseFailure(String)
  }

  nonisolated private static func spawnDoctorJSON(env: [String: String]) -> DoctorRunResult {
    let (url, args) = open42Invocation(env: env)
    let process = Process()
    process.executableURL = url
    process.arguments = args + ["doctor", "--fix", "--json"]

    var processEnv = env
    processEnv["OPEN42_APP_USE_ENV"] = "1"
    if let apiKey = Open42Keychain.apiKey(provider: .anthropic), !apiKey.isEmpty {
      processEnv["ANTHROPIC_API_KEY"] = apiKey
    }
    if let apiKey = Open42Keychain.apiKey(provider: .openai), !apiKey.isEmpty {
      processEnv["OPENAI_API_KEY"] = apiKey
    }
    process.environment = processEnv

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
    } catch {
      return .launchFailure(error.localizedDescription)
    }
    process.waitUntilExit()

    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
    if stdoutData.isEmpty {
      let err = String(decoding: stderrData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      return .launchFailure(err.isEmpty ? "no output (exit \(process.terminationStatus))" : err)
    }
    do {
      let report = try JSONDecoder().decode(DoctorReport.self, from: stdoutData)
      return .ok(report)
    } catch {
      return .parseFailure(error.localizedDescription)
    }
  }

  nonisolated private static func open42Invocation(env: [String: String]) -> (URL, [String]) {
    if let bin = env["OPEN42_BIN"], !bin.isEmpty {
      return (URL(fileURLWithPath: bin), [])
    }
    if let bin = env["SHOWME_BIN"], !bin.isEmpty {
      return (URL(fileURLWithPath: bin), [])
    }
    if let root = env["OPEN42_REPO_ROOT"], !root.isEmpty {
      return (URL(fileURLWithPath: root).appendingPathComponent("bin/open42"), [])
    }
    if let bundled = Bundle.main.url(forResource: "open42-cli/bin/open42", withExtension: nil) {
      return (bundled, [])
    }
    return (URL(fileURLWithPath: "/usr/bin/env"), ["open42"])
  }
}

extension OnboardingController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    Self.defaults.set(true, forKey: Self.hasSeenOnboardingKey)
  }
}

// MARK: - Doctor JSON shape

struct DoctorReport: Decodable, Sendable {
  let results: [DoctorResult]
  let allOk: Bool
}

struct DoctorResult: Decodable, Sendable {
  let name: String
  let status: String
  let detail: String
  let fixHint: String?
}

// MARK: - Action helpers

enum SettingsLink {
  static func open(_ url: String) {
    guard let resolved = URL(string: url) else {
      NSSound.beep()
      return
    }
    NSWorkspace.shared.open(resolved)
  }
}

enum NativePermissionPrompts {
  static func requestAccessibility() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
  }

  static func requestScreenRecording() {
    if !CGPreflightScreenCaptureAccess() {
      _ = CGRequestScreenCaptureAccess()
    }
    SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
  }
}

enum CuaDriverActions {
  static let installCommand =
    "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)\""

  static func copyInstall() {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(installCommand, forType: .string)
    notify(
      title: "Install command copied",
      message: "Paste it into Terminal to install CuaDriver, then run Check Again."
    )
  }

  static func startDaemon() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-n", "-g", "-a", "CuaDriver", "--args", "serve"]
    do {
      try process.run()
      notify(
        title: "Starting CuaDriver",
        message: "Give it a few seconds, then run Check Again."
      )
    } catch {
      notify(
        title: "Could not start CuaDriver",
        message: error.localizedDescription
      )
    }
  }
}

enum ApiKeyActions {
  static func copyExportCommand() {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString("export ANTHROPIC_API_KEY=sk-ant-...", forType: .string)
    notify(
      title: "export command copied",
      message: "Paste it into your shell rc, replace the placeholder with your key, restart your shell, then run Check Again."
    )
  }
}

private func notify(title: String, message: String) {
  let alert = NSAlert()
  alert.messageText = title
  alert.informativeText = message
  alert.alertStyle = .informational
  alert.addButton(withTitle: "OK")
  alert.runModal()
}
