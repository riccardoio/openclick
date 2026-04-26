import AppKit
import Carbon
import Foundation
import SwiftUI

@MainActor
final class ShowmeBarApp: NSObject, NSApplicationDelegate {
  private var statusController: StatusController?
  private var hotKeyController: HotKeyController?
  private var onboardingController: OnboardingController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    let chatBar = ChatBarController()
    let onboarding = OnboardingController()
    chatBar.openOnboarding = { [weak onboarding] in onboarding?.show() }
    onboardingController = onboarding
    statusController = StatusController(chatBar: chatBar, onboarding: onboarding)
    hotKeyController = HotKeyController { chatBar.toggle() }
    hotKeyController?.register()

    let hasSeen = OnboardingController.defaults.bool(forKey: OnboardingController.hasSeenOnboardingKey)
    if hasSeen {
      chatBar.show()
    } else {
      onboarding.show()
      chatBar.show()
    }
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = ShowmeBarApp()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  app.run()
}

@MainActor
final class StatusController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let chatBar: ChatBarController
  private let onboarding: OnboardingController

  init(chatBar: ChatBarController, onboarding: OnboardingController) {
    self.chatBar = chatBar
    self.onboarding = onboarding
    super.init()

    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "cursorarrow.click.2", accessibilityDescription: "showme")
      button.image?.isTemplate = true
      button.title = " showme"
      button.action = #selector(toggleChatBar)
      button.target = self
    }

    let menu = NSMenu()

    let openItem = NSMenuItem(title: "Open Chat Bar", action: #selector(openChatBar), keyEquivalent: " ")
    openItem.keyEquivalentModifierMask = [.option]
    openItem.target = self
    menu.addItem(openItem)

    menu.addItem(.separator())

    let permsItem = NSMenuItem(title: "Check Permissions…", action: #selector(showOnboarding), keyEquivalent: "")
    permsItem.target = self
    menu.addItem(permsItem)

    let onboardItem = NSMenuItem(title: "Show Onboarding…", action: #selector(showOnboarding), keyEquivalent: "")
    onboardItem.target = self
    menu.addItem(onboardItem)

    menu.addItem(.separator())

    let quitItem = NSMenuItem(title: "Quit showme", action: #selector(quit), keyEquivalent: "q")
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
    onboarding.show()
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
    window.hasShadow = true
    window.isMovableByWindowBackground = true
  }

  private func configureContent() {
    let host = NSHostingView(rootView: CommandBarView(viewModel: viewModel))
    host.translatesAutoresizingMaskIntoConstraints = false
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor
    let root = NSView()
    root.translatesAutoresizingMaskIntoConstraints = false
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.clear.cgColor
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
    viewModel.onSubmit = { [weak self] prompt in self?.startShowme(prompt: prompt) }
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

  private func startShowme(prompt: String) {
    viewModel.isRunning = true
    viewModel.status = viewModel.allowForeground
      ? "Running with foreground control…"
      : "Running in shared-seat mode…"
    viewModel.prompt = ""
    activityLog.start(prompt: prompt)

    let launch = showmeLaunch(prompt: prompt)
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
      DispatchQueue.main.async {
        self?.stopStreaming()
        self?.activityLog.finish(exitCode: Int(process.terminationStatus))
        self?.viewModel.isRunning = false
        self?.viewModel.status =
          process.terminationStatus == 0
          ? "Finished"
          : "showme exited with status \(process.terminationStatus)"
        self?.runningProcess = nil
        self?.show()
      }
    }

    do {
      try process.run()
      window.orderOut(nil)
    } catch {
      stopStreaming()
      viewModel.isRunning = false
      let detail = "Could not launch showme: \(error.localizedDescription)"
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
    viewModel.status = "Stopping showme…"
    process.terminate()
  }

  private func stream(pipe: Pipe) {
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      let text = String(decoding: data, as: UTF8.self)
      DispatchQueue.main.async {
        for rawLine in text.components(separatedBy: .newlines) {
          let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !line.isEmpty else { continue }
          self?.activityLog.append(line)
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

  private func showmeLaunch(prompt: String) -> (executableURL: URL, arguments: [String]) {
    let runArgs = ["run", prompt, "--live"] + (viewModel.allowForeground ? ["--allow-foreground"] : [])
    if let explicit = ProcessInfo.processInfo.environment["SHOWME_BIN"], !explicit.isEmpty {
      return (URL(fileURLWithPath: explicit), runArgs)
    }
    if let repoRoot = ProcessInfo.processInfo.environment["SHOWME_REPO_ROOT"], !repoRoot.isEmpty {
      return (
        URL(fileURLWithPath: repoRoot).appendingPathComponent("bin/showme"),
        runArgs
      )
    }
    return (URL(fileURLWithPath: "/usr/bin/env"), ["showme"] + runArgs)
  }

  private func processEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    if env["SHOWME_BIN"] == nil && env["SHOWME_REPO_ROOT"] == nil {
      env["SHOWME_BAR_USE_ENV"] = "1"
    }
    return env
  }
}

final class ChatBarWindow: NSWindow {
  var onResignKey: (() -> Void)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }

  override func resignKey() {
    super.resignKey()
    onResignKey?()
  }
}

final class ActivityLogController: NSObject {
  private let window: NSWindow
  private let spinner = NSProgressIndicator()
  private let titleLabel = NSTextField(labelWithString: "showme is working")
  private let phaseLabel = NSTextField(labelWithString: "Understanding")
  private let detailLabel = NSTextField(labelWithString: "Reading your request and getting ready.")
  private let timelineView = NSTextView()
  private let devTextView = NSTextView()
  private let devScrollView = NSScrollView()
  private let timelineScrollView = NSScrollView()
  private let devButton = NSButton()
  private let actionButton = NSButton()
  private var timeline: [String] = []
  private var rawLines: [String] = []
  private var isDevMode = false
  private var hasActionableError = false
  private let maxLines = 80
  var openOnboarding: (() -> Void)?

  override
  init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 300),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    super.init()
    configure()
  }

  func start(prompt: String) {
    timeline = []
    rawLines = []
    isDevMode = false
    hasActionableError = false
    actionButton.isHidden = true
    titleLabel.stringValue = "showme is working"
    setPhase("Understanding", detail: "Reading your request and getting ready.")
    updateMode()
    appendFriendly("Task: \(prompt)")
    spinner.startAnimation(nil)
    positionTopRight()
    window.orderFrontRegardless()
  }

  func append(_ line: String) {
    rawLines.append(line)
    if rawLines.count > maxLines {
      rawLines.removeFirst(rawLines.count - maxLines)
    }
    devTextView.string = rawLines.joined(separator: "\n")
    devTextView.scrollRangeToVisible(NSRange(location: devTextView.string.count, length: 0))

    if let event = friendlyEvent(from: line) {
      setPhase(event.phase, detail: event.detail)
      appendFriendly(event.timeline)
    }

    if let issue = detectActionableIssue(in: line), !hasActionableError {
      hasActionableError = true
      actionButton.isHidden = false
      appendFriendly("→ \(issue)")
    }
  }

  func finish(exitCode: Int) {
    spinner.stopAnimation(nil)
    if exitCode == 0 {
      titleLabel.stringValue = "showme finished"
      setPhase("Complete", detail: "The task finished. Review the app to confirm the result.")
      appendFriendly("Finished.")
    } else {
      titleLabel.stringValue = "showme needs attention"
      setPhase("Issue", detail: "The runner stopped before completing the task.")
      appendFriendly("Stopped with status \(exitCode).")
      if !hasActionableError {
        appendFriendly("→ Tip: Open Permissions to verify your setup.")
        actionButton.isHidden = false
      }
    }
  }

  private func configure() {
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .transient, .fullScreenAuxiliary]
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = true

    let background = GlassEffectView()
    background.material = .hudWindow
    background.layer?.cornerRadius = 22
    background.translatesAutoresizingMaskIntoConstraints = false

    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.font = .systemFont(ofSize: 14, weight: .bold)
    titleLabel.textColor = .labelColor
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    phaseLabel.font = .systemFont(ofSize: 11, weight: .semibold)
    phaseLabel.textColor = .white
    phaseLabel.alignment = .center
    phaseLabel.wantsLayer = true
    phaseLabel.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.9).cgColor
    phaseLabel.layer?.cornerRadius = 10
    phaseLabel.layer?.cornerCurve = .continuous
    phaseLabel.translatesAutoresizingMaskIntoConstraints = false

    detailLabel.font = .systemFont(ofSize: 12, weight: .regular)
    detailLabel.textColor = .secondaryLabelColor
    detailLabel.lineBreakMode = .byWordWrapping
    detailLabel.maximumNumberOfLines = 2
    detailLabel.translatesAutoresizingMaskIntoConstraints = false

    configureScrollView(timelineScrollView, textView: timelineView, monospaced: false)
    configureScrollView(devScrollView, textView: devTextView, monospaced: true)
    devScrollView.isHidden = true

    devButton.image = NSImage(systemSymbolName: "wrench.and.screwdriver", accessibilityDescription: "Developer logs")
    devButton.image?.isTemplate = true
    devButton.title = " Dev"
    devButton.bezelStyle = .regularSquare
    devButton.isBordered = false
    devButton.contentTintColor = .secondaryLabelColor
    devButton.target = self
    devButton.action = #selector(toggleDevMode)
    devButton.translatesAutoresizingMaskIntoConstraints = false

    actionButton.title = "Open Permissions"
    actionButton.bezelStyle = .rounded
    actionButton.isHidden = true
    actionButton.target = self
    actionButton.action = #selector(actionTapped)
    actionButton.translatesAutoresizingMaskIntoConstraints = false

    let root = NSView()
    window.contentView = root
    root.addSubview(background)
    background.addSubview(spinner)
    background.addSubview(titleLabel)
    background.addSubview(phaseLabel)
    background.addSubview(detailLabel)
    background.addSubview(timelineScrollView)
    background.addSubview(devScrollView)
    background.addSubview(devButton)
    background.addSubview(actionButton)

    NSLayoutConstraint.activate([
      background.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      background.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      background.topAnchor.constraint(equalTo: root.topAnchor),
      background.bottomAnchor.constraint(equalTo: root.bottomAnchor),

      spinner.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
      spinner.topAnchor.constraint(equalTo: background.topAnchor, constant: 15),
      spinner.widthAnchor.constraint(equalToConstant: 16),
      spinner.heightAnchor.constraint(equalToConstant: 16),

      titleLabel.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 9),
      titleLabel.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -110),
      titleLabel.centerYAnchor.constraint(equalTo: spinner.centerYAnchor),

      phaseLabel.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -16),
      phaseLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
      phaseLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 86),
      phaseLabel.heightAnchor.constraint(equalToConstant: 22),

      detailLabel.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
      detailLabel.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -16),
      detailLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 16),

      timelineScrollView.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
      timelineScrollView.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -14),
      timelineScrollView.topAnchor.constraint(equalTo: detailLabel.bottomAnchor, constant: 14),
      timelineScrollView.bottomAnchor.constraint(equalTo: devButton.topAnchor, constant: -10),

      devScrollView.leadingAnchor.constraint(equalTo: timelineScrollView.leadingAnchor),
      devScrollView.trailingAnchor.constraint(equalTo: timelineScrollView.trailingAnchor),
      devScrollView.topAnchor.constraint(equalTo: timelineScrollView.topAnchor),
      devScrollView.bottomAnchor.constraint(equalTo: timelineScrollView.bottomAnchor),

      devButton.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -16),
      devButton.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -12),
      devButton.heightAnchor.constraint(equalToConstant: 24),

      actionButton.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
      actionButton.centerYAnchor.constraint(equalTo: devButton.centerYAnchor),
    ])
  }

  private func setPhase(_ phase: String, detail: String) {
    phaseLabel.stringValue = phase
    detailLabel.stringValue = detail
    phaseLabel.layer?.backgroundColor = colorForPhase(phase).withAlphaComponent(0.92).cgColor
  }

  private func colorForPhase(_ phase: String) -> NSColor {
    switch phase {
    case "Understanding": return .systemBlue
    case "Looking": return .systemTeal
    case "Planning": return .systemIndigo
    case "Acting": return .systemOrange
    case "Checking": return .systemPurple
    case "Adjusting": return .systemYellow
    case "Complete": return .systemGreen
    case "Issue": return .systemRed
    default: return .controlAccentColor
    }
  }

  private func detectActionableIssue(in line: String) -> String? {
    let lower = line.lowercased()
    if lower.contains("accessibility") && (lower.contains("denied") || lower.contains("not granted") || lower.contains("blocked") || lower.contains("permission")) {
      return "Accessibility looks blocked. Open Permissions to grant it to the recorder."
    }
    if (lower.contains("screen recording") || lower.contains("screen-recording") || lower.contains("screencapture")) && (lower.contains("denied") || lower.contains("not granted") || lower.contains("blocked") || lower.contains("permission")) {
      return "Screen Recording looks blocked. Open Permissions to grant it to CuaDriver."
    }
    if lower.contains("could not launch showme") || lower.contains("executable not found") || lower.contains("no such file") {
      return "showme could not launch. Open Permissions to check setup."
    }
    if lower.contains("anthropic_api_key") && (lower.contains("not set") || lower.contains("missing") || lower.contains("unset")) {
      return "ANTHROPIC_API_KEY isn’t set. Open Permissions for the export command."
    }
    if lower.contains("cua-driver") && (lower.contains("not running") || lower.contains("not installed") || lower.contains("not found")) {
      return "CuaDriver isn’t ready. Open Permissions to install or start it."
    }
    return nil
  }

  @objc private func actionTapped() {
    openOnboarding?()
  }

  private func configureScrollView(_ scrollView: NSScrollView, textView: NSTextView, monospaced: Bool) {
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = false
    textView.font =
      monospaced
      ? .monospacedSystemFont(ofSize: 11, weight: .regular)
      : .systemFont(ofSize: 12, weight: .regular)
    textView.textColor = .secondaryLabelColor
    textView.textContainerInset = NSSize(width: 0, height: 4)
    scrollView.documentView = textView
  }

  private func appendFriendly(_ line: String) {
    let formatted = line.hasPrefix("Task:") || line == "Finished." || line.hasPrefix("Stopped")
      ? line
      : "• \(line)"
    timeline.append(formatted)
    if timeline.count > maxLines {
      timeline.removeFirst(timeline.count - maxLines)
    }
    timelineView.string = timeline.joined(separator: "\n")
    timelineView.scrollRangeToVisible(NSRange(location: timelineView.string.count, length: 0))
  }

  private func friendlyEvent(from line: String) -> (phase: String, detail: String, timeline: String)? {
    let lower = line.lowercased()
    if lower.contains("mode: prompt planner") {
      return ("Planning", "Choosing a short, safe set of actions.", "Planning the next moves.")
    }
    if lower.contains("plan:") || lower.contains("replan:") {
      return ("Planning", "A small action batch is ready.", "Prepared an action batch.")
    }
    if lower.contains("about to:") {
      let action = line.replacingOccurrences(of: "[showme] about to:", with: "").trimmingCharacters(in: .whitespaces)
      return ("Acting", "Working in the target app.", action.isEmpty ? "Taking an action." : action)
    }
    if lower.contains("screenshot") || lower.contains("capture") {
      return ("Looking", "Reading the current screen.", "Checked the screen.")
    }
    if lower.contains("verifier") || lower.contains("verify") {
      return ("Checking", "Comparing the result against the request.", "Checking whether the goal is met.")
    }
    if lower.contains("replanning") {
      return ("Adjusting", "The last attempt was not enough, so showme is changing strategy.", "Adjusted the plan based on feedback.")
    }
    if lower.contains("cost telemetry") {
      return ("Optimizing", "Tracking model calls and screenshots.", "Updated cost telemetry.")
    }
    if lower.contains("done") {
      return ("Complete", "The runner reported completion.", "Runner completed.")
    }
    if lower.contains("failed") || lower.contains("error") || lower.contains("aborted") {
      return ("Issue", "Something needs attention.", line.replacingOccurrences(of: "[showme]", with: "").trimmingCharacters(in: .whitespaces))
    }
    return nil
  }

  @objc private func toggleDevMode() {
    isDevMode.toggle()
    updateMode()
  }

  private func updateMode() {
    timelineScrollView.isHidden = isDevMode
    devScrollView.isHidden = !isDevMode
    devButton.contentTintColor = isDevMode ? .controlAccentColor : .secondaryLabelColor
    devButton.title = isDevMode ? " User" : " Dev"
  }

  private func positionTopRight() {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = window.frame
    let x = screen.maxX - frame.width - 24
    let y = screen.maxY - frame.height - 46
    window.setFrameOrigin(NSPoint(x: x, y: y))
  }
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
