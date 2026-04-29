import AppKit
import SwiftUI

// MARK: - Color helpers

extension Color {
  init(hex: UInt32, opacity: Double = 1.0) {
    let r = Double((hex >> 16) & 0xFF) / 255
    let g = Double((hex >> 8) & 0xFF) / 255
    let b = Double(hex & 0xFF) / 255
    self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
  }

  /// System-adaptive color: picks `light` on light appearance, `dark` on dark.
  /// Updates automatically when the user toggles appearance.
  static func adaptive(light: NSColor, dark: NSColor) -> Color {
    Color(
      NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
        return isDark ? dark : light
      }
    )
  }

  static func adaptive(lightHex: UInt32, lightOpacity: Double = 1, darkHex: UInt32, darkOpacity: Double = 1) -> Color {
    .adaptive(
      light: NSColor.fromHex(lightHex, alpha: lightOpacity),
      dark: NSColor.fromHex(darkHex, alpha: darkOpacity)
    )
  }
}

extension NSColor {
  static func fromHex(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha
    )
  }
}

/// Light + dark palette. Tokens flip based on the system's effective appearance.
/// Light mode is tuned for a Superhuman-style premium liquid-glass feel:
/// soft white surfaces, hairline borders, very gentle shadows, no neumorphism.
enum DarkPalette {
  // Canvas — soft warm/cool gradient in light, deep blue-black in dark
  static let canvasTop = Color.adaptive(
    lightHex: 0xF8FAFF,
    darkHex: 0x080B10
  )
  static let canvasMid = Color.adaptive(
    lightHex: 0xFFFFFF,
    darkHex: 0x0B111C
  )
  static let canvasBot = Color.adaptive(
    lightHex: 0xF3F5FA,
    darkHex: 0x111827
  )

  // Panel surface (window backing + chat-bar pill) — translucent glass
  static let panelFill = Color.adaptive(
    light: NSColor.white.withAlphaComponent(0.82),
    dark: NSColor.fromHex(0x0F121A, alpha: 0.72)
  )

  // Outer panel border + inner top highlight
  static let glassBorder = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.06),
    dark: NSColor.white.withAlphaComponent(0.10)
  )
  static let glassBorderStrong = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.10),
    dark: NSColor.white.withAlphaComponent(0.14)
  )
  static let glassHighlight = Color.adaptive(
    light: NSColor.white.withAlphaComponent(0.75),
    dark: NSColor.white.withAlphaComponent(0.08)
  )

  // Row surface — frosted white in light, dark glass in dark
  static let rowFill = Color.adaptive(
    light: NSColor.white.withAlphaComponent(0.66),
    dark: NSColor.white.withAlphaComponent(0.035)
  )
  static let rowFillHover = Color.adaptive(
    light: NSColor.white.withAlphaComponent(0.92),
    dark: NSColor.white.withAlphaComponent(0.055)
  )
  static let rowBorder = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.045),
    dark: NSColor.white.withAlphaComponent(0.08)
  )
  static let rowBorderHover = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.10),
    dark: NSColor.white.withAlphaComponent(0.14)
  )

  // Text
  static let textPrimary = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.90),
    dark: NSColor.white.withAlphaComponent(0.92)
  )
  static let textSecondary = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.56),
    dark: NSColor.white.withAlphaComponent(0.62)
  )
  static let textTertiary = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.42),
    dark: NSColor.white.withAlphaComponent(0.42)
  )

  // Status badges — explicit pastels in light, translucent tints in dark
  static let grantedFill = Color.adaptive(
    light: NSColor.fromHex(0xECFDF3),
    dark: NSColor(srgbRed: 0.13, green: 0.77, blue: 0.37, alpha: 0.16)
  )
  static let grantedBorder = Color.adaptive(
    light: NSColor.fromHex(0xB7E4C7),
    dark: NSColor(srgbRed: 0.13, green: 0.77, blue: 0.37, alpha: 0.42)
  )
  static let grantedText = Color.adaptive(
    light: NSColor.fromHex(0x15803D),
    dark: NSColor.fromHex(0x86EFAC)
  )

  static let warningFill = Color.adaptive(
    light: NSColor.fromHex(0xFFF7ED),
    dark: NSColor(srgbRed: 0.96, green: 0.62, blue: 0.04, alpha: 0.16)
  )
  static let warningBorder = Color.adaptive(
    light: NSColor.fromHex(0xFDBA74),
    dark: NSColor(srgbRed: 0.96, green: 0.62, blue: 0.04, alpha: 0.42)
  )
  static let warningText = Color.adaptive(
    light: NSColor.fromHex(0xC2410C),
    dark: NSColor.fromHex(0xFDBA74)
  )

  // Ambient glows
  // Light: pale blue/indigo (top-left) + pale peach (bottom-right), 5–8% opacity.
  // Dark: stronger indigo/purple to give the deep canvas atmosphere.
  static let glowBlue = Color.adaptive(
    light: NSColor(srgbRed: 0.42, green: 0.55, blue: 1.0, alpha: 0.07),
    dark: NSColor(srgbRed: 0.31, green: 0.51, blue: 1.0, alpha: 0.10)
  )
  static let glowPurple = Color.adaptive(
    light: NSColor(srgbRed: 1.0, green: 0.78, blue: 0.55, alpha: 0.06),
    dark: NSColor(srgbRed: 0.62, green: 0.43, blue: 1.0, alpha: 0.08)
  )

  // Card shadow — gentle in light, more pronounced in dark
  static let cardShadow = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.08),
    dark: NSColor.black.withAlphaComponent(0.20)
  )

  // Window shadow projected by the rounded panel
  static let windowShadow = Color.adaptive(
    light: NSColor.black.withAlphaComponent(0.10),
    dark: NSColor.black.withAlphaComponent(0.45)
  )

  // Footer dot when items still need attention
  static let attentionDot = Color.adaptive(
    light: NSColor.fromHex(0xF59E0B, alpha: 0.85),
    dark: NSColor.fromHex(0xFDBA74)
  )
}

