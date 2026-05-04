import AppKit
import Carbon
import Darwin
import Foundation
import SwiftUI

// MARK: - Daemon dispatcher
//
// OpenclickHelper.app is a single bundle that does two jobs: it shows the
// permission setup window and the chat-bar / onboarding GUI, AND it serves the
// daemon protocol the openclick CLI talks to (serve, mcp, call, status, etc.).
// The daemon binary itself lives at Contents/Resources/openclick-daemon and is
// the upstream cua-driver Mach-O, signed under com.openclick.helper as part of
// bundle signing.
//
// When argv[1] is one of the known daemon commands we execv the embedded
// binary so the running process is the daemon. macOS TCC traces the
// responsible-process back to the .app bundle, so all permission grants for
// com.openclick.helper apply transparently.
//
// Anything else (no args, "permission-setup", flags) falls through to the
// AppKit path below.

private let daemonCommands: Set<String> = [
  "serve",
  "mcp",
  "call",
  "status",
  "check_permissions",
  "set_agent_cursor_enabled",
  "click",
  "type_text",
  "screenshot",
  "get_window_state",
  "list_apps",
  "list_windows",
  "diff_windows",
  "list_browser_tabs",
  "launch_app",
  "scroll",
  "press_key",
  "hotkey",
]

private func resolveEmbeddedDaemonPath() -> String? {
  if let override = ProcessInfo.processInfo.environment["OPENCLICK_DAEMON_BIN"],
     !override.isEmpty {
    return override
  }
  if let resourcePath = Bundle.main.resourcePath {
    return resourcePath + "/openclick-daemon"
  }
  return nil
}

private func dispatchToEmbeddedDaemonIfRequested() {
  let args = CommandLine.arguments
  guard args.count >= 2, daemonCommands.contains(args[1]) else { return }

  guard let daemonPath = resolveEmbeddedDaemonPath() else {
    fputs("OpenclickHelper: cannot resolve embedded daemon path (Bundle.main.resourcePath is nil)\n", stderr)
    exit(1)
  }

  guard FileManager.default.fileExists(atPath: daemonPath) else {
    fputs("OpenclickHelper: embedded daemon missing at \(daemonPath)\n", stderr)
    fputs("This OpenclickHelper.app is incomplete. Run `openclick setup` to reinstall.\n", stderr)
    exit(1)
  }

  // Forward argv[1...] to the daemon, with the daemon path itself as argv[0].
  var cStrings: [UnsafeMutablePointer<CChar>?] = []
  cStrings.append(strdup(daemonPath))
  for arg in args.dropFirst() {
    cStrings.append(strdup(arg))
  }
  cStrings.append(nil)

  _ = execv(daemonPath, &cStrings)
  // execv only returns on error.
  fputs("OpenclickHelper: execv failed for \(daemonPath): \(String(cString: strerror(errno)))\n", stderr)
  exit(1)
}

dispatchToEmbeddedDaemonIfRequested()

// MARK: - GUI mode

func argumentValue(after flag: String, in args: [String]) -> String? {
  guard let index = args.firstIndex(of: flag), index + 1 < args.count else {
    return nil
  }
  return args[index + 1]
}

