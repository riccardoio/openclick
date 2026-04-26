import AppKit
import Foundation

/// First-run / "Check Permissions" panel. Walks the user through the four
/// prerequisites showme needs (Accessibility, Screen Recording, CuaDriver
/// daemon, ANTHROPIC_API_KEY) and runs `showme doctor --json` to report
/// current status. macOS permission grants are never promised to be automatic;
/// we just deep-link the right System Settings pane.
final class OnboardingController: NSObject {
  static let hasSeenOnboardingKey = "showme.hasSeenOnboarding"

  private let window: NSWindow
  private let titleLabel = NSTextField(labelWithString: "Welcome to showme")
  private let subtitleLabel = NSTextField(
    wrappingLabelWithString:
      "showme controls your Mac with natural-language prompts. Grant these four things once and you’re ready."
  )
  private let rowsStack = NSStackView()
  private let footerStatusLabel = NSTextField(labelWithString: "")
  private let runCheckButton = NSButton()
  private let doneButton = NSButton()
  private var rows: [PermissionRow] = []
  private var isChecking = false

  override init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 580, height: 560),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    super.init()
    configure()
  }

  func show() {
    if !window.isVisible {
      window.center()
    }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    runChecks()
  }

  // MARK: - Layout

  private func configure() {
    window.title = "showme · Permissions"
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.isMovableByWindowBackground = true
    window.delegate = self

    titleLabel.font = .systemFont(ofSize: 22, weight: .bold)
    titleLabel.textColor = .labelColor
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    subtitleLabel.font = .systemFont(ofSize: 13, weight: .regular)
    subtitleLabel.textColor = .secondaryLabelColor
    subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
    subtitleLabel.maximumNumberOfLines = 3
    subtitleLabel.preferredMaxLayoutWidth = 520

    rowsStack.orientation = .vertical
    rowsStack.alignment = .leading
    rowsStack.distribution = .fill
    rowsStack.spacing = 12
    rowsStack.translatesAutoresizingMaskIntoConstraints = false

    rows = [
      PermissionRow(kind: .accessibility),
      PermissionRow(kind: .screenRecording),
      PermissionRow(kind: .cuaDriver),
      PermissionRow(kind: .apiKey),
    ]
    for row in rows { rowsStack.addArrangedSubview(row) }

    footerStatusLabel.font = .systemFont(ofSize: 11, weight: .medium)
    footerStatusLabel.textColor = .secondaryLabelColor
    footerStatusLabel.translatesAutoresizingMaskIntoConstraints = false
    footerStatusLabel.lineBreakMode = .byTruncatingTail

    runCheckButton.title = "Run Check Again"
    runCheckButton.bezelStyle = .rounded
    runCheckButton.target = self
    runCheckButton.action = #selector(runCheckTapped)
    runCheckButton.translatesAutoresizingMaskIntoConstraints = false

    doneButton.title = "Done"
    doneButton.bezelStyle = .rounded
    doneButton.keyEquivalent = "\r"
    doneButton.target = self
    doneButton.action = #selector(doneTapped)
    doneButton.translatesAutoresizingMaskIntoConstraints = false

    let root = NSView()
    root.translatesAutoresizingMaskIntoConstraints = false
    [titleLabel, subtitleLabel, rowsStack, footerStatusLabel, runCheckButton, doneButton].forEach {
      root.addSubview($0)
    }
    window.contentView = root

    NSLayoutConstraint.activate([
      titleLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -28),
      titleLabel.topAnchor.constraint(equalTo: root.topAnchor, constant: 24),

      subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      subtitleLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
      subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6),

      rowsStack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
      rowsStack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      rowsStack.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 18),

      footerStatusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
      footerStatusLabel.trailingAnchor.constraint(lessThanOrEqualTo: runCheckButton.leadingAnchor, constant: -12),
      footerStatusLabel.centerYAnchor.constraint(equalTo: doneButton.centerYAnchor),

      runCheckButton.trailingAnchor.constraint(equalTo: doneButton.leadingAnchor, constant: -10),
      runCheckButton.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22),

      doneButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      doneButton.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22),
      doneButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 96),
    ])

    for row in rows {
      row.widthAnchor.constraint(equalTo: rowsStack.widthAnchor).isActive = true
    }
  }

  // MARK: - Actions

  @objc private func runCheckTapped() {
    runChecks()
  }

  @objc private func doneTapped() {
    UserDefaults.standard.set(true, forKey: Self.hasSeenOnboardingKey)
    window.orderOut(nil)
  }

  // MARK: - Doctor

  private func runChecks() {
    if isChecking { return }
    isChecking = true
    runCheckButton.isEnabled = false
    footerStatusLabel.stringValue = "Checking permissions…"
    rows.forEach { $0.beginChecking() }

    let env = ProcessInfo.processInfo.environment
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let result = OnboardingController.spawnDoctorJSON(env: env)
      DispatchQueue.main.async {
        self?.isChecking = false
        self?.runCheckButton.isEnabled = true
        self?.applyDoctorResult(result)
      }
    }
  }

  private func applyDoctorResult(_ result: DoctorRunResult) {
    switch result {
    case .ok(let report):
      let byName = Dictionary(uniqueKeysWithValues: report.results.map { ($0.name, $0) })
      rows[0].applySimple(result: byName["Accessibility (recorder)"])
      rows[1].applySimple(result: byName["Screen Recording (via cua-driver)"])
      rows[2].applyCuaDriver(
        installed: byName["cua-driver installed"],
        daemon: byName["cua-driver daemon"]
      )
      rows[3].applySimple(result: byName["ANTHROPIC_API_KEY"])
      if report.allOk {
        footerStatusLabel.stringValue = "All set. You can close this window."
        footerStatusLabel.textColor = .systemGreen
      } else {
        let failing = report.results.filter { $0.status == "fail" }.count
        footerStatusLabel.stringValue = "\(failing) item\(failing == 1 ? "" : "s") still need attention."
        footerStatusLabel.textColor = .secondaryLabelColor
      }
    case .launchFailure(let detail):
      footerStatusLabel.stringValue = "Could not run `showme doctor`. \(detail)"
      footerStatusLabel.textColor = .systemOrange
      rows.forEach { $0.markUnknown(detail: "Could not query showme.") }
    case .parseFailure(let detail):
      footerStatusLabel.stringValue = "showme doctor returned unexpected output. \(detail)"
      footerStatusLabel.textColor = .systemOrange
      rows.forEach { $0.markUnknown(detail: "Could not parse doctor output.") }
    }
  }

  // MARK: - Subprocess

  private enum DoctorRunResult {
    case ok(DoctorReport)
    case launchFailure(String)
    case parseFailure(String)
  }

  private static func spawnDoctorJSON(env: [String: String]) -> DoctorRunResult {
    let (url, args) = showmeInvocation(env: env)
    let process = Process()
    process.executableURL = url
    process.arguments = args + ["doctor", "--json"]

    var processEnv = env
    if processEnv["SHOWME_BIN"] == nil && processEnv["SHOWME_REPO_ROOT"] == nil {
      processEnv["SHOWME_BAR_USE_ENV"] = "1"
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

  private static func showmeInvocation(env: [String: String]) -> (URL, [String]) {
    if let bin = env["SHOWME_BIN"], !bin.isEmpty {
      return (URL(fileURLWithPath: bin), [])
    }
    if let root = env["SHOWME_REPO_ROOT"], !root.isEmpty {
      return (URL(fileURLWithPath: root).appendingPathComponent("bin/showme"), [])
    }
    return (URL(fileURLWithPath: "/usr/bin/env"), ["showme"])
  }
}

extension OnboardingController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    UserDefaults.standard.set(true, forKey: Self.hasSeenOnboardingKey)
  }
}

