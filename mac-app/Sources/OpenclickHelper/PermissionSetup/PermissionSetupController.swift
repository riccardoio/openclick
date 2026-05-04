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
    window.delegate = self

    viewModel.onFinish = { [weak self] in
      guard let self else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        self.window.close()
      }
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
    ZStack(alignment: .top) {
      // Subtle accent gradient overlay for depth (sits on top of the
      // window's vibrancy material — gives the "liquid glass" feel
      // without depending on macOS-26-only APIs).
      LinearGradient(
        colors: [
          Color.accentColor.opacity(0.10),
          Color.accentColor.opacity(0.0),
        ],
        startPoint: .top,
        endPoint: .center
      )
      .frame(height: 240)
      .blur(radius: 30)
      .allowsHitTesting(false)

      VStack(alignment: .leading, spacing: 18) {
        header
        if !viewModel.installMessage.isEmpty {
          installRow
        }
        VStack(spacing: 10) {
          ForEach(viewModel.steps) { step in
            PermissionStepCard(
              step: step,
              request: { viewModel.request(step: step.kind) },
              retry: { viewModel.retryActiveStep() }
            )
          }
        }
        Spacer(minLength: 12)
        if viewModel.isReady {
          ready
            .transition(.scale(scale: 0.94).combined(with: .opacity))
        }
      }
      .padding(28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(.regularMaterial)
    .animation(.smooth(duration: 0.35), value: viewModel.isReady)
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 14) {
      ZStack {
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .fill(.thinMaterial)
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5)
        Image(systemName: "cursorarrow.click.2")
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(Color.accentColor)
      }
      .frame(width: 52, height: 52)
      .shadow(color: Color.black.opacity(0.10), radius: 10, y: 3)

      VStack(alignment: .leading, spacing: 4) {
        Text("Set up OpenclickHelper")
          .font(.system(size: 26, weight: .bold, design: .rounded))
          .foregroundStyle(.primary)
        Text("Two macOS permissions. About 30 seconds.")
          .font(.system(size: 13))
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
  }

  private var installRow: some View {
    HStack(spacing: 8) {
      Image(systemName: "shippingbox.fill")
        .imageScale(.small)
        .foregroundStyle(.tertiary)
      Text(viewModel.installMessage)
        .font(.system(size: 12.5))
        .foregroundStyle(.secondary)
        .lineLimit(2)
    }
  }

  private var ready: some View {
    VStack(spacing: 14) {
      HStack(spacing: 16) {
        ZStack {
          Circle()
            .fill(Color.green.opacity(0.15))
            .frame(width: 64, height: 64)
          Circle()
            .fill(Color.green.opacity(0.25))
            .frame(width: 48, height: 48)
            .blur(radius: 8)
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 44, weight: .semibold))
            .foregroundStyle(Color.green)
            .shadow(color: Color.green.opacity(0.4), radius: 6, y: 2)
        }
        VStack(alignment: .leading, spacing: 4) {
          Text("OpenclickHelper is ready")
            .font(.system(size: 19, weight: .bold, design: .rounded))
          Text(
            viewModel.completionAction == .continueRun
              ? "Continuing your task in the terminal."
              : "You can close this window."
          )
          .font(.system(size: 13))
          .foregroundStyle(.secondary)
        }
        Spacer()
      }
      Button(action: { viewModel.finish() }) {
        Text(viewModel.completionAction.buttonTitle)
          .font(.system(size: 15, weight: .semibold))
          .frame(maxWidth: .infinity, minHeight: 32)
          .contentShape(Rectangle())
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .keyboardShortcut(.defaultAction)
    }
    .padding(18)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(.thinMaterial)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
    )
    .shadow(color: Color.black.opacity(0.08), radius: 12, y: 4)
  }
}