@MainActor
final class OpenclickHelperAppDelegate: NSObject, NSApplicationDelegate {
  private var permissionSetupController: PermissionSetupController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // OpenclickHelper.app currently does exactly one thing in GUI mode:
    // show the permission-setup window. The chat-bar / onboarding / settings
    // / hot-key UI is shelved while we focus on the setup ritual. Daemon
    // commands (serve, mcp, click, etc.) never reach this delegate — they
    // are execv'd to the embedded daemon by the dispatcher in main.swift
    // before NSApplication is even created.
    //
    // .regular activation policy ensures the window foregrounds when
    // launched from a terminal-spawned process, after a Screen Recording
    // TCC relaunch, or from a double-click in Finder.
    NSApp.setActivationPolicy(.regular)
    let options = permissionSetupOptionsFromArguments() ?? PermissionSetupLaunchOptions(
      completionAction: .done,
      statusFile: nil,
      terminateOnCompletion: true
    )
    let setup = PermissionSetupController(options: options)
    permissionSetupController = setup
    setup.show()
  }

  private func permissionSetupOptionsFromArguments() -> PermissionSetupLaunchOptions? {
    let args = CommandLine.arguments
    guard args.contains("permission-setup") else { return nil }
    let rawAction = argumentValue(after: "--completion-action", in: args)
      ?? ProcessInfo.processInfo.environment["OPENCLICK_SETUP_COMPLETION_ACTION"]
      ?? PermissionCompletionAction.done.rawValue
    let action = PermissionCompletionAction(rawValue: rawAction) ?? .done
    let statusFile = argumentValue(after: "--status-file", in: args)
      ?? ProcessInfo.processInfo.environment["OPENCLICK_SETUP_STATUS_FILE"]
    return PermissionSetupLaunchOptions(
      completionAction: action,
      statusFile: statusFile,
      terminateOnCompletion: true
    )
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = OpenclickHelperAppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  app.run()
}