// MARK: - Permission model

enum PermissionKind: String, CaseIterable, Identifiable {
  case accessibility, screenRecording, cuaDriver, apiKey
  var id: String { rawValue }

  var title: String {
    switch self {
    case .accessibility: return "Accessibility"
    case .screenRecording: return "Screen Recording"
    case .cuaDriver: return "CuaDriver"
    case .apiKey: return "Model API key"
    }
  }

  var defaultDescription: String {
    switch self {
    case .accessibility: return "Lets OpenClick click and type in apps."
    case .screenRecording: return "Lets OpenClick see the screen and verify progress."
    case .cuaDriver: return "The local helper that performs desktop actions."
    case .apiKey: return "Lets OpenClick call your selected model."
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

  var accent: Color {
    switch self {
    case .accessibility: return Color(hex: 0x4D8BFF)
    case .screenRecording: return Color(hex: 0xF97A8B)
    case .cuaDriver: return Color(hex: 0xA78BFA)
    case .apiKey: return Color(hex: 0xF6B266)
    }
  }

  var defaultActionTitle: String {
    switch self {
    case .accessibility, .screenRecording: return "Request Access"
    case .cuaDriver: return ""
    case .apiKey: return ""
    }
  }
}

enum PermissionStatus: Equatable {
  case unknown
  case checking
  case ok
  case missing(reason: String)

  var isOk: Bool { if case .ok = self { return true } else { return false } }
}

struct PermissionItem: Identifiable {
  let id = UUID()
  let kind: PermissionKind
  var description: String
  var status: PermissionStatus
  var actionTitle: String
}

// MARK: - View Models

@MainActor
final class OnboardingViewModel: ObservableObject {
  @Published var items: [PermissionItem]
  @Published var provider: OpenClickProvider = OpenClickSettingsStore.provider()
  @Published var apiKeyDraft: String = ""
  @Published var maskedApiKey: String = "Not set"
  @Published var apiKeySource: String = "Not configured"
  @Published var hasSavedProviderKey: Bool = false
  @Published var footerMessage: String = "Checking permissions…"
  @Published var footerTone: FooterTone = .checking
  @Published var isChecking: Bool = false

  enum FooterTone { case checking, success, warning }

  var onRunCheck: (() -> Void)?
  var onAction: ((PermissionKind) -> Void)?
  var onProviderChanged: ((OpenClickProvider) -> Void)?
  var onSaveApiKey: ((String) -> Void)?
  var onClearApiKey: (() -> Void)?
  var onDone: (() -> Void)?

  init() {
    items = PermissionKind.allCases.map { kind in
      PermissionItem(
        kind: kind,
        description: kind.defaultDescription,
        status: .checking,
        actionTitle: kind.defaultActionTitle
      )
    }
  }

  func update(kind: PermissionKind, status: PermissionStatus, description: String? = nil, actionTitle: String? = nil) {
    guard let idx = items.firstIndex(where: { $0.kind == kind }) else { return }
    items[idx].status = status
    if let description { items[idx].description = description }
    if let actionTitle { items[idx].actionTitle = actionTitle }
  }

  func updateProviderKeyState(provider: OpenClickProvider, masked: String, source: String, saved: Bool) {
    self.provider = provider
    maskedApiKey = masked
    apiKeySource = source
    hasSavedProviderKey = saved
    apiKeyDraft = ""
  }
}

@MainActor
final class CommandBarViewModel: ObservableObject {
  @Published var prompt: String = ""
  @Published var status: String = "Shared-seat background mode"
  @Published var isRunning: Bool = false
  @Published var allowForeground: Bool = false

  var onSubmit: ((String) -> Void)?
  var onCancel: (() -> Void)?
  var onOpenOnboarding: (() -> Void)?
  var onToggleForeground: (() -> Void)?

  func submit() {
    if isRunning {
      onCancel?()
      return
    }
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    onSubmit?(trimmed)
  }
}

// MARK: - Background

struct DarkCanvas: View {
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [DarkPalette.canvasTop, DarkPalette.canvasMid, DarkPalette.canvasBot],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      RadialGradient(
        gradient: Gradient(colors: [DarkPalette.glowBlue, .clear]),
        center: UnitPoint(x: 0.18, y: 0.15),
        startRadius: 0,
        endRadius: 520
      )
      RadialGradient(
        gradient: Gradient(colors: [DarkPalette.glowPurple, .clear]),
        center: UnitPoint(x: 0.85, y: 0.92),
        startRadius: 0,
        endRadius: 520
      )
    }
    .ignoresSafeArea()
  }
}

