import AppKit
import Carbon
import Foundation

final class ShowmeBarApp: NSObject, NSApplicationDelegate {
  private var statusController: StatusController?
  private var hotKeyController: HotKeyController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    let chatBar = ChatBarController()
    statusController = StatusController(chatBar: chatBar)
    hotKeyController = HotKeyController { chatBar.toggle() }
    hotKeyController?.register()
    chatBar.show()
  }
}

let app = NSApplication.shared
let delegate = ShowmeBarApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

final class StatusController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let chatBar: ChatBarController

  init(chatBar: ChatBarController) {
    self.chatBar = chatBar
    super.init()

    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "cursorarrow.click.2", accessibilityDescription: "showme")
      button.image?.isTemplate = true
      button.title = " showme"
      button.action = #selector(toggleChatBar)
      button.target = self
    }

    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Open Chat Bar", action: #selector(openChatBar), keyEquivalent: " "))
    menu.items.last?.keyEquivalentModifierMask = [.option]
    menu.items.last?.target = self
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit showme", action: #selector(quit), keyEquivalent: "q"))
    menu.items.last?.target = self
    statusItem.menu = menu
  }

  @objc private func toggleChatBar() {
    chatBar.toggle()
  }

  @objc private func openChatBar() {
    chatBar.show()
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }
}

final class ChatBarController: NSObject, NSTextFieldDelegate {
  private let window: ChatBarWindow
  private let activityLog = ActivityLogController()
  private let promptField = NSTextField()
  private let runButton = NSButton()
  private let foregroundButton = NSButton()
  private let statusLabel = NSTextField(labelWithString: "")
  private var runningProcess: Process?
  private var outputPipes: [Pipe] = []
  private var allowForeground = false

  override init() {
    let size = NSSize(width: 680, height: 86)
    window = ChatBarWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    super.init()

    configureWindow()
    configureContent()
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
    DispatchQueue.main.async { [promptField, window] in
      window.makeFirstResponder(promptField)
    }
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
    let background = NSVisualEffectView()
    background.material = .popover
    background.blendingMode = .behindWindow
    background.state = .active
    background.wantsLayer = true
    background.layer?.cornerRadius = 24
    background.layer?.cornerCurve = .continuous
    background.layer?.masksToBounds = true
    background.translatesAutoresizingMaskIntoConstraints = false

    let container = NSView()
    container.wantsLayer = true
    container.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.58).cgColor
    container.layer?.cornerRadius = 24
    container.layer?.cornerCurve = .continuous
    container.translatesAutoresizingMaskIntoConstraints = false

