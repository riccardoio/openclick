import AppKit
import Security
import SwiftUI

@MainActor
final class SettingsController: NSObject {
  private let window: NSWindow
  private let viewModel = SettingsViewModel()

  override init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 620, height: 620),
      styleMask: [.titled, .closable, .fullSizeContentView, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    super.init()
    configureWindow()
  }

  func show() {
    viewModel.reload()
    if !window.isVisible {
      window.center()
    }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  private func configureWindow() {
    window.title = "open42 Settings"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.isMovableByWindowBackground = true
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true

    let host = NSHostingView(rootView: SettingsView(viewModel: viewModel))
    host.translatesAutoresizingMaskIntoConstraints = false
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor

    let root = NSView()
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.clear.cgColor
    root.layer?.cornerRadius = 28
    root.layer?.cornerCurve = .continuous
    root.layer?.masksToBounds = true
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
final class SettingsViewModel: ObservableObject {
  @Published var provider: Open42Provider = Open42SettingsStore.provider()
  @Published var maskedKey: String = ""
  @Published var source: String = "Not configured"
  @Published var newApiKey: String = ""
  @Published var plannerModel: String = ""
  @Published var verifierModel: String = ""
  @Published var resultModel: String = ""
  @Published var compileModel: String = ""
  @Published var message: String = "Paste a new key to replace the current one."
  @Published var hasSavedKey: Bool = false

  func reload() {
    provider = Open42SettingsStore.provider()
    reloadModels()
    reloadKey()
  }

  func selectProvider(_ selected: Open42Provider) {
    provider = selected
    Open42SettingsStore.saveProvider(selected)
    message = "Provider set to \(selected.title)."
    reloadKey()
  }

  private func reloadKey() {
    if let key = Open42Keychain.apiKey(provider: provider), !key.isEmpty {
      maskedKey = Open42Keychain.mask(key)
      source = "Saved in Keychain"
      hasSavedKey = true
    } else if let key = ProcessInfo.processInfo.environment[provider.envKeyName], !key.isEmpty {
      maskedKey = Open42Keychain.mask(key)
      source = "Available from app environment"
      hasSavedKey = false
    } else if provider == .anthropic, let key = ProcessInfo.processInfo.environment["OPEN42_API_KEY"], !key.isEmpty {
      maskedKey = Open42Keychain.mask(key)
      source = "Available from app environment"
      hasSavedKey = false
    } else {
      maskedKey = "Not set"
      source = "Not configured"
      hasSavedKey = false
    }
    newApiKey = ""
  }

  func save() {
    let trimmed = newApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      message = "Paste an API key before saving."
      return
    }
    if Open42Keychain.saveApiKey(trimmed, provider: provider) {
      message = "\(provider.title) API key saved. App-launched tasks will use this key."
      reloadKey()
    } else {
      message = "Could not save the API key to Keychain."
    }
  }

  func clear() {
    Open42Keychain.deleteApiKey(provider: provider)
    message = "Saved \(provider.title) API key removed."
    reloadKey()
  }

  func saveModels() {
    Open42SettingsStore.saveModel("planner", plannerModel)
    Open42SettingsStore.saveModel("verifier", verifierModel)
    Open42SettingsStore.saveModel("result", resultModel)
    Open42SettingsStore.saveModel("compile", compileModel)
    message = "Model choices saved."
    reloadModels()
  }

  private func reloadModels() {
    let models = Open42SettingsStore.models()
    plannerModel = models["planner"] ?? ""
    verifierModel = models["verifier"] ?? ""
    resultModel = models["result"] ?? ""
    compileModel = models["compile"] ?? ""
  }
}

struct SettingsView: View {
  @ObservedObject var viewModel: SettingsViewModel
  @FocusState private var fieldFocused: Bool

  var body: some View {
    ZStack {
      DarkCanvas()
      VStack(alignment: .leading, spacing: 24) {
        header
        apiKeySection
        modelSection
        Spacer(minLength: 0)
        footer
      }
      .padding(.horizontal, 34)
      .padding(.top, 52)
      .padding(.bottom, 28)
    }
    .overlay(
      RoundedRectangle(cornerRadius: 28, style: .continuous)
        .strokeBorder(DarkPalette.glassBorder, lineWidth: 1)
        .allowsHitTesting(false)
    )
    .overlay(alignment: .top) {
      RoundedRectangle(cornerRadius: 28, style: .continuous)
        .stroke(
          LinearGradient(
            colors: [DarkPalette.glassHighlight, .clear],
            startPoint: .top,
            endPoint: .bottom
          ),
          lineWidth: 1
        )
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }
    .onAppear {
      viewModel.reload()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        fieldFocused = true
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Settings")
        .font(.system(size: 30, weight: .bold))
        .foregroundStyle(DarkPalette.textPrimary)
      Text("Manage the local open42 configuration.")
        .font(.system(size: 14))
        .foregroundStyle(DarkPalette.textSecondary)
    }
  }

  private var apiKeySection: some View {
    VStack(alignment: .leading, spacing: 16) {
      Picker("Provider", selection: providerBinding) {
        ForEach(Open42Provider.allCases) { provider in
          Text(provider.title).tag(provider)
        }
      }
      .pickerStyle(.segmented)

      HStack(alignment: .center, spacing: 14) {
        IconBubble(kind: .apiKey)
        VStack(alignment: .leading, spacing: 5) {
          Text("\(viewModel.provider.title) API key")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(DarkPalette.textPrimary)
          Text(viewModel.source)
            .font(.system(size: 12.5))
            .foregroundStyle(DarkPalette.textSecondary)
        }
        Spacer()
        Text(viewModel.maskedKey)
          .font(.system(size: 13, weight: .semibold, design: .monospaced))
          .foregroundStyle(DarkPalette.textTertiary)
          .lineLimit(1)
      }

      SecureField("Paste new \(viewModel.provider.title) API key", text: $viewModel.newApiKey)
        .textFieldStyle(.plain)
        .font(.system(size: 14))
        .focused($fieldFocused)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(DarkPalette.rowFill)
            .background(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(.ultraThinMaterial)
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
        )
    }
    .padding(20)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(DarkPalette.rowFill)
        .background(
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(.ultraThinMaterial)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
    )
    .shadow(color: DarkPalette.cardShadow, radius: 22, x: 0, y: 10)
  }

  private var footer: some View {
    HStack(spacing: 12) {
      Text(viewModel.message)
        .font(.system(size: 12.5, weight: .medium))
        .foregroundStyle(DarkPalette.textTertiary)
      Spacer()
      Button("Clear") { viewModel.clear() }
        .buttonStyle(GlassButtonStyle())
        .disabled(!viewModel.hasSavedKey)
      Button("Save") { viewModel.save() }
        .buttonStyle(PrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)
    }
  }

  private var modelSection: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("Models")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(DarkPalette.textPrimary)
          Text("Leave blank to use open42 defaults.")
            .font(.system(size: 12))
            .foregroundStyle(DarkPalette.textSecondary)
        }
        Spacer()
        Button("Save Models") { viewModel.saveModels() }
          .buttonStyle(GlassButtonStyle())
      }

      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
        modelField("Planner", text: $viewModel.plannerModel)
        modelField("Verifier", text: $viewModel.verifierModel)
        modelField("Result", text: $viewModel.resultModel)
        modelField("Compile", text: $viewModel.compileModel)
      }
    }
    .padding(18)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(DarkPalette.rowFill)
        .background(
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(.ultraThinMaterial)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
    )
    .shadow(color: DarkPalette.cardShadow, radius: 18, x: 0, y: 8)
  }

  private func modelField(_ title: String, text: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(DarkPalette.textTertiary)
      TextField("Default", text: text)
        .textFieldStyle(.plain)
        .font(.system(size: 13))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(DarkPalette.rowFill)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
        )
    }
  }

  private var providerBinding: Binding<Open42Provider> {
    Binding(
      get: { viewModel.provider },
      set: { viewModel.selectProvider($0) }
    )
  }
}