// MARK: - Reusable surfaces

struct GlassPanel<Content: View>: View {
  var cornerRadius: CGFloat = 28
  @ViewBuilder var content: () -> Content

  var body: some View {
    content()
      .background(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill(DarkPalette.panelFill)
          .background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .fill(.ultraThinMaterial)
          )
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(DarkPalette.glassBorder, lineWidth: 1)
      )
      .overlay(alignment: .top) {
        // Inner highlight ribbon along the top edge.
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
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
      .shadow(color: .black.opacity(0.55), radius: 28, x: 0, y: 14)
  }
}

struct IconBubble: View {
  @Environment(\.colorScheme) private var scheme
  let kind: PermissionKind

  var body: some View {
    let palette = lightPastels(for: kind)
    ZStack {
      Circle()
        .fill(scheme == .dark ? kind.accent.opacity(0.20) : palette.bg)
      // Subtle inner top highlight in light mode for the "frosted glass" feel.
      if scheme == .light {
        Circle()
          .stroke(
            LinearGradient(
              colors: [Color.white.opacity(0.85), Color.white.opacity(0)],
              startPoint: .top,
              endPoint: .bottom
            ),
            lineWidth: 0.8
          )
          .blendMode(.plusLighter)
          .allowsHitTesting(false)
      } else {
        Circle()
          .fill(kind.accent.opacity(0.18))
          .blur(radius: 14)
          .scaleEffect(1.15)
          .blendMode(.plusLighter)
          .allowsHitTesting(false)
      }
      Image(systemName: kind.iconName)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(scheme == .dark ? kind.accent : palette.icon)
    }
    .frame(width: 52, height: 52)
  }

  private func lightPastels(for kind: PermissionKind) -> (bg: Color, icon: Color) {
    switch kind {
    case .accessibility:
      return (Color(hex: 0xEAF1FF), Color(hex: 0x2F6BFF))
    case .screenRecording:
      return (Color(hex: 0xFFF0F2), Color(hex: 0xFF5C7A))
    case .cuaDriver:
      return (Color(hex: 0xF3EDFF), Color(hex: 0x8B5CF6))
    case .apiKey:
      return (Color(hex: 0xFFF4E6), Color(hex: 0xF59E0B))
    }
  }
}

struct StatusBadge: View {
  enum Tone { case granted, warning, neutral }