    let plusButton = iconButton("plus", action: #selector(noop))
    let globeButton = iconButton("globe", action: #selector(noop))
    let cursorButton = iconButton("cursorarrow.click", action: #selector(noop))
    foregroundButton.image = NSImage(systemSymbolName: "person.crop.circle.badge.exclamationmark", accessibilityDescription: "Foreground control")
    foregroundButton.image?.isTemplate = true
    foregroundButton.bezelStyle = .regularSquare
    foregroundButton.isBordered = false
    foregroundButton.contentTintColor = .secondaryLabelColor
    foregroundButton.toolTip = "Shared-seat mode is on. Click to allow foreground control for tasks that cannot run in the background."
    foregroundButton.target = self
    foregroundButton.action = #selector(toggleForegroundMode)
    foregroundButton.translatesAutoresizingMaskIntoConstraints = false

    promptField.placeholderString = "Ask showme to do anything"
    promptField.isBordered = false
    promptField.drawsBackground = false
    promptField.focusRingType = .none
    promptField.font = .systemFont(ofSize: 16, weight: .regular)
    promptField.delegate = self
    promptField.target = self
    promptField.action = #selector(submit)
    promptField.translatesAutoresizingMaskIntoConstraints = false

    let micButton = iconButton("mic", action: #selector(noop))
    runButton.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "Run")
    runButton.image?.isTemplate = true
    runButton.bezelStyle = .regularSquare
    runButton.isBordered = false
    runButton.wantsLayer = true
    runButton.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
    runButton.layer?.cornerRadius = 16
    runButton.contentTintColor = .white
    runButton.target = self
    runButton.action = #selector(submit)
    runButton.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = .systemFont(ofSize: 11, weight: .medium)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.lineBreakMode = .byTruncatingTail
    statusLabel.translatesAutoresizingMaskIntoConstraints = false

    let root = NSView()
    root.translatesAutoresizingMaskIntoConstraints = false
    window.contentView = root
    root.addSubview(background)
    background.addSubview(container)
    [plusButton, globeButton, cursorButton, foregroundButton, promptField, micButton, runButton, statusLabel].forEach {
      container.addSubview($0)
    }

    NSLayoutConstraint.activate([
      background.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      background.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      background.topAnchor.constraint(equalTo: root.topAnchor),
      background.bottomAnchor.constraint(equalTo: root.bottomAnchor),

      container.leadingAnchor.constraint(equalTo: background.leadingAnchor),
      container.trailingAnchor.constraint(equalTo: background.trailingAnchor),
      container.topAnchor.constraint(equalTo: background.topAnchor),
      container.bottomAnchor.constraint(equalTo: background.bottomAnchor),

      plusButton.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
      plusButton.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: 10),
      plusButton.widthAnchor.constraint(equalToConstant: 26),
      plusButton.heightAnchor.constraint(equalToConstant: 26),

      globeButton.leadingAnchor.constraint(equalTo: plusButton.trailingAnchor, constant: 8),
      globeButton.centerYAnchor.constraint(equalTo: plusButton.centerYAnchor),
      globeButton.widthAnchor.constraint(equalToConstant: 26),
      globeButton.heightAnchor.constraint(equalToConstant: 26),

      cursorButton.leadingAnchor.constraint(equalTo: globeButton.trailingAnchor, constant: 8),
      cursorButton.centerYAnchor.constraint(equalTo: plusButton.centerYAnchor),
      cursorButton.widthAnchor.constraint(equalToConstant: 26),
      cursorButton.heightAnchor.constraint(equalToConstant: 26),

      foregroundButton.leadingAnchor.constraint(equalTo: cursorButton.trailingAnchor, constant: 8),
      foregroundButton.centerYAnchor.constraint(equalTo: plusButton.centerYAnchor),
      foregroundButton.widthAnchor.constraint(equalToConstant: 26),
      foregroundButton.heightAnchor.constraint(equalToConstant: 26),

      promptField.leadingAnchor.constraint(equalTo: foregroundButton.trailingAnchor, constant: 12),
      promptField.trailingAnchor.constraint(equalTo: micButton.leadingAnchor, constant: -12),
      promptField.centerYAnchor.constraint(equalTo: plusButton.centerYAnchor),

      micButton.trailingAnchor.constraint(equalTo: runButton.leadingAnchor, constant: -10),
      micButton.centerYAnchor.constraint(equalTo: plusButton.centerYAnchor),
      micButton.widthAnchor.constraint(equalToConstant: 26),
      micButton.heightAnchor.constraint(equalToConstant: 26),

      runButton.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
      runButton.centerYAnchor.constraint(equalTo: plusButton.centerYAnchor),
      runButton.widthAnchor.constraint(equalToConstant: 32),
      runButton.heightAnchor.constraint(equalToConstant: 32),

      statusLabel.leadingAnchor.constraint(equalTo: promptField.leadingAnchor),
      statusLabel.trailingAnchor.constraint(equalTo: runButton.trailingAnchor),
      statusLabel.topAnchor.constraint(equalTo: promptField.bottomAnchor, constant: 9),
    ])
  }

  private func iconButton(_ symbol: String, action: Selector) -> NSButton {
    let button = NSButton()
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: symbol)
    button.image?.isTemplate = true
    button.bezelStyle = .regularSquare
    button.isBordered = false
    button.contentTintColor = .secondaryLabelColor
    button.target = self
    button.action = action
    button.translatesAutoresizingMaskIntoConstraints = false
    return button
  }

  private func positionNearTopCenter() {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = window.frame
    let x = screen.midX - frame.width / 2
    let y = screen.maxY - frame.height - 54
    window.setFrameOrigin(NSPoint(x: x, y: y))
  }

  @objc private func noop() {
    NSSound.beep()
  }

  @objc private func toggleForegroundMode() {
    allowForeground.toggle()
    updateForegroundButton()
    statusLabel.stringValue = allowForeground
      ? "Foreground control allowed for next run"
      : "Shared-seat background mode"
  }