// MARK: - Doctor JSON shape

struct DoctorReport: Decodable {
  let results: [DoctorResult]
  let allOk: Bool
}

struct DoctorResult: Decodable {
  let name: String
  let status: String
  let detail: String
  let fixHint: String?
}

// MARK: - Permission Row

fileprivate enum RowTone {
  case neutral, checking, ok, fail
  var color: NSColor {
    switch self {
    case .neutral, .checking: return .secondaryLabelColor
    case .ok: return .systemGreen
    case .fail: return .systemOrange
    }
  }
}

final class PermissionRow: NSView {
  enum Kind {
    case accessibility
    case screenRecording
    case cuaDriver
    case apiKey
  }

  let kind: Kind

  private let iconView = NSImageView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let descLabel = NSTextField(wrappingLabelWithString: "")
  private let statusPill = StatusPill()
  private let actionButton = NSButton()
  private var actionHandler: (() -> Void)?

  init(kind: Kind) {
    self.kind = kind
    super.init(frame: .zero)
    configure()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

  override var intrinsicContentSize: NSSize {
    NSSize(width: NSView.noIntrinsicMetric, height: 76)
  }

  // MARK: Layout

  private func configure() {
    wantsLayer = true
    layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.55).cgColor
    layer?.cornerRadius = 14
    layer?.cornerCurve = .continuous
    layer?.borderWidth = 1
    layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.7).cgColor
    translatesAutoresizingMaskIntoConstraints = false