  let text: String
  let tone: Tone

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: iconName)
        .font(.system(size: 10.5, weight: .bold))
      Text(text)
        .font(.system(size: 12.5, weight: .semibold))
    }
    .padding(.horizontal, 11)
    .padding(.vertical, 5)
    .foregroundStyle(textColor)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(fillColor)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(borderColor, lineWidth: 1)
    )
  }

  private var iconName: String {
    switch tone {
    case .granted: return "checkmark"
    case .warning: return "exclamationmark"
    case .neutral: return "ellipsis"
    }
  }

  private var fillColor: Color {
    switch tone {
    case .granted: return DarkPalette.grantedFill
    case .warning: return DarkPalette.warningFill
    case .neutral: return Color.white.opacity(0.05)
    }
  }

  private var borderColor: Color {
    switch tone {
    case .granted: return DarkPalette.grantedBorder
    case .warning: return DarkPalette.warningBorder
    case .neutral: return Color.white.opacity(0.12)
    }
  }

  private var textColor: Color {
    switch tone {
    case .granted: return DarkPalette.grantedText
    case .warning: return DarkPalette.warningText
    case .neutral: return DarkPalette.textSecondary
    }
  }
}

// MARK: - Button styles

struct GlassButtonStyle: ButtonStyle {
  @Environment(\.colorScheme) private var scheme

  func makeBody(configuration: Configuration) -> some View {
    let isLight = scheme == .light
    let fill: Color = {
      if isLight {
        return Color.white.opacity(configuration.isPressed ? 0.92 : 0.72)
      }
      return configuration.isPressed ? DarkPalette.rowFillHover : DarkPalette.rowFill
    }()
    let border: Color = {
      if isLight {
        return Color.black.opacity(configuration.isPressed ? 0.12 : 0.08)
      }
      return configuration.isPressed ? DarkPalette.rowBorderHover : DarkPalette.rowBorder
    }()
    let textColor: Color = isLight ? Color.black.opacity(0.84) : DarkPalette.textPrimary

    return configuration.label
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(textColor)
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(fill)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .strokeBorder(border, lineWidth: 1)
      )
      .shadow(
        color: isLight ? Color.black.opacity(configuration.isPressed ? 0.03 : 0.06) : .clear,
        radius: isLight ? 12 : 0,
        x: 0,
        y: 5
      )
      .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
      .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
  }
}

struct PrimaryButtonStyle: ButtonStyle {
  @Environment(\.colorScheme) private var scheme

  func makeBody(configuration: Configuration) -> some View {
    let isLight = scheme == .light
    let fill: Color = {
      if isLight {
        // #111 by default, pure black on press, deepens slightly.
        return configuration.isPressed ? Color(hex: 0x000000) : Color(hex: 0x111111)
      }
      return Color.white.opacity(configuration.isPressed ? 0.85 : 0.96)
    }()
    let textColor: Color = isLight ? .white : .black
    let shadowColor: Color = isLight
      ? Color.black.opacity(configuration.isPressed ? 0.16 : 0.22)
      : Color.black.opacity(0.25)

    return configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(textColor)
      .padding(.horizontal, 22)
      .padding(.vertical, 9)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(fill)
      )
      .overlay(alignment: .top) {
        // Subtle glossy top highlight, only visible in light mode (the black button).
        if isLight {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(
              LinearGradient(
                colors: [Color.white.opacity(0.18), .clear],
                startPoint: .top,
                endPoint: .bottom
              ),
              lineWidth: 0.6
            )
            .blendMode(.plusLighter)
            .allowsHitTesting(false)
        }
      }
      .shadow(color: shadowColor, radius: isLight ? 20 : 14, x: 0, y: isLight ? 10 : 6)
      .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
      .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
  }
}

struct CircularSendButtonStyle: ButtonStyle {
  @Environment(\.colorScheme) private var scheme
  var enabled: Bool = true

  func makeBody(configuration: Configuration) -> some View {
    let fillLight = Color.black.opacity(configuration.isPressed ? 0.78 : 0.92)
    let fillDark = Color.white.opacity(configuration.isPressed ? 0.85 : 0.96)
    let textColor: Color = scheme == .dark ? .black : .white
    return configuration.label
      .font(.system(size: 16, weight: .bold))
      .foregroundStyle(textColor)
      .frame(width: 38, height: 38)
      .background(
        Circle()
          .fill(scheme == .dark ? fillDark : fillLight)
      )
      .shadow(color: .black.opacity(0.25), radius: 10, x: 0, y: 4)
      .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
      .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
      .opacity(enabled ? 1 : 0.5)
  }
}

