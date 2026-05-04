import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import SwiftUI

enum PermissionCompletionAction: String {
  case continueRun = "continue"
  case done = "done"

  var buttonTitle: String {
    switch self {
    case .continueRun: return "Continue"
    case .done: return "Done"
    }
  }
}

struct PermissionSetupLaunchOptions {
  let completionAction: PermissionCompletionAction
  let statusFile: String?
  let terminateOnCompletion: Bool
}

@MainActor
final class PermissionSetupController: NSObject, NSWindowDelegate {
  private let window: NSWindow
  private let viewModel: PermissionSetupViewModel
  private let terminateOnCompletion: Bool

  init(options: PermissionSetupLaunchOptions) {
    viewModel = PermissionSetupViewModel(
      completionAction: options.completionAction,
      statusFile: options.statusFile
    )
    terminateOnCompletion = options.terminateOnCompletion
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 700),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    super.init()
    configureWindow()
  }

  func show() {
    if !window.isVisible {
      window.center()
    }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    viewModel.start()
  }

  func windowWillClose(_ notification: Notification) {
    if !viewModel.completed {
      viewModel.writeStatus(status: "closed", message: "Setup not completed.")
    }
    if terminateOnCompletion {
      NSApp.terminate(nil)
    }
  }

  private func configureWindow() {
    window.title = "Set up OpenclickHelper"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.isMovableByWindowBackground = true
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    let fixedSize = NSSize(width: 560, height: 700)
    window.contentMinSize = fixedSize
    window.contentMaxSize = fixedSize
    window.setContentSize(fixedSize)
    window.delegate = self

    viewModel.onFinish = { [weak self] in
      self?.window.close()
    }

    let host = NSHostingView(rootView: PermissionSetupView(viewModel: viewModel))
    host.translatesAutoresizingMaskIntoConstraints = false
    let root = NSView()
    root.addSubview(host)
    window.contentView = root
    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      host.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      host.topAnchor.constraint(equalTo: root.topAnchor),
      host.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
  }
}

@MainActor
final class PermissionSetupViewModel: ObservableObject {
  @Published var steps: [PermissionSetupStep] = PermissionSetupStep.defaultSteps()
  @Published var installMessage: String = "Checking install location..."
  @Published var isReady = false
  @Published var activeIndex = 0
  @Published var completed = false

  let completionAction: PermissionCompletionAction
  var onFinish: (() -> Void)?

  private let statusFile: String?
  private var timer: Timer?
  private var activeStartedAt = Date()
  private var developerToolsNeeded = false

  init(completionAction: PermissionCompletionAction, statusFile: String?) {
    self.completionAction = completionAction
    self.statusFile = statusFile
  }