enum Open42Provider: String, CaseIterable, Identifiable {
  case anthropic
  case openai

  var id: String { rawValue }

  var title: String {
    switch self {
    case .anthropic: return "Anthropic"
    case .openai: return "OpenAI"
    }
  }

  var envKeyName: String {
    switch self {
    case .anthropic: return "ANTHROPIC_API_KEY"
    case .openai: return "OPENAI_API_KEY"
    }
  }
}

enum Open42SettingsStore {
  static func provider() -> Open42Provider {
    guard
      let data = try? Data(contentsOf: settingsURL()),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let raw = object["provider"] as? String,
      let provider = Open42Provider(rawValue: raw)
    else {
      return .anthropic
    }
    return provider
  }

  static func saveProvider(_ provider: Open42Provider) {
    let url = settingsURL()
    var object = readObject()
    object["provider"] = provider.rawValue
    writeObject(object, to: url)
  }

  static func models() -> [String: String] {
    guard let raw = readObject()["models"] as? [String: Any] else { return [:] }
    var result: [String: String] = [:]
    for role in ["planner", "verifier", "result", "compile"] {
      if let value = raw[role] as? String, !value.isEmpty {
        result[role] = value
      }
    }
    return result
  }

  static func saveModel(_ role: String, _ model: String) {
    var object = readObject()
    var models = object["models"] as? [String: String] ?? [:]
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      models.removeValue(forKey: role)
    } else {
      models[role] = trimmed
    }
    object["models"] = models.isEmpty ? nil : models
    writeObject(object, to: settingsURL())
  }

  private static func readObject() -> [String: Any] {
    let url = settingsURL()
    guard
      let data = try? Data(contentsOf: url),
      let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return [:]
    }
    return existing
  }

  private static func writeObject(_ object: [String: Any], to url: URL) {
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
      try data.write(to: url, options: .atomic)
    } catch {
      NSSound.beep()
    }
  }

  private static func settingsURL() -> URL {
    let env = ProcessInfo.processInfo.environment
    if let home = env["OPEN42_HOME"], !home.isEmpty {
      return URL(fileURLWithPath: (home as NSString).expandingTildeInPath)
        .appendingPathComponent("settings.json")
    }
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".open42")
      .appendingPathComponent("settings.json")
  }
}

enum Open42Keychain {
  private static let service = "dev.open42.anthropic"
  private static let account = "ANTHROPIC_API_KEY"

  static func apiKey(provider: Open42Provider) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: serviceName(provider),
      kSecAttrAccount as String: accountName(provider),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func saveApiKey(_ value: String, provider: Open42Provider) -> Bool {
    deleteApiKey(provider: provider)
    guard let data = value.data(using: .utf8) else { return false }
    let attributes: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: serviceName(provider),
      kSecAttrAccount as String: accountName(provider),
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
  }

  static func deleteApiKey(provider: Open42Provider) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: serviceName(provider),
      kSecAttrAccount as String: accountName(provider),
    ]
    SecItemDelete(query as CFDictionary)
  }

  static func mask(_ value: String) -> String {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return ""
    }
    return String(repeating: "*", count: min(max(value.count, 12), 32))
  }

  private static func serviceName(_ provider: Open42Provider) -> String {
    switch provider {
    case .anthropic: return service
    case .openai: return "dev.open42.openai"
    }
  }

  private static func accountName(_ provider: Open42Provider) -> String {
    switch provider {
    case .anthropic: return account
    case .openai: return "OPENAI_API_KEY"
    }
  }
}