@MainActor
final class StatusController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let chatBar: ChatBarController
  private let onboarding: OnboardingController
  private let settings: SettingsController
  private let permissionSetup: PermissionSetupController

  init(
    chatBar: ChatBarController,
    onboarding: OnboardingController,
    settings: SettingsController,
    permissionSetup: PermissionSetupController
  ) {
    self.chatBar = chatBar
    self.onboarding = onboarding
    self.settings = settings
    self.permissionSetup = permissionSetup
    super.init()

    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "cursorarrow.click.2", accessibilityDescription: "openclick")
      button.image?.isTemplate = true
      button.title = " openclick"
      button.action = #selector(toggleChatBar)
      button.target = self
    }

    let menu = NSMenu()

    let openItem = NSMenuItem(title: "Open Chat Bar", action: #selector(openChatBar), keyEquivalent: " ")
    openItem.keyEquivalentModifierMask = [.option]
    openItem.target = self
    menu.addItem(openItem)

    menu.addItem(.separator())

    let settingsItem = NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
    settingsItem.keyEquivalentModifierMask = [.command]
    settingsItem.target = self
    menu.addItem(settingsItem)

    let permsItem = NSMenuItem(title: "Check Permissions…", action: #selector(showOnboarding), keyEquivalent: "")
    permsItem.target = self
    menu.addItem(permsItem)

    let onboardItem = NSMenuItem(title: "Show Onboarding…", action: #selector(showOnboarding), keyEquivalent: "")
    onboardItem.target = self
    menu.addItem(onboardItem)

    menu.addItem(.separator())

    let quitItem = NSMenuItem(title: "Quit openclick", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu
  }

  @objc private func toggleChatBar() {
    chatBar.toggle()
  }

  @objc private func openChatBar() {
    chatBar.show()
  }

  @objc private func showOnboarding() {
    permissionSetup.show()
  }

  @objc private func showSettings() {
    settings.show()
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }
}

@MainActor
final class ChatBarController: NSObject {
  private let window: ChatBarWindow
  private let activityLog = ActivityLogController()
  private let viewModel = CommandBarViewModel()
  private var runningProcess: Process?
  private var outputPipes: [Pipe] = []
  var openOnboarding: (() -> Void)? {
    didSet { activityLog.openOnboarding = openOnboarding }
  }

  override init() {
    let size = NSSize(width: 760, height: 132)
    window = ChatBarWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    super.init()

    configureWindow()
    configureContent()
    wireViewModel()
    activityLog.onStop = { [weak self] in self?.cancelCurrentRun() }
    window.onResignKey = { [weak self] in
      guard let self, !self.viewModel.isRunning else { return }
      self.window.orderOut(nil)
    }
  }

  func toggle() {
    if window.isVisible {
      window.orderOut(nil)
    } else {
      show()
    }
  }

  func show() {
    positionNearTopCenter()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  private func configureWindow() {
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .transient, .fullScreenAuxiliary]
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = false
    window.isMovableByWindowBackground = true
  }

  private func configureContent() {
    let host = NSHostingView(rootView: CommandBarView(viewModel: viewModel))
    host.translatesAutoresizingMaskIntoConstraints = false
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor
    host.layer?.cornerRadius = 44
    host.layer?.cornerCurve = .continuous
    let root = NSView()
    root.translatesAutoresizingMaskIntoConstraints = false
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.clear.cgColor
    root.layer?.cornerRadius = 44
    root.layer?.cornerCurve = .continuous
    root.addSubview(host)
    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      host.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      host.topAnchor.constraint(equalTo: root.topAnchor),
      host.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
    window.contentView = root
  }

  private func wireViewModel() {
    viewModel.onSubmit = { [weak self] prompt in self?.startOpenClick(prompt: prompt) }
    viewModel.onCancel = { [weak self] in self?.cancelCurrentRun() }
    viewModel.onOpenOnboarding = { [weak self] in self?.openOnboarding?() }
    viewModel.onToggleForeground = { [weak self] in
      guard let self else { return }
      self.viewModel.allowForeground.toggle()
      self.viewModel.status = self.viewModel.allowForeground
        ? "Foreground control allowed for next run"
        : "Shared-seat background mode"
    }
  }

  private func positionNearTopCenter() {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = window.frame
    let x = screen.midX - frame.width / 2
    let y = screen.maxY - frame.height - 54
    window.setFrameOrigin(NSPoint(x: x, y: y))
  }

  // MARK: - Process pipeline (logic unchanged, only callbacks moved to viewModel)

  private func startOpenClick(prompt: String) {
    viewModel.isRunning = true
    viewModel.status = viewModel.allowForeground
      ? "Running with foreground control…"
      : "Running in shared-seat mode…"
    viewModel.prompt = ""
    activityLog.start(prompt: prompt)

    let launch = openclickLaunch(prompt: prompt)
    let process = Process()
    process.executableURL = launch.executableURL
    process.arguments = launch.arguments
    process.environment = processEnvironment()
    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    stream(pipe: outputPipe)
    stream(pipe: errorPipe)
    outputPipes = [outputPipe, errorPipe]
    runningProcess = process

    process.terminationHandler = { [weak self] process in
      let terminationStatus = process.terminationStatus
      guard let controller = self else { return }
      Task { @MainActor [controller, terminationStatus] in
        controller.stopStreaming()
        controller.activityLog.finish(exitCode: Int(terminationStatus))
        controller.viewModel.isRunning = false
        controller.viewModel.status =
          terminationStatus == 0
          ? "Finished"
          : "openclick exited with status \(terminationStatus)"
        controller.runningProcess = nil
        controller.show()
      }
    }

    do {
      try process.run()
      window.orderOut(nil)
    } catch {
      stopStreaming()
      viewModel.isRunning = false
      let detail = "Could not launch openclick: \(error.localizedDescription)"
      viewModel.status = detail
      activityLog.append(detail)
      activityLog.finish(exitCode: 1)
      runningProcess = nil
      show()
    }
  }

  private func cancelCurrentRun() {
    guard let process = runningProcess else { return }
    activityLog.append("Cancellation requested.")
    viewModel.status = "Stopping openclick…"
    process.terminate()
  }

  private func stream(pipe: Pipe) {
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      let lines = String(decoding: data, as: UTF8.self)
        .components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      guard !lines.isEmpty, let controller = self else { return }
      Task { @MainActor [controller, lines] in
        for line in lines {
          controller.activityLog.append(line)
        }
      }
    }
  }

  private func stopStreaming() {
    for pipe in outputPipes {
      pipe.fileHandleForReading.readabilityHandler = nil
    }
    outputPipes = []
  }

  private func openclickLaunch(prompt: String) -> (executableURL: URL, arguments: [String]) {
    let runArgs = ["run", prompt, "--live"] + (viewModel.allowForeground ? ["--allow-foreground"] : [])
    if let explicit = ProcessInfo.processInfo.environment["OPENCLICK_BIN"], !explicit.isEmpty {
      return (URL(fileURLWithPath: explicit), runArgs)
    }
    if let repoRoot = ProcessInfo.processInfo.environment["OPENCLICK_REPO_ROOT"], !repoRoot.isEmpty {
      return (
        URL(fileURLWithPath: repoRoot).appendingPathComponent("bin/openclick"),
        runArgs
      )
    }
    if let bundled = Bundle.main.url(forResource: "openclick-cli/bin/openclick", withExtension: nil) {
      return (bundled, runArgs)
    }
    return (URL(fileURLWithPath: "/usr/bin/env"), ["openclick"] + runArgs)
  }

  private func processEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["OPENCLICK_APP_USE_ENV"] = "1"
    if let apiKey = OpenClickKeychain.apiKey(provider: .anthropic), !apiKey.isEmpty {
      env["ANTHROPIC_API_KEY"] = apiKey
    }
    if let apiKey = OpenClickKeychain.apiKey(provider: .openai), !apiKey.isEmpty {
      env["OPENAI_API_KEY"] = apiKey
    }
    if env["OPENCLICK_BIN"] == nil && env["OPENCLICK_REPO_ROOT"] == nil {
      env["OPENCLICK_TAKEOVER_WAIT_MS"] = env["OPENCLICK_TAKEOVER_WAIT_MS"] ?? "600000"
    }
    return env
  }
}