  private func updateForegroundButton() {
    foregroundButton.contentTintColor = allowForeground ? .systemOrange : .secondaryLabelColor
    foregroundButton.toolTip = allowForeground
      ? "Foreground control is allowed for the next run. Click to return to shared-seat background mode."
      : "Shared-seat mode is on. Click to allow foreground control for tasks that cannot run in the background."
  }

  @objc private func submit() {
    if runningProcess != nil {
      cancelCurrentRun()
      return
    }
    let prompt = promptField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty else { return }

    runButton.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop")
    promptField.isEnabled = false
    foregroundButton.isEnabled = false
    statusLabel.stringValue = allowForeground
      ? "Running with foreground control..."
      : "Running in shared-seat mode..."
    promptField.stringValue = ""
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
    stream(pipe: outputPipe, prefix: nil)
    stream(pipe: errorPipe, prefix: nil)
    outputPipes = [outputPipe, errorPipe]
    runningProcess = process

    process.terminationHandler = { [weak self] process in
      DispatchQueue.main.async {
        self?.stopStreaming()
        self?.activityLog.finish(exitCode: Int(process.terminationStatus))
        self?.runButton.isEnabled = true
        self?.runButton.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "Run")
        self?.runButton.image?.isTemplate = true
        self?.promptField.isEnabled = true
        self?.foregroundButton.isEnabled = true
        self?.statusLabel.stringValue =
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
      runButton.isEnabled = true
      runButton.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "Run")
      runButton.image?.isTemplate = true
      promptField.isEnabled = true
      foregroundButton.isEnabled = true
      statusLabel.stringValue = "Could not launch showme: \(error.localizedDescription)"
      activityLog.append("Could not launch showme: \(error.localizedDescription)")
      activityLog.finish(exitCode: 1)
      runningProcess = nil
      show()
    }
  }

  private func cancelCurrentRun() {
    guard let process = runningProcess else { return }
    activityLog.append("Cancellation requested.")
    statusLabel.stringValue = "Stopping showme..."
    process.terminate()
  }

  private func stream(pipe: Pipe, prefix: String?) {
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
          self?.activityLog.append(prefix.map { "\($0) \(line)" } ?? line)
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
    let runArgs = ["run", prompt, "--live"] + (allowForeground ? ["--allow-foreground"] : [])
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
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class ActivityLogController: NSObject {
  private let window: NSWindow
  private let spinner = NSProgressIndicator()
  private let titleLabel = NSTextField(labelWithString: "showme is working")
  private let phaseLabel = NSTextField(labelWithString: "Starting")
  private let detailLabel = NSTextField(labelWithString: "Preparing the task...")
  private let timelineView = NSTextView()
  private let devTextView = NSTextView()
  private let devScrollView = NSScrollView()
  private let timelineScrollView = NSScrollView()
  private let devButton = NSButton()
  private var timeline: [String] = []
  private var rawLines: [String] = []
  private var isDevMode = false
  private let maxLines = 80

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
    titleLabel.stringValue = "showme is working"
    phaseLabel.stringValue = "Understanding"
    detailLabel.stringValue = "Interpreting your request and preparing the desktop."
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
      phaseLabel.stringValue = event.phase
      detailLabel.stringValue = event.detail
      appendFriendly(event.timeline)
    }
  }

  func finish(exitCode: Int) {
    spinner.stopAnimation(nil)
    titleLabel.stringValue = exitCode == 0 ? "showme finished" : "showme needs attention"
    phaseLabel.stringValue = exitCode == 0 ? "Complete" : "Stopped"
    detailLabel.stringValue =
      exitCode == 0
      ? "The task finished. Review the app to confirm the result."
      : "The runner stopped before completing the task."
    appendFriendly(exitCode == 0 ? "Finished." : "Stopped with status \(exitCode).")
  }

  private func configure() {
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .transient, .fullScreenAuxiliary]
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = true

    let background = NSVisualEffectView()
    background.material = .hudWindow
    background.blendingMode = .behindWindow
    background.state = .active
    background.wantsLayer = true
    background.layer?.cornerRadius = 22
    background.layer?.cornerCurve = .continuous
    background.layer?.masksToBounds = true
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
    ])
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