struct PermissionStepCard: View {
  let step: PermissionSetupStep
  let request: () -> Void
  let retry: () -> Void
  @State private var showingWhy = false

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      badge
      VStack(alignment: .leading, spacing: step.state == .done ? 2 : 10) {
        HStack(spacing: 8) {
          Text(step.title)
            .font(.system(size: 14.5, weight: .semibold, design: .rounded))
            .foregroundStyle(.primary)
          Spacer(minLength: 8)
          statusPill
        }
        if step.state != .done {
          Text(step.subtitle)
            .font(.system(size: 12.5))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 10) {
            Button(action: request) {
              HStack(spacing: 5) {
                Text("Open Settings")
                Image(systemName: "arrow.up.right")
                  .imageScale(.small)
              }
              .font(.system(size: 12.5, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
            .disabled(step.state == .pending)

            Button(action: { showingWhy.toggle() }) {
              HStack(spacing: 4) {
                Image(systemName: "questionmark.circle")
                Text("Why?")
              }
              .font(.system(size: 12.5))
              .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .popover(isPresented: $showingWhy, arrowEdge: .bottom) {
              VStack(alignment: .leading, spacing: 6) {
                Text(step.title)
                  .font(.system(size: 13, weight: .semibold, design: .rounded))
                Text(step.why)
                  .font(.system(size: 12.5))
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              .padding(14)
              .frame(width: 280, alignment: .leading)
            }

            if step.waitingTooLong {
              Button(action: retry) {
                HStack(spacing: 4) {
                  Image(systemName: "arrow.clockwise")
                  Text("Retry")
                }
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(.orange)
              }
              .buttonStyle(.borderless)
            }
          }
        }
      }
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(.thinMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(stateTint)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(borderColor, lineWidth: 0.6)
    )
    .shadow(color: shadowColor, radius: step.state == .active ? 8 : 3, y: 1)
    .animation(.smooth(duration: 0.25), value: step.state)
  }

  private var badge: some View {
    ZStack {
      Circle()
        .fill(badgeFill)
        .shadow(color: badgeFill.opacity(0.45), radius: 4, y: 1)
      Image(systemName: badgeSymbol)
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(.white)
        .scaleEffect(step.state == .done ? 1.05 : 1.0)
        .animation(.spring(response: 0.32, dampingFraction: 0.6), value: step.state)
    }
    .frame(width: 26, height: 26)
  }

  private var statusPill: some View {
    Text(step.status)
      .font(.system(size: 10.5, weight: .semibold))
      .textCase(.uppercase)
      .tracking(0.4)
      .foregroundStyle(pillTextColor)
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(pillBackground, in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(pillTextColor.opacity(0.18), lineWidth: 0.5)
      )
  }

  private var badgeFill: Color {
    switch step.state {
    case .done: return .green
    case .active: return .accentColor
    case .error: return .red
    case .pending: return .gray.opacity(0.45)
    }
  }

  private var badgeSymbol: String {
    switch step.state {
    case .done: return "checkmark"
    case .active: return "circle.fill"
    case .error: return "xmark"
    case .pending: return "circle"
    }
  }

  private var stateTint: Color {
    switch step.state {
    case .active: return Color.accentColor.opacity(0.10)
    case .done: return Color.green.opacity(0.06)
    case .error: return Color.red.opacity(0.08)
    case .pending: return Color.clear
    }
  }

  private var borderColor: Color {
    switch step.state {
    case .active: return Color.accentColor.opacity(0.40)
    case .done: return Color.green.opacity(0.28)
    case .error: return Color.red.opacity(0.30)
    case .pending: return Color.white.opacity(0.06)
    }
  }

  private var shadowColor: Color {
    switch step.state {
    case .active: return Color.accentColor.opacity(0.18)
    case .done: return Color.green.opacity(0.10)
    case .error: return Color.red.opacity(0.10)
    case .pending: return Color.black.opacity(0.04)
    }
  }

  private var pillBackground: Color {
    switch step.state {
    case .active: return Color.accentColor.opacity(0.18)
    case .done: return Color.green.opacity(0.18)
    case .error: return Color.red.opacity(0.20)
    case .pending: return Color.gray.opacity(0.18)
    }
  }

  private var pillTextColor: Color {
    switch step.state {
    case .active: return Color.accentColor
    case .done: return Color.green
    case .error: return Color.red
    case .pending: return Color.secondary
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