enum CliInstaller {
  static func installBundledCliIfAvailable() {
    guard let cliURL = bundledCliURL() else { return }
    let fileManager = FileManager.default
    let binDir = fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent(".local")
      .appendingPathComponent("bin")
    let destination = binDir.appendingPathComponent("openclick")

    do {
      try fileManager.createDirectory(at: binDir, withIntermediateDirectories: true)
      if fileManager.fileExists(atPath: destination.path) {
        try fileManager.removeItem(at: destination)
      }
      try fileManager.createSymbolicLink(at: destination, withDestinationURL: cliURL)
    } catch {
      try? fileManager.copyItem(at: cliURL, to: destination)
      try? fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
    }
  }

  private static func bundledCliURL() -> URL? {
    if let explicit = ProcessInfo.processInfo.environment["OPENCLICK_BIN"], !explicit.isEmpty {
      return URL(fileURLWithPath: explicit)
    }
    return Bundle.main.url(forResource: "openclick-cli/bin/openclick", withExtension: nil)
  }
}

final class ChatBarWindow: NSWindow {
  var onResignKey: (() -> Void)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard flags.contains(.command),
      !flags.contains(.control),
      !flags.contains(.option),
      let key = event.charactersIgnoringModifiers?.lowercased()
    else {
      return super.performKeyEquivalent(with: event)
    }

    let action: Selector?
    switch key {
    case "x" where !flags.contains(.shift):
      action = #selector(NSText.cut(_:))
    case "c" where !flags.contains(.shift):
      action = #selector(NSText.copy(_:))
    case "v" where !flags.contains(.shift):
      action = #selector(NSText.paste(_:))
    case "a" where !flags.contains(.shift):
      action = #selector(NSText.selectAll(_:))
    case "z":
      action = flags.contains(.shift) ? Selector(("redo:")) : Selector(("undo:"))
    default:
      action = nil
    }

    if let action, NSApp.sendAction(action, to: nil, from: self) {
      return true
    }
    return super.performKeyEquivalent(with: event)
  }

  override func resignKey() {
    super.resignKey()
    onResignKey?()
  }
}

@MainActor
final class ActivityLogController: NSObject {
  private let window: NSWindow
  private let viewModel = ActivityPanelViewModel()
  private var rawLines: [String] = []
  private var hasActionableError = false
  private var currentRunId: String?
  private var takeoverRecorder: Process?
  private var takeoverRecorderPipes: [Pipe] = []
  private var takeoverTrajectoryPath: String?
  private let maxLines = 80
  var openOnboarding: (() -> Void)?
  var onStop: (() -> Void)?