// MARK: - Permission row

struct GlassPermissionRow: View {
  let item: PermissionItem
  let onAction: () -> Void

  @State private var isHovering = false

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      IconBubble(kind: item.kind)
      VStack(alignment: .leading, spacing: 4) {
        Text(item.kind.title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(DarkPalette.textPrimary)
        Text(item.description)
          .font(.system(size: 12.5, weight: .regular))
          .foregroundStyle(DarkPalette.textSecondary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 12)
      statusBadge
      if !item.actionTitle.isEmpty {
        Button(item.actionTitle, action: onAction)
          .buttonStyle(GlassButtonStyle())
      }
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
    .frame(minHeight: 82)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(isHovering ? DarkPalette.rowFillHover : DarkPalette.rowFill)
        .background(
          RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(.ultraThinMaterial)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .strokeBorder(
          isHovering ? DarkPalette.rowBorderHover : DarkPalette.rowBorder,
          lineWidth: 1
        )
    )
    .overlay(alignment: .top) {
      // Inner top highlight: soft white in light, very faint white in dark.
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .stroke(
          LinearGradient(
            colors: [DarkPalette.glassHighlight, .clear],
            startPoint: .top,
            endPoint: .bottom
          ),
          lineWidth: 0.8
        )
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }
    .shadow(color: DarkPalette.cardShadow, radius: 22, x: 0, y: 10)
    .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    .onHover { hovering in
      withAnimation(.easeOut(duration: 0.18)) { isHovering = hovering }
    }
  }

  @ViewBuilder
  private var statusBadge: some View {
    switch item.status {
    case .ok:
      StatusBadge(text: "Granted", tone: .granted)
    case .missing(let reason):
      StatusBadge(text: reason.isEmpty ? "Missing" : reason, tone: .warning)
    case .checking:
      StatusBadge(text: "Checking…", tone: .neutral)
    case .unknown:
      StatusBadge(text: "Unknown", tone: .neutral)
    }
  }
}

// MARK: - Onboarding view

struct OnboardingView: View {
  @ObservedObject var viewModel: OnboardingViewModel

  var body: some View {
    ZStack {
      DarkCanvas()
      VStack(alignment: .leading, spacing: 0) {
        header
          .padding(.top, 48)
          .padding(.horizontal, 32)
          .padding(.bottom, 18)

        providerSetup
          .padding(.horizontal, 28)
          .padding(.bottom, 14)

        VStack(spacing: 13) {
          ForEach(viewModel.items) { item in
            GlassPermissionRow(item: item) {
              viewModel.onAction?(item.kind)
            }
          }
        }
        .padding(.horizontal, 28)

        footer
          .padding(.horizontal, 32)
          .padding(.top, 28)
          .padding(.bottom, 24)
      }
    }
    .overlay(
      RoundedRectangle(cornerRadius: 28, style: .continuous)
        .strokeBorder(DarkPalette.glassBorder, lineWidth: 1)
        .allowsHitTesting(false)
    )
    .overlay(alignment: .top) {
      // Inner top-edge highlight on the panel itself (subtle white in light, very subtle in dark)
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
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Welcome to openclick")
        .font(.system(size: 32, weight: .bold))
        .foregroundStyle(DarkPalette.textPrimary)
      Text("openclick controls your Mac with natural-language prompts.\nGrant these four things once and you’re ready.")
        .font(.system(size: 14, weight: .regular))
        .foregroundStyle(DarkPalette.textSecondary)
        .lineSpacing(3)
    }
  }

  private var providerSetup: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Picker("Provider", selection: providerBinding) {
          ForEach(OpenClickProvider.allCases) { provider in
            Text(provider.title).tag(provider)
          }
        }
        .pickerStyle(.segmented)
        .frame(width: 240)

        VStack(alignment: .leading, spacing: 3) {
          Text("\(viewModel.provider.title) API key")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(DarkPalette.textPrimary)
          Text("\(viewModel.apiKeySource) · \(viewModel.maskedApiKey)")
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(DarkPalette.textTertiary)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
      }