  func start() {
    installMessage = installHelperIfNeeded()
    developerToolsNeeded =
      ProcessInfo.processInfo.environment["OPENCLICK_REQUIRE_DEVELOPER_TOOLS"] == "1"
    evaluateSteps()
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.evaluateSteps() }
    }
  }

  func request(step: PermissionSetupStep.Kind) {
    switch step {
    case .accessibility:
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(options)
      SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    case .screenRecording:
      if !CGPreflightScreenCaptureAccess() {
        _ = CGRequestScreenCaptureAccess()
      }
      SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    case .automation:
      _ = PermissionProbes.automationGranted()
      SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
    case .developerTools:
      SettingsLink.open("x-apple.systempreferences:com.apple.preference.security?Privacy_DeveloperTools")
    }
  }

  func retryActiveStep() {
    guard steps.indices.contains(activeIndex) else { return }
    activeStartedAt = Date()
    steps[activeIndex].waitingTooLong = false
    request(step: steps[activeIndex].kind)
  }

  func finish() {
    completed = true
    writeStatus(status: "completed", message: "OpenclickHelper is ready.")
    onFinish?()
  }

  func writeStatus(status: String, message: String) {
    guard let statusFile else { return }
    let payload: [String: String] = [
      "status": status,
      "message": message,
      "updatedAt": ISO8601DateFormatter().string(from: Date()),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) else {
      return
    }
    try? FileManager.default.createDirectory(
      at: URL(fileURLWithPath: statusFile).deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try? data.write(to: URL(fileURLWithPath: statusFile))
  }

  private func evaluateSteps() {
    var nextActive: Int?
    for index in steps.indices {
      let granted = isGranted(steps[index].kind)
      if granted {
        steps[index].state = .done
        steps[index].status = steps[index].doneStatus
        steps[index].waitingTooLong = false
      } else if nextActive == nil {
        nextActive = index
      } else {
        steps[index].state = .pending
        steps[index].status = "Pending"
        steps[index].waitingTooLong = false
      }
    }

    if let nextActive {
      if activeIndex != nextActive {
        activeIndex = nextActive
        activeStartedAt = Date()
      }
      steps[nextActive].state = .active
      steps[nextActive].status = "Waiting..."
      if Date().timeIntervalSince(activeStartedAt) >= 60 {
        steps[nextActive].waitingTooLong = true
      }
      isReady = false
    } else {
      isReady = true
      timer?.invalidate()
      timer = nil
    }
  }

  private func isGranted(_ kind: PermissionSetupStep.Kind) -> Bool {
    switch kind {
    case .accessibility:
      return AXIsProcessTrusted()
    case .screenRecording:
      return CGPreflightScreenCaptureAccess()
    case .automation:
      return PermissionProbes.automationGranted()
    case .developerTools:
      return !developerToolsNeeded || PermissionProbes.developerToolsAllowed()
    }
  }

  private func installHelperIfNeeded() -> String {
    let source = Bundle.main.bundleURL
    guard source.pathExtension == "app" else {
      return "Running from a development build."
    }
    if source.path == "/Applications/OpenclickHelper.app" ||
      source.path == "\(NSHomeDirectory())/Applications/OpenclickHelper.app"
    {
      return "Installed at \(source.path)."
    }
    let destinations = [
      URL(fileURLWithPath: "/Applications/OpenclickHelper.app"),
      FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications")
        .appendingPathComponent("OpenclickHelper.app"),
    ]
    for destination in destinations {
      do {
        try FileManager.default.createDirectory(
          at: destination.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        if FileManager.default.fileExists(atPath: destination.path) {
          if bundleVersion(at: destination) == bundleVersion(at: source) {
            return "Installed at \(destination.path)."
          }
          try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: source, to: destination)
        return "Installed at \(destination.path)."
      } catch {
        continue
      }
    }
    return "Could not copy to /Applications or ~/Applications. You can continue from this app copy."
  }

  private func bundleVersion(at url: URL) -> String? {
    guard let bundle = Bundle(url: url) else { return nil }
    return bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
  }
}

struct PermissionSetupStep: Identifiable, Equatable {
  enum Kind: String {
    case accessibility
    case screenRecording
    case automation
    case developerTools
  }

  enum State {
    case pending
    case active
    case done
    case error
  }

  let id: Int
  let kind: Kind
  let title: String
  let subtitle: String
  let why: String
  let doneStatus: String
  var state: State = .pending
  var status: String = "Pending"
  var waitingTooLong = false

  static func defaultSteps() -> [PermissionSetupStep] {
    [
      PermissionSetupStep(
        id: 1,
        kind: .accessibility,
        title: "Accessibility",
        subtitle: "Lets OpenclickHelper read the UI and send clicks.",
        why: "Reads UI structure of apps you point it at. Does not transmit it.",
        doneStatus: "Granted"
      ),
      PermissionSetupStep(
        id: 2,
        kind: .screenRecording,
        title: "Screen Recording",
        subtitle: "Lets OpenclickHelper capture screenshots.",
        why: "Captures screenshots only when a task is running. Sent only to your configured AI provider.",
        doneStatus: "Granted"
      ),
      PermissionSetupStep(
        id: 3,
        kind: .automation,
        title: "Automation / Apple Events",
        subtitle: "Lets OpenclickHelper automate apps that expose Apple Events.",
        why: "Used only when a target app requires Apple Events for a requested action.",
        doneStatus: "Allowed"
      ),
      PermissionSetupStep(
        id: 4,
        kind: .developerTools,
        title: "Developer Tools / SIP",
        subtitle: "Needed only on Macs that require developer-tool authorization.",
        why: "Most Macs do not need this; if required, macOS controls it locally.",
        doneStatus: "Ready"
      ),
    ]
  }
}

struct PermissionSetupView: View {
  @ObservedObject var viewModel: PermissionSetupViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(.horizontal, 24)
        .padding(.top, 28)
        .padding(.bottom, 20)

      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(viewModel.steps.enumerated()), id: \.element.id) { index, step in
            PermissionStepRow(
              step: step,
              request: { viewModel.request(step: step.kind) },
              retry: { viewModel.retryActiveStep() }
            )
            if index < viewModel.steps.count - 1 {
              Divider().padding(.leading, 56)
            }
          }
        }
      }

      Divider()

      footer
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }
    .frame(width: 520, height: 600)
    .background(.regularMaterial)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Set up OpenclickHelper")
        .font(.system(size: 22, weight: .semibold))
      Text(
        viewModel.installMessage.isEmpty
          ? "Grant the permissions OpenclickHelper needs to drive your apps."
          : viewModel.installMessage
      )
      .font(.system(size: 13))
      .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var footer: some View {
    HStack {
      if viewModel.isReady {
        Label("All set", systemImage: "checkmark.circle.fill")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(.green)
      } else {
        Text("\(grantedCount) of \(viewModel.steps.count) granted")
          .font(.system(size: 13))
          .foregroundStyle(.secondary)
      }
      Spacer()
      Button(action: { viewModel.finish() }) {
        Text(viewModel.completionAction.buttonTitle)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .keyboardShortcut(.defaultAction)
      .disabled(!viewModel.isReady)
    }
  }

  private var grantedCount: Int {
    viewModel.steps.filter { $0.state == .done }.count
  }
}