  override
  init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 640),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    super.init()
    configure()
  }

  func start(prompt: String) {
    rawLines = []
    hasActionableError = false
    currentRunId = nil
    stopTakeoverRecording()
    viewModel.start(task: prompt)
    positionTopRight()
    window.orderFrontRegardless()
  }

  func append(_ line: String) {
    rawLines.append(line)
    if rawLines.count > maxLines {
      rawLines.removeFirst(rawLines.count - maxLines)
    }
    viewModel.appendLog(line)

    if let runId = runId(from: line) {
      currentRunId = runId
    }

    if let result = taskResultEvent(from: line) {
      viewModel.markResult(
        kind: result.kind,
        title: result.title,
        body: result.body
      )
      return
    }

    if let intervention = interventionEvent(from: line) {
      viewModel.markIntervention(
        issue: InterventionIssue(
          title: intervention.issue,
          description: intervention.reason,
          stepTitle: intervention.step ?? "Current step",
          bundleId: intervention.before?.bundleId,
          appName: intervention.before?.appName,
          reasonType: intervention.reasonType
        ),
        reason: intervention.reason
      )
      return
    }

    if let event = friendlyEvent(from: line) {
      viewModel.applyEvent(phase: event.phase, detail: event.detail, timeline: event.timeline)
    }

    if let issue = detectActionableIssue(in: line), !hasActionableError {
      hasActionableError = true
      viewModel.markWarning(issue)
    }
  }

  func finish(exitCode: Int) {
    stopTakeoverRecording()
    viewModel.finish(exitCode: exitCode)
    if exitCode != 0 && !hasActionableError {
      viewModel.markWarning("Tip: Open Permissions to verify your setup.")
    }
  }

  private func configure() {
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .transient, .fullScreenAuxiliary]
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = false
    window.isMovableByWindowBackground = true

    viewModel.onHide = { [weak self] in self?.window.orderOut(nil) }
    viewModel.onStop = { [weak self] in self?.onStop?() }
    viewModel.onOpenPermissions = { [weak self] in self?.openOnboarding?() }
    viewModel.onTakeoverStarted = { [weak self] issue in
      self?.startTakeoverRecording(issue: issue)
    }
    viewModel.onTakeoverStopped = { [weak self] in
      self?.stopTakeoverRecording()
    }
    viewModel.onTakeoverFinished = { [weak self] issue, summary, success, trajectoryPath in
      self?.saveTakeoverLearning(
        issue: issue,
        summary: summary,
        success: success,
        trajectoryPath: trajectoryPath
      )
    }

    let host = NSHostingView(rootView: ActivityPanelView(viewModel: viewModel))
    host.translatesAutoresizingMaskIntoConstraints = false
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor
    let root = NSView()
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.clear.cgColor
    window.contentView = root
    root.addSubview(host)

    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      host.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      host.topAnchor.constraint(equalTo: root.topAnchor),
      host.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
  }

  private func detectActionableIssue(in line: String) -> String? {
    let lower = line.lowercased()
    if lower.contains("accessibility") && (lower.contains("denied") || lower.contains("not granted") || lower.contains("blocked") || lower.contains("permission")) {
      return "Accessibility looks blocked. Open Permissions to grant it to the recorder."
    }
    if (lower.contains("screen recording") || lower.contains("screen-recording") || lower.contains("screencapture")) && (lower.contains("denied") || lower.contains("not granted") || lower.contains("blocked") || lower.contains("permission")) {
      return "Screen Recording looks blocked. Open Permissions to grant it to OpenclickHelper."
    }
    if lower.contains("could not launch openclick") || lower.contains("executable not found") || lower.contains("no such file") {
      return "openclick could not launch. Open Permissions to check setup."
    }
    if lower.contains("anthropic_api_key") && (lower.contains("not set") || lower.contains("missing") || lower.contains("unset")) {
      return "ANTHROPIC_API_KEY isn’t set. Open Permissions for the export command."
    }
    if (lower.contains("openclickhelper") || lower.contains("cua-driver")) &&
      (lower.contains("not running") || lower.contains("not installed") || lower.contains("not found"))
    {
      return "OpenclickHelper isn’t ready. Open Permissions to install or start it."
    }
    if lower.contains("dry-run") || lower.contains("dry run") {
      return "This was a dry run. No actions were executed."
    }
    return nil
  }

  private func friendlyEvent(from line: String) -> (phase: String, detail: String, timeline: String)? {
    let lower = line.lowercased()
    if lower.contains("dry-run") || lower.contains("dry run") {
      return ("Planning", "Dry run only; no app actions were executed.", "Dry run completed without acting.")
    }
    if lower.contains("planner returned no actions") {
      return ("Issue", "The planner stopped without completing the task.", "Planner stopped before acting.")
    }
    if lower.contains("replanning") || lower.contains("planning next batch") {
      return ("Adjusting", "The last attempt was not enough, so openclick is changing strategy.", "Changing strategy from the latest result.")
    }
    if lower.contains("stopwhen not verified") {
      return ("Adjusting", "The result did not fully match the request yet.", "Result was not verified; preparing another step.")
    }
    if lower.contains("discovered initial state") {
      return ("Looking", "Reading the current app and window state.", "Discovered the current app state.")
    }
    if lower.contains("step") && lower.contains("failed after") {
      return ("Adjusting", "That approach did not work, so openclick is preparing a different path.", "Preparing another approach.")
    }
    if lower.contains("step") && lower.contains("failed") {
      return ("Adjusting", "That attempt did not work, so openclick is trying another way.", "Trying another approach.")
    }
    if lower.contains("aborted") {
      return ("Issue", "The task was stopped before it finished.", line.replacingOccurrences(of: "[openclick]", with: "").trimmingCharacters(in: .whitespaces))
    }
    if lower.contains("error") {
      return ("Adjusting", "Something changed, so openclick is reevaluating the next step.", "Reevaluating the next step.")
    }
    if lower.contains("mode: prompt planner") {
      return ("Planning", "Choosing the next step from the current screen.", "Planning the next step.")
    }
    if lower.contains("replan:") {
      return ("Adjusting", "A revised action is ready.", "Prepared a revised action.")
    }
    if lower.contains("plan:") {
      return ("Planning", "The next action is ready.", "Prepared the next action.")
    }
    if lower.contains("about to:") {
      let action = line.replacingOccurrences(of: "[openclick] about to:", with: "").trimmingCharacters(in: .whitespaces)
      let detail = action.isEmpty ? "Taking an action." : action
      return ("Acting", detail, detail)
    }
    if lower.contains("screenshot") || lower.contains("capture") {
      return ("Looking", "Reading the current screen.", "Checked the screen.")
    }
    if lower.contains("stopwhen verified") {
      return ("Checking", "The result matches the request.", "Verified the result.")
    }
    if lower.contains("verifier") || lower.contains("verify") {
      return ("Checking", "Comparing the result against the request.", "Checking whether the goal is met.")
    }
    if lower.contains("cost telemetry") {
      return nil
    }
    if lower.hasPrefix("[openclick] done") {
      return ("Complete", "The runner reported completion.", "Runner completed.")
    }
    return nil
  }

  private func interventionEvent(from line: String) -> InterventionEvent? {
    let marker = "[openclick] intervention_required "
    guard let range = line.range(of: marker) else { return nil }
    let json = String(line[range.upperBound...])
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(InterventionEvent.self, from: data)
  }

  private func taskResultEvent(from line: String) -> TaskResultEvent? {
    let marker = "[openclick] task_result "
    guard let range = line.range(of: marker) else { return nil }
    let json = String(line[range.upperBound...])
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(TaskResultEvent.self, from: data)
  }

  private func runId(from line: String) -> String? {
    let marker = "[openclick] run id:"
    guard let range = line.range(of: marker) else { return nil }
    let runId = line[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    return runId.isEmpty ? nil : runId
  }

  private func startTakeoverRecording(issue: InterventionIssue) {
    guard takeoverRecorder == nil, let currentRunId else { return }
    guard let recorder = recorderCommand() else {
      viewModel.appendLog("Takeover recording unavailable: recorder binary not found.")
      return
    }
    let outputPath = openclickHome()
      .appendingPathComponent("runs")
      .appendingPathComponent(currentRunId)
      .appendingPathComponent("takeover-trajectory")
      .path
    let process = Process()
    process.executableURL = recorder
    process.arguments = [
      "--output",
      outputPath,
      "--task",
      "takeover-\(currentRunId)",
      "--description",
      "\(issue.stepTitle): \(issue.description)",
    ]
    process.environment = ProcessInfo.processInfo.environment

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    streamTakeoverRecorder(pipe: outputPipe)
    streamTakeoverRecorder(pipe: errorPipe)

    do {
      try process.run()
      takeoverRecorder = process
      takeoverRecorderPipes = [outputPipe, errorPipe]
      takeoverTrajectoryPath = outputPath
      viewModel.appendLog("Takeover recording started.")
    } catch {
      viewModel.appendLog("Could not start takeover recording: \(error.localizedDescription)")
      takeoverTrajectoryPath = nil
    }
  }

  @discardableResult
  private func stopTakeoverRecording() -> String? {
    let path = takeoverTrajectoryPath
    guard let process = takeoverRecorder else { return path }
    for pipe in takeoverRecorderPipes {
      pipe.fileHandleForReading.readabilityHandler = nil
    }
    takeoverRecorderPipes = []
    process.interrupt()
    process.waitUntilExit()
    takeoverRecorder = nil
    if process.terminationStatus == 0 {
      viewModel.appendLog("Takeover recording saved.")
    } else {
      viewModel.appendLog("Takeover recording stopped with status \(process.terminationStatus).")
    }
    return path
  }

  private func streamTakeoverRecorder(pipe: Pipe) {
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      let lines = String(decoding: data, as: UTF8.self)
        .components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      guard !lines.isEmpty, let controller = self else { return }
      Task { @MainActor [controller, lines] in
        for line in lines {
          controller.viewModel.appendLog(line)
        }
      }
    }
  }

  private func saveTakeoverLearning(
    issue: InterventionIssue,
    summary: String,
    success: Bool,
    trajectoryPath: String?
  ) {
    let frontmost = NSWorkspace.shared.frontmostApplication
    let bundleId = issue.bundleId ?? frontmost?.bundleIdentifier
    let appName = issue.appName ?? frontmost?.localizedName ?? bundleId
    guard let bundleId else {
      viewModel.appendLog("Could not save takeover learning: no foreground app.")
      return
    }

    let launch = openclickCommand()
    let process = Process()
    process.executableURL = launch.url
    let sentResumeMarker = currentRunId != nil
    if let currentRunId {
      var args = launch.args + [
        "takeover",
        "finish",
        "--run-id",
        currentRunId,
        "--outcome",
        success ? "success" : "failed",
        "--bundle-id",
        bundleId,
        "--app-name",
        appName ?? bundleId,
        "--task",
        viewModel.task,
        "--issue",
        issue.description,
        "--summary",
        summary,
        "--feedback",
        success ? "completed" : "still_stuck",
      ]
      if let reasonType = issue.reasonType {
        args += ["--reason-type", reasonType]
      }
      if let trajectoryPath {
        args += ["--trajectory-path", trajectoryPath]
      }
      process.arguments = args
    } else {
      process.arguments = launch.args + [
        "memory",
        "learn-takeover",
        "--bundle-id",
        bundleId,
        "--app-name",
        appName ?? bundleId,
        "--task",
        viewModel.task,
        "--issue",
        issue.description,
        "--summary",
        summary,
      ]
    }
    var env = ProcessInfo.processInfo.environment
    env["OPENCLICK_APP_USE_ENV"] = "1"
    process.environment = env
    do {
      try process.run()
      process.waitUntilExit()
      if process.terminationStatus == 0 {
        viewModel.appendLog(
          sentResumeMarker
            ? "Sent takeover result to the paused runner."
            : "Saved takeover learning for \(appName ?? bundleId)."
        )
      } else {
        viewModel.appendLog("Could not save takeover learning: openclick exited with status \(process.terminationStatus).")
      }
    } catch {
      viewModel.appendLog("Could not save takeover learning: \(error.localizedDescription)")
    }
  }

  private func openclickCommand() -> (url: URL, args: [String]) {
    let env = ProcessInfo.processInfo.environment
    if let explicit = env["OPENCLICK_BIN"], !explicit.isEmpty {
      return (URL(fileURLWithPath: explicit), [])
    }
    if let repoRoot = env["OPENCLICK_REPO_ROOT"], !repoRoot.isEmpty {
      return (URL(fileURLWithPath: repoRoot).appendingPathComponent("bin/openclick"), [])
    }
    if let bundled = Bundle.main.url(forResource: "openclick-cli/bin/openclick", withExtension: nil) {
      return (bundled, [])
    }
    return (URL(fileURLWithPath: "/usr/bin/env"), ["openclick"])
  }

  private func recorderCommand() -> URL? {
    let env = ProcessInfo.processInfo.environment
    if let explicit = env["OPENCLICK_RECORDER_BIN"], !explicit.isEmpty {
      return URL(fileURLWithPath: explicit)
    }
    if let repoRoot = env["OPENCLICK_REPO_ROOT"], !repoRoot.isEmpty {
      let root = URL(fileURLWithPath: repoRoot)
      let debug = root
        .appendingPathComponent("mac-app/.build/arm64-apple-macosx/debug/openclick-recorder")
      if FileManager.default.fileExists(atPath: debug.path) {
        return debug
      }
      let release = root
        .appendingPathComponent("mac-app/.build/release/openclick-recorder")
      if FileManager.default.fileExists(atPath: release.path) {
        return release
      }
    }
    if let bundled = Bundle.main.url(forResource: "openclick-recorder", withExtension: nil) {
      return bundled
    }
    return nil
  }

  private func openclickHome() -> URL {
    let env = ProcessInfo.processInfo.environment
    if let explicit = env["OPENCLICK_HOME"], !explicit.isEmpty {
      return URL(fileURLWithPath: (explicit as NSString).expandingTildeInPath)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openclick")
  }

  private func positionTopRight() {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = window.frame
    let x = screen.maxX - frame.width - 24
    let y = screen.maxY - frame.height - 46
    window.setFrameOrigin(NSPoint(x: x, y: y))
  }
}