    let symbol = NSImage(systemSymbolName: kind.iconName, accessibilityDescription: kind.title)
    let config = NSImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
    iconView.image = symbol?.withSymbolConfiguration(config)
    iconView.contentTintColor = .controlAccentColor
    iconView.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.stringValue = kind.title
    titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
    titleLabel.textColor = .labelColor
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    descLabel.stringValue = kind.subtitle
    descLabel.font = .systemFont(ofSize: 11, weight: .regular)
    descLabel.textColor = .secondaryLabelColor
    descLabel.maximumNumberOfLines = 2
    descLabel.translatesAutoresizingMaskIntoConstraints = false
    descLabel.preferredMaxLayoutWidth = 360

    statusPill.translatesAutoresizingMaskIntoConstraints = false
    statusPill.set(text: "Checking…", tone: .checking)

    actionButton.bezelStyle = .rounded
    actionButton.title = kind.defaultActionLabel
    actionButton.target = self
    actionButton.action = #selector(performAction)
    actionButton.translatesAutoresizingMaskIntoConstraints = false
    actionHandler = { [weak self] in self?.kind.runDefaultAction() }

    addSubview(iconView)
    addSubview(titleLabel)
    addSubview(descLabel)
    addSubview(statusPill)
    addSubview(actionButton)