struct PermissionStepRow: View {
  let step: PermissionSetupStep
  let request: () -> Void
  let retry: () -> Void
  @State private var showingWhy = false

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: stateSymbol)
        .font(.system(size: 18, weight: .regular))
        .foregroundStyle(stateColor)
        .frame(width: 26, height: 26)

      VStack(alignment: .leading, spacing: 4) {
        Text(step.title)
          .font(.system(size: 13, weight: .semibold))
        Text(step.state == .done ? step.doneStatus : step.subtitle)
          .font(.system(size: 12))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)

        if step.state != .done {
          HStack(spacing: 10) {
            Button("Open Settings", action: request)
              .controlSize(.small)
              .disabled(step.state == .pending)

            Button(action: { showingWhy.toggle() }) {
              Text("Why?")
            }
            .buttonStyle(.link)
            .controlSize(.small)
            .popover(isPresented: $showingWhy, arrowEdge: .bottom) {
              Text(step.why)
                .font(.system(size: 12))
                .padding(12)
                .frame(width: 260, alignment: .leading)
            }

            if step.waitingTooLong {
              Button("Retry", action: retry)
                .controlSize(.small)
            }
          }
          .padding(.top, 2)
        }
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 14)
  }

  private var stateSymbol: String {
    switch step.state {
    case .done: return "checkmark.circle.fill"
    case .active: return "circle.dashed"
    case .error: return "exclamationmark.circle.fill"
    case .pending: return "circle"
    }
  }

  private var stateColor: Color {
    switch step.state {
    case .done: return .green
    case .active: return .accentColor
    case .error: return .red
    case .pending: return .secondary
    }
  }
}

enum PermissionProbes {
  static func automationGranted() -> Bool {
    let script = "tell application \"System Events\" to get name of first process"
    return run("/usr/bin/osascript", ["-e", script]) == 0
  }

  static func fullDiskAccessAvailable() -> Bool {
    let tccPath = "\(NSHomeDirectory())/Library/Application Support/com.apple.TCC/TCC.db"
    return FileManager.default.isReadableFile(atPath: tccPath)
  }

  static func developerToolsAllowed() -> Bool {
    let status = runWithOutput("/usr/sbin/DevToolsSecurity", ["-status"])
    if status.code != 0 { return false }
    return status.output.lowercased().contains("enabled")
  }

  private static func run(_ executable: String, _ arguments: [String]) -> Int32 {
    runWithOutput(executable, arguments).code
  }

  private static func runWithOutput(_ executable: String, _ arguments: [String]) -> (
    code: Int32,
    output: String
  ) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    } catch {
      return (1, "")
    }
  }
}