private struct InterventionEvent: Decodable {
  let runId: String?
  let issue: String
  let reason: String
  let reasonType: String?
  let step: String?
  let before: InterventionSnapshot?

  enum CodingKeys: String, CodingKey {
    case runId = "run_id"
    case issue
    case reason
    case reasonType = "reason_type"
    case step
    case before
  }
}

private struct InterventionSnapshot: Decodable {
  let appName: String?
  let bundleId: String?

  enum CodingKeys: String, CodingKey {
    case appName = "app_name"
    case bundleId = "bundle_id"
  }
}

private struct TaskResultEvent: Decodable {
  let kind: String
  let title: String
  let body: String
}

final class HotKeyController {
  private var hotKeyRef: EventHotKeyRef?
  private let action: () -> Void

  init(action: @escaping () -> Void) {
    self.action = action
  }

  func register() {
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
      guard let userData else { return noErr }
      Unmanaged<HotKeyController>.fromOpaque(userData).takeUnretainedValue().action()
      return noErr
    }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), nil)

    let signature = OSType(UInt32(ascii: "shwm"))
    let id = EventHotKeyID(signature: signature, id: 1)
    RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
  }
}

private extension UInt32 {
  init(ascii string: String) {
    self = string.utf8.reduce(0) { ($0 << 8) + UInt32($1) }
  }
}