    NSLayoutConstraint.activate([
      iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      iconView.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      iconView.widthAnchor.constraint(equalToConstant: 28),
      iconView.heightAnchor.constraint(equalToConstant: 28),

      titleLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 12),
      titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 12),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: statusPill.leadingAnchor, constant: -10),

      descLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      descLabel.trailingAnchor.constraint(lessThanOrEqualTo: actionButton.leadingAnchor, constant: -10),
      descLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
      descLabel.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -12),

      statusPill.trailingAnchor.constraint(equalTo: actionButton.leadingAnchor, constant: -10),
      statusPill.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),

      actionButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      actionButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      actionButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 124),
    ])
  }

  // MARK: State

  func beginChecking() {
    statusPill.set(text: "Checking…", tone: .checking)
  }

  func markUnknown(detail: String) {
    statusPill.set(text: "Unknown", tone: .neutral)
    descLabel.stringValue = detail
  }

  /// Apply a single doctor result to this row.
  func applySimple(result: DoctorResult?) {
    guard let result else {
      markUnknown(detail: kind.subtitle)
      return
    }
    if result.status == "ok" {
      statusPill.set(text: "Granted", tone: .ok)
      descLabel.stringValue = friendlyOkMessage()
      actionButton.title = kind.okActionLabel
    } else {
      statusPill.set(text: "Missing", tone: .fail)
      descLabel.stringValue = kind.subtitle
      actionButton.title = kind.defaultActionLabel
    }
    actionHandler = { [weak self] in self?.kind.runDefaultAction() }
  }

  /// Apply combined cua-driver "installed" + "daemon" results.
  func applyCuaDriver(installed: DoctorResult?, daemon: DoctorResult?) {
    if installed?.status != "ok" {
      statusPill.set(text: "Not installed", tone: .fail)
      descLabel.stringValue = "CuaDriver isn’t installed yet. Click Install to copy the install command."
      actionButton.title = "Copy Install Command"
      actionHandler = { CuaDriverActions.copyInstall() }
      return
    }
    if daemon?.status != "ok" {
      statusPill.set(text: "Not running", tone: .fail)
      descLabel.stringValue = "CuaDriver is installed but the helper isn’t running. Start it now."
      actionButton.title = "Start Daemon"
      actionHandler = { CuaDriverActions.startDaemon() }
      return
    }
    statusPill.set(text: "Running", tone: .ok)
    descLabel.stringValue = "CuaDriver is installed and the helper is running."
    actionButton.title = "Restart Daemon"
    actionHandler = { CuaDriverActions.startDaemon() }
  }

  // MARK: Actions

  @objc private func performAction() {
    actionHandler?()
  }

  private func friendlyOkMessage() -> String {
    switch kind {
    case .accessibility: return "Granted to the showme recorder. You’re good."
    case .screenRecording: return "Granted to CuaDriver. Screenshots will work."
    case .cuaDriver: return "CuaDriver is ready."
    case .apiKey: return "ANTHROPIC_API_KEY is set in the launching shell."
    }
  }
}

// MARK: - Row Kind metadata + actions

extension PermissionRow.Kind {
  var title: String {
    switch self {
    case .accessibility: return "Accessibility"
    case .screenRecording: return "Screen Recording"
    case .cuaDriver: return "CuaDriver"
    case .apiKey: return "Anthropic API key"
    }
  }

  var subtitle: String {
    switch self {
    case .accessibility:
      return "Lets showme click and type in the apps you ask it to control."
    case .screenRecording:
      return "Lets showme see your screen so it can verify each step."
    case .cuaDriver:
      return "Background helper that performs the actual clicks and keystrokes."
    case .apiKey:
      return "showme calls Claude to plan the steps. Add the key to your shell."
    }
  }

  var iconName: String {
    switch self {
    case .accessibility: return "hand.tap.fill"
    case .screenRecording: return "rectangle.dashed.badge.record"
    case .cuaDriver: return "cpu"
    case .apiKey: return "key.fill"
    }
  }

  var defaultActionLabel: String {
    switch self {
    case .accessibility: return "Open Settings"
    case .screenRecording: return "Open Settings"
    case .cuaDriver: return "Start Daemon"
    case .apiKey: return "Copy export Command"
    }
  }

  var okActionLabel: String {
    switch self {
    case .accessibility, .screenRecording: return "Open Settings"
    case .cuaDriver: return "Restart Daemon"
    case .apiKey: return "Copy export Command"
    }
  }

  func runDefaultAction() {
    switch self {
    case .accessibility:
      SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    case .screenRecording:
      SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    case .cuaDriver:
      CuaDriverActions.startDaemon()
    case .apiKey:
      ApiKeyActions.copyExportCommand()
    }
  }
}

// MARK: - Status Pill

final class StatusPill: NSView {
  private let label = NSTextField(labelWithString: "")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    configure()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

  private func configure() {
    wantsLayer = true
    layer?.cornerRadius = 9
    layer?.cornerCurve = .continuous
    label.font = .systemFont(ofSize: 11, weight: .semibold)
    label.textColor = .white
    label.alignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: topAnchor, constant: 3),
      label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
    ])
  }

  fileprivate func set(text: String, tone: RowTone) {
    label.stringValue = text
    layer?.backgroundColor = tone.color.withAlphaComponent(0.92).cgColor
    invalidateIntrinsicContentSize()
  }
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