      HStack(spacing: 10) {
        SecureField("Paste \(viewModel.provider.title) API key", text: $viewModel.apiKeyDraft)
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

        Button("Save Key") {
          viewModel.onSaveApiKey?(viewModel.apiKeyDraft)
        }
        .buttonStyle(GlassButtonStyle())
        Button("Clear") { viewModel.onClearApiKey?() }
          .buttonStyle(GlassButtonStyle())
          .disabled(!viewModel.hasSavedProviderKey)
      }
    }
    .padding(16)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(DarkPalette.rowFill)
        .background(
          RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(.ultraThinMaterial)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
    )
    .shadow(color: DarkPalette.cardShadow, radius: 18, x: 0, y: 8)
  }

  private var providerBinding: Binding<OpenClickProvider> {
    Binding(
      get: { viewModel.provider },
      set: { viewModel.onProviderChanged?($0) }
    )
  }

  private var footer: some View {
    HStack(spacing: 12) {
      HStack(spacing: 8) {
        Circle()
          .fill(footerDotColor)
          .frame(width: 7, height: 7)
        Text(viewModel.footerMessage)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(DarkPalette.textTertiary)
      }
      Spacer()
      Button("Run Check Again") { viewModel.onRunCheck?() }
        .buttonStyle(GlassButtonStyle())
        .disabled(viewModel.isChecking)
      Button("Done") { viewModel.onDone?() }
        .buttonStyle(PrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)
    }
  }

  private var footerDotColor: Color {
    switch viewModel.footerTone {
    case .checking: return DarkPalette.textTertiary
    case .success: return DarkPalette.grantedText
    case .warning: return DarkPalette.attentionDot
    }
  }
}

// MARK: - Command bar

struct CommandBarView: View {
  @ObservedObject var viewModel: CommandBarViewModel
  @FocusState private var promptFocused: Bool

  var body: some View {
    HStack(spacing: 14) {
      HStack(spacing: 8) {
        Button {
          viewModel.onOpenOnboarding?()
        } label: {
          Image(systemName: "gearshape")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(DarkPalette.textSecondary)
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .help("Open the openclick permissions panel.")

        Button {
          viewModel.onToggleForeground?()
        } label: {
          Image(systemName: viewModel.allowForeground ? "exclamationmark.shield.fill" : "exclamationmark.shield")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(viewModel.allowForeground ? Color.orange : DarkPalette.textSecondary)
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .help(viewModel.allowForeground
          ? "Foreground control allowed for the next run."
          : "Shared-seat mode. Click to allow foreground control.")
      }

      Capsule()
        .fill(promptFocused ? Color(hex: 0x6B9CFF).opacity(0.75) : DarkPalette.glassBorder)
        .frame(width: 2, height: 28)
        .shadow(color: promptFocused ? Color(hex: 0x6B9CFF).opacity(0.55) : .clear, radius: 4)
        .animation(.easeOut(duration: 0.18), value: promptFocused)

      VStack(alignment: .leading, spacing: 4) {
        TextField("Ask openclick to do anything", text: $viewModel.prompt)
          .textFieldStyle(.plain)
          .font(.system(size: 16, weight: .regular))
          .foregroundStyle(DarkPalette.textPrimary)
          .focused($promptFocused)
          .disabled(viewModel.isRunning)
          .onSubmit { viewModel.submit() }
        Text(viewModel.status)
          .font(.system(size: 11.5, weight: .medium))
          .foregroundStyle(DarkPalette.textTertiary)
          .lineLimit(1)
      }

      Spacer(minLength: 0)

      Button {
        viewModel.submit()
      } label: {
        Image(systemName: viewModel.isRunning ? "stop.fill" : "arrow.up")
      }
      .buttonStyle(CircularSendButtonStyle(enabled: viewModel.isRunning || !viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
      .keyboardShortcut(.defaultAction)
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 18)
    .background {
      Capsule(style: .continuous)
        .fill(.ultraThinMaterial)
        .overlay(Capsule(style: .continuous).fill(DarkPalette.panelFill))
    }
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(DarkPalette.glassBorder, lineWidth: 1)
    )
    .overlay(alignment: .top) {
      Capsule(style: .continuous)
        .stroke(
          LinearGradient(
            colors: [DarkPalette.glassHighlight.opacity(1.2), .clear],
            startPoint: .top,
            endPoint: .bottom
          ),
          lineWidth: 1
        )
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }
    .clipShape(Capsule(style: .continuous))
    .compositingGroup()
    .shadow(color: .black.opacity(0.50), radius: 36, x: 0, y: 14)
    .padding(8)
    .onAppear {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { promptFocused = true }
    }
  }
}
