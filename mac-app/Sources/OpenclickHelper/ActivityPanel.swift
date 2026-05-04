import AppKit
import SwiftUI

enum ActivityStepState {
  case completed
  case active
  case pending
  case warning

  var animationKey: String {
    switch self {
    case .completed: return "completed"
    case .active: return "active"
    case .pending: return "pending"
    case .warning: return "warning"
    }
  }
}

struct ActivityStep: Identifiable {
  let id: UUID
  let title: String
  let description: String?
  var state: ActivityStepState
  var timestamp: String?
  let detailLogStartIndex: Int

  init(
    id: UUID = UUID(),
    title: String,
    description: String?,
    state: ActivityStepState,
    timestamp: String?,
    detailLogStartIndex: Int = 0
  ) {
    self.id = id
    self.title = title
    self.description = description
    self.state = state
    self.timestamp = timestamp
    self.detailLogStartIndex = detailLogStartIndex
  }
}

struct ActivityLogEntry: Identifiable {
  let id = UUID()
  let time: String
  let message: String
}

struct ActivityResult {
  let kind: String
  let title: String
  let body: String
}

enum ActivityCardSlot: String {
  case previous
  case current
  case next
}

struct ActivityActionCardModel: Identifiable {
  let id: String
  let slot: ActivityCardSlot
  let title: String
  let description: String?
  let context: String?
  let timestamp: String?
  let state: ActivityStepState
  let isPlaceholder: Bool
  let detailEntries: [ActivityLogEntry]
}

struct ActivityActionCardSnapshot {
  let previous: ActivityActionCardModel
  let current: ActivityActionCardModel
  let next: ActivityActionCardModel

  var items: [ActivityActionCardModel] {
    [previous, current, next]
  }

  var animationKey: String {
    items
      .map { "\($0.slot.rawValue):\($0.id):\($0.title):\($0.state.animationKey)" }
      .joined(separator: "|")
  }
}

struct InterventionIssue {
  let title: String
  let description: String
  let stepTitle: String
  let bundleId: String?
  let appName: String?
  let reasonType: String?

  init(
    title: String,
    description: String,
    stepTitle: String,
    bundleId: String? = nil,
    appName: String? = nil,
    reasonType: String? = nil
  ) {
    self.title = title
    self.description = description
    self.stepTitle = stepTitle
    self.bundleId = bundleId
    self.appName = appName
    self.reasonType = reasonType
  }
}

enum TaskActivityMode {
  case running
  case interventionNeeded(issue: InterventionIssue)
  case userTakeover(issue: InterventionIssue, recordingStartedAt: Date)
  case takeoverFeedback(issue: InterventionIssue, elapsed: String)
  case resuming
  case completed
  case failed
}

@MainActor
final class ActivityPanelViewModel: ObservableObject {
  @Published var task: String = ""
  @Published var currentAction: String = "Reading your request and getting ready."
  @Published var currentPhase: String = "Understanding"
  @Published var elapsedLabel: String = "now"
  @Published var steps: [ActivityStep] = []
  @Published var logs: [ActivityLogEntry] = []
  @Published var detailsExpanded: Bool = false
  @Published var isFinished: Bool = false
  @Published var hasWarning: Bool = false
  @Published var mode: TaskActivityMode = .running
  @Published var takeoverElapsedLabel: String = "00:00"
  @Published var result: ActivityResult?

  var onHide: (() -> Void)?
  var onStop: (() -> Void)?
  var onOpenPermissions: (() -> Void)?
  var onTakeoverStarted: ((InterventionIssue) -> Void)?
  var onTakeoverStopped: (() -> String?)?
  var onTakeoverFinished: ((InterventionIssue, String, Bool, String?) -> Void)?

  private var startedAt = Date()
  private var takeoverTimer: Timer?
  private var takeoverTrajectoryPath: String?
  private var hasStartedActing = false

  func start(task: String) {
    self.task = task
    currentPhase = "Understanding"
    currentAction = "Reading your request and getting ready."
    elapsedLabel = "now"
    detailsExpanded = false
    isFinished = false
    hasWarning = false
    mode = .running
    takeoverElapsedLabel = "00:00"
    result = nil
    takeoverTrajectoryPath = nil
    hasStartedActing = false
    takeoverTimer?.invalidate()
    takeoverTimer = nil
    startedAt = Date()
    logs = []
    steps = [
      ActivityStep(
        title: "Understanding request",
        description: task,
        state: .active,
        timestamp: "now",
        detailLogStartIndex: 0
      ),
    ]
    appendLog("Task: \(task)")
  }

  func appendLog(_ message: String) {
    logs.append(ActivityLogEntry(time: Self.timeFormatter.string(from: Date()), message: message))
    updateElapsed()
  }

  func applyEvent(phase: String, detail: String, timeline: String) {
    if blocksRoutineActivityUpdates {
      appendLog(timeline)
      return
    }
    currentPhase = phase
    currentAction = detail
    appendLog(timeline)
    updateStep(for: phase, detail: detail, timeline: timeline)
  }

  func markWarning(_ message: String) {
    ensureStepExists()
    hasWarning = true
    currentPhase = "Issue"
    currentAction = message
    appendLog(message)
    let index = activeIndex()
    setActiveStep(index: index, state: .warning, description: message)
    let issue = InterventionIssue(
      title: titleForIssue(message),
      description: message,
      stepTitle: steps.indices.contains(index) ? steps[index].title : "Current step"
    )
    if case .interventionNeeded = mode {
      mode = .interventionNeeded(issue: issue)
    }
  }

  func markIntervention(issue: InterventionIssue, reason: String) {
    ensureStepExists()
    hasWarning = true
    currentPhase = "Issue"
    currentAction = issue.description
    appendLog("Intervention needed: \(reason)")
    let index = activeIndex()
    setActiveStep(index: index, state: .warning, description: issue.description)
    mode = .interventionNeeded(issue: issue)
  }

  func markResult(kind: String, title: String, body: String) {
    let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleanBody.isEmpty else { return }
    result = ActivityResult(
      kind: kind == "answer" ? "answer" : "confirmation",
      title: cleanTitle.isEmpty ? (kind == "answer" ? "Result" : "Done") : cleanTitle,
      body: cleanBody
    )
    hasWarning = false
    currentPhase = kind == "answer" ? "Result" : "Complete"
    currentAction = cleanBody
    completeActiveSteps()
    beginCheckpoint(
      title: kind == "answer" ? "Prepared result" : "Task completed",
      description: cleanTitle.isEmpty ? cleanBody : cleanTitle,
      reuseActiveTitle: true
    )
    if let result {
      appendLog("\(result.title): \(result.body)")
    }
  }

  func finish(exitCode: Int) {
    isFinished = true
    takeoverTimer?.invalidate()
    takeoverTimer = nil
    if exitCode == 0 {
      mode = .completed
      currentPhase = "Complete"
      if result == nil {
        markResult(
          kind: "confirmation",
          title: "Done",
          body: "I have done what you asked."
        )
      } else {
        currentAction = result?.body ?? "I have done what you asked."
      }
      completeThrough(index: steps.count - 1)
      if !steps.isEmpty {
        steps[steps.count - 1].state = .completed
        steps[steps.count - 1].timestamp = elapsedLabel
      }
      appendLog("Finished.")
    } else {
      mode = .failed
      hasWarning = true
      currentPhase = "Issue"
      currentAction = "The runner stopped before completing the task."
      setActiveStep(index: activeIndex(), state: .warning, description: "Stopped with status \(exitCode)")
      appendLog("Stopped with status \(exitCode).")
    }
  }

  func requestTakeover() {
    let wasRecording: Bool = {
      if case .userTakeover = mode { return true }
      return false
    }()
    let issue: InterventionIssue
    switch mode {
    case .interventionNeeded(let existing), .userTakeover(let existing, _), .takeoverFeedback(let existing, _):
      issue = existing
    default:
      ensureStepExists()
      let index = activeIndex()
      issue = InterventionIssue(
        title: "Manual judgement needed",
        description: "Take over with your mouse and keyboard to complete this step.",
        stepTitle: steps.indices.contains(index) ? steps[index].title : "Current step"
      )
      setActiveStep(index: index, state: .warning, description: issue.description)
    }
    hasWarning = true
    if wasRecording {
      takeoverTrajectoryPath = onTakeoverStopped?()
    }
    mode = .interventionNeeded(issue: issue)
    currentPhase = "Issue"
    currentAction = issue.description
    appendLog("Takeover requested: \(issue.description)")
  }

  func beginTakeover() {
    let issue: InterventionIssue
    switch mode {
    case .interventionNeeded(let existing), .userTakeover(let existing, _), .takeoverFeedback(let existing, _):
      issue = existing
    default:
      ensureStepExists()
      issue = InterventionIssue(
        title: "Manual judgement needed",
        description: "Use your mouse and keyboard to complete the blocked step.",
        stepTitle: steps.indices.contains(activeIndex()) ? steps[activeIndex()].title : "Current step"
      )
    }
    let startedAt = Date()
    mode = .userTakeover(issue: issue, recordingStartedAt: startedAt)
    currentPhase = "Takeover"
    currentAction = "You are in control. I’m watching and learning from your actions."
    takeoverElapsedLabel = "00:00"
    takeoverTrajectoryPath = nil
    appendLog("User takeover started.")
    onTakeoverStarted?(issue)
    takeoverTimer?.invalidate()
    takeoverTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let viewModel = self else { return }
      Task { @MainActor [viewModel, startedAt] in
        viewModel.updateTakeoverElapsed(startedAt: startedAt)
      }
    }
  }

  func finishTakeover() {
    let takeoverIssue: InterventionIssue? = {
      if case .userTakeover(let issue, _) = mode { return issue }
      return nil
    }()
    takeoverTimer?.invalidate()
    takeoverTimer = nil
    takeoverTrajectoryPath = onTakeoverStopped?()
    if let takeoverIssue {
      mode = .takeoverFeedback(issue: takeoverIssue, elapsed: takeoverElapsedLabel)
      currentPhase = "Confirming"
      currentAction = "Did that complete the blocked step?"
      appendLog("User takeover finished. Waiting for confirmation.")
    } else {
      submitTakeoverFeedback(success: true)
    }
  }

  func submitTakeoverFeedback(success: Bool) {
    let takeoverIssue: InterventionIssue? = {
      if case .takeoverFeedback(let issue, _) = mode { return issue }
      if case .userTakeover(let issue, _) = mode { return issue }
      return nil
    }()
    takeoverTimer?.invalidate()
    takeoverTimer = nil
    let summary = success
      ? "The user manually completed the blocked step with mouse and keyboard during takeover."
      : "The user took over, but the blocked step was not resolved yet."
    if let takeoverIssue {
      onTakeoverFinished?(takeoverIssue, summary, success, takeoverTrajectoryPath)
    }
    if !success {
      if let takeoverIssue {
        mode = .interventionNeeded(issue: takeoverIssue)
      }
      hasWarning = true
      currentPhase = "Issue"
      currentAction = "The step still needs attention."
      appendLog("Takeover did not resolve the blocked step.")
      return
    }

    mode = .resuming
    currentPhase = "Resuming"
    currentAction = "Thanks. I’m using what you did to continue the task."
    hasWarning = false
    appendLog("User takeover confirmed. Resuming task.")
    let index = activeIndex()
    if steps.indices.contains(index) {
      steps[index].state = .completed
      steps[index].timestamp = elapsedString()
    }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 900_000_000)
      if case .resuming = mode {
        mode = .running
        beginCheckpoint(
          title: "Continuing task",
          description: "Continuing from your demonstration"
        )
        currentPhase = "Acting"
        currentAction = "Continuing from your demonstration."
      }
    }
  }

  private func updateStep(for phase: String, detail: String, timeline: String) {
    switch phase {
    case "Understanding":
      updateCurrentStep(
        title: "Understanding request",
        description: detail,
        state: .active
      )
    case "Looking":
      beginCheckpoint(
        title: hasStartedActing ? "Checking current state" : "Reading current state",
        description: detail,
        reuseActiveTitle: true
      )
    case "Planning":
      beginCheckpoint(
        title: hasStartedActing ? "Preparing next step" : "Planning next actions",
        description: detail,
        reuseActiveTitle: true
      )
    case "Adjusting":
      hasStartedActing = true
      beginCheckpoint(
        title: "Changing strategy",
        description: detail,
        reuseActiveTitle: true
      )
    case "Acting":
      hasStartedActing = true
      beginCheckpoint(
        title: checkpointTitle(from: timeline, fallback: detail),
        description: checkpointDescription(from: detail, title: timeline),
        reuseActiveTitle: false
      )
    case "Checking":
      hasStartedActing = true
      beginCheckpoint(
        title: "Checking result",
        description: detail,
        reuseActiveTitle: true
      )
    case "Complete":
      completeThrough(index: steps.count - 1)
    case "Issue":
      setActiveStep(index: activeIndex(), state: .warning, description: detail)
    default:
      setActiveStep(index: activeIndex(), description: detail)
    }
  }

  private func setActiveStep(index: Int, state: ActivityStepState = .active, description: String? = nil) {
    guard steps.indices.contains(index) else { return }
    for i in steps.indices {
      if i < index, steps[i].state != .completed {
        steps[i].state = .completed
        steps[i].timestamp = elapsedString()
      } else if i == index {
        steps[i].state = state
        steps[i].timestamp = state == .pending ? "Waiting to start" : "now"
        if let description {
          steps[i] = ActivityStep(
            id: steps[i].id,
            title: steps[i].title,
            description: description,
            state: steps[i].state,
            timestamp: steps[i].timestamp,
            detailLogStartIndex: steps[i].detailLogStartIndex
          )
        }
      } else if i > index, steps[i].state != .completed {
        steps[i].state = .pending
        steps[i].timestamp = "Waiting to start"
      }
    }
  }

  private func completeThrough(index: Int) {
    guard index >= 0 else { return }
    for i in steps.indices where i <= index {
      steps[i].state = .completed
      steps[i].timestamp = elapsedString()
    }
  }

  private func activeIndex() -> Int {
    steps.lastIndex { step in
      if case .active = step.state { return true }
      if case .warning = step.state { return true }
      return false
    } ?? (steps.indices.last ?? 0)
  }

  private var blocksRoutineActivityUpdates: Bool {
    if case .interventionNeeded = mode { return true }
    if case .userTakeover = mode { return true }
    if case .takeoverFeedback = mode { return true }
    return false
  }

  private func ensureStepExists() {
    if steps.isEmpty {
      steps.append(
        ActivityStep(
          title: "Working on task",
          description: task.isEmpty ? nil : task,
          state: .active,
          timestamp: "now",
          detailLogStartIndex: currentLogStartIndex()
        )
      )
    }
  }

  private func beginCheckpoint(title: String, description: String?, reuseActiveTitle: Bool = false) {
    let cleanTitle = normalizedStepTitle(title)
    let cleanDescription = normalizedStepDescription(description, title: cleanTitle)

    if steps.isEmpty {
      steps.append(
        ActivityStep(
          title: cleanTitle,
          description: cleanDescription,
          state: .active,
          timestamp: "now",
          detailLogStartIndex: currentLogStartIndex()
        )
      )
      return
    }

    if let lastIndex = steps.indices.last,
       steps[lastIndex].title == cleanTitle,
       (reuseActiveTitle || steps[lastIndex].state == .active) {
      steps[lastIndex] = ActivityStep(
        id: steps[lastIndex].id,
        title: cleanTitle,
        description: cleanDescription,
        state: .active,
        timestamp: "now",
        detailLogStartIndex: steps[lastIndex].detailLogStartIndex
      )
      return
    }

    completeActiveSteps()
    steps.append(
      ActivityStep(
        title: cleanTitle,
        description: cleanDescription,
        state: .active,
        timestamp: "now",
        detailLogStartIndex: currentLogStartIndex()
      )
    )
  }

  private func updateCurrentStep(title: String, description: String?, state: ActivityStepState) {
    let cleanTitle = normalizedStepTitle(title)
    let cleanDescription = normalizedStepDescription(description, title: cleanTitle)
    guard let lastIndex = steps.indices.last else {
      steps.append(
        ActivityStep(
          title: cleanTitle,
          description: cleanDescription,
          state: state,
          timestamp: "now",
          detailLogStartIndex: currentLogStartIndex()
        )
      )
      return
    }
    steps[lastIndex] = ActivityStep(
      id: steps[lastIndex].id,
      title: cleanTitle,
      description: cleanDescription,
      state: state,
      timestamp: state == .pending ? "Waiting to start" : "now",
      detailLogStartIndex: steps[lastIndex].detailLogStartIndex
    )
  }

  private func completeActiveSteps() {
    for i in steps.indices where steps[i].state == .active {
      steps[i].state = .completed
      steps[i].timestamp = elapsedString()
    }
  }

  private func checkpointTitle(from text: String, fallback: String) -> String {
    let clean = normalizedStepTitle(text.isEmpty ? fallback : text)
    if clean.count <= 64 { return clean }
    return String(clean.prefix(61)) + "..."
  }

  private func checkpointDescription(from detail: String, title: String) -> String? {
    let cleanDetail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
    if cleanDetail.isEmpty || cleanDetail == title {
      return nil
    }
    return cleanDetail
  }

  private func normalizedStepTitle(_ title: String) -> String {
    let clean = title
      .replacingOccurrences(of: "[openclick]", with: "")
      .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
    return clean.isEmpty ? "Working on next step" : clean
  }

  private func normalizedStepDescription(_ description: String?, title: String) -> String? {
    guard let description else { return nil }
    let clean = description.trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.isEmpty || clean == title { return nil }
    return clean
  }

  private func updateElapsed() {
    elapsedLabel = elapsedString()
  }

  private func elapsedString() -> String {
    let seconds = max(0, Int(Date().timeIntervalSince(startedAt)))
    if seconds < 1 { return "now" }
    if seconds < 60 { return "\(seconds)s" }
    return "\(seconds / 60)m \(seconds % 60)s"
  }

  private func updateTakeoverElapsed(startedAt: Date) {
    let seconds = max(0, Int(Date().timeIntervalSince(startedAt)))
    takeoverElapsedLabel = String(format: "%02d:%02d", seconds / 60, seconds % 60)
  }

  private func titleForIssue(_ message: String) -> String {
    let lower = message.lowercased()
    if lower.contains("permission") || lower.contains("accessibility") || lower.contains("screen recording") {
      return "Permission prompt is blocking progress"
    }
    if lower.contains("foreground") || lower.contains("shared-seat") {
      return "This step needs your judgement"
    }
    if lower.contains("failed") || lower.contains("retry") || lower.contains("not found") {
      return "I couldn’t complete this step safely"
    }
    return "I need your help with this step"
  }

  var actionCards: ActivityActionCardSnapshot {
    let currentIndex = visualCurrentIndex()
    let previous = previousCard(before: currentIndex)
    let current = currentCard(at: currentIndex)
    let next = nextCard(after: currentIndex)
    return ActivityActionCardSnapshot(previous: previous, current: current, next: next)
  }

  private func visualCurrentIndex() -> Int? {
    guard !steps.isEmpty else { return nil }
    if result != nil || isFinished {
      return steps.indices.last
    }
    if let index = steps.lastIndex(where: { step in
      step.state == .active || step.state == .warning
    }) {
      return index
    }
    if let index = steps.lastIndex(where: { $0.state == .pending }) {
      return index
    }
    return steps.indices.last
  }

  private func previousCard(before currentIndex: Int?) -> ActivityActionCardModel {
    guard let currentIndex, currentIndex > steps.startIndex else {
      return placeholderCard(
        id: "previous-placeholder",
        slot: .previous,
        title: "No previous action yet",
        description: "The first completed action will appear here.",
        timestamp: nil,
        state: .pending
      )
    }

    if let match = steps.enumerated().reversed().first(where: { index, step in
      index < currentIndex && step.state == .completed
    }) {
      return cardModel(from: match.element, slot: .previous)
    }

    return placeholderCard(
      id: "previous-placeholder",
      slot: .previous,
      title: "No previous action yet",
      description: "The first completed action will appear here.",
      timestamp: nil,
      state: .pending
    )
  }

  private func currentCard(at currentIndex: Int?) -> ActivityActionCardModel {
    let baseStep: ActivityStep? = {
      guard let currentIndex, steps.indices.contains(currentIndex) else { return nil }
      return steps[currentIndex]
    }()

    switch mode {
    case .interventionNeeded(let issue):
      return issueCard(
        id: baseStep?.id.uuidString ?? "current-intervention",
        issue: issue,
        title: issue.stepTitle.isEmpty ? issue.title : issue.stepTitle,
        timestamp: "Now",
        state: .warning
      )
    case .userTakeover(let issue, _):
      return issueCard(
        id: baseStep?.id.uuidString ?? "current-takeover",
        issue: issue,
        title: "You are in control",
        timestamp: takeoverElapsedLabel,
        state: .active
      )
    case .takeoverFeedback(let issue, let elapsed):
      return issueCard(
        id: baseStep?.id.uuidString ?? "current-takeover-feedback",
        issue: issue,
        title: "Ready to continue?",
        timestamp: elapsed,
        state: .active
      )
    case .resuming:
      return ActivityActionCardModel(
        id: baseStep?.id.uuidString ?? "current-resuming",
        slot: .current,
        title: "Continuing task",
        description: "Using your takeover to continue from the next safe step.",
        context: nil,
        timestamp: "Now",
        state: .active,
        isPlaceholder: false,
        detailEntries: baseStep.map { detailEntries(for: $0) } ?? Array(logs.suffix(6))
      )
    case .completed:
      if let result {
        return ActivityActionCardModel(
          id: baseStep?.id.uuidString ?? "current-result",
          slot: .current,
          title: result.title,
          description: result.body,
          context: result.kind == "answer" ? "Result" : "Confirmation",
          timestamp: elapsedLabel,
          state: .completed,
          isPlaceholder: false,
          detailEntries: logs
        )
      }
      return ActivityActionCardModel(
        id: baseStep?.id.uuidString ?? "current-completed",
        slot: .current,
        title: "Task complete",
        description: currentAction,
        context: nil,
        timestamp: elapsedLabel,
        state: .completed,
        isPlaceholder: false,
        detailEntries: logs
      )
    case .failed:
      return ActivityActionCardModel(
        id: baseStep?.id.uuidString ?? "current-failed",
        slot: .current,
        title: baseStep?.title ?? "Task stopped",
        description: currentAction,
        context: "Needs attention",
        timestamp: elapsedLabel,
        state: .warning,
        isPlaceholder: false,
        detailEntries: logs
      )
    case .running:
      if let result {
        return ActivityActionCardModel(
          id: baseStep?.id.uuidString ?? "current-result",
          slot: .current,
          title: result.title,
          description: result.body,
          context: result.kind == "answer" ? "Result" : "Confirmation",
          timestamp: elapsedLabel,
          state: .completed,
          isPlaceholder: false,
          detailEntries: logs
        )
      }
      if let baseStep {
        return cardModel(
          from: baseStep,
          slot: .current,
          descriptionOverride: fallbackDescription(for: baseStep),
          timestampOverride: "Now"
        )
      }
      return placeholderCard(
        id: "current-placeholder",
        slot: .current,
        title: currentPhase,
        description: currentAction,
        timestamp: "Now",
        state: .active
      )
    }
  }

  private func nextCard(after currentIndex: Int?) -> ActivityActionCardModel {
    if let currentIndex, currentIndex + 1 < steps.count,
       let next = steps[(currentIndex + 1)...].first(where: { $0.state != .completed }) {
      return cardModel(from: next, slot: .next)
    }

    switch mode {
    case .interventionNeeded:
      return placeholderCard(
        id: "next-intervention",
        slot: .next,
        title: "Take over, then resume",
        description: "After you complete the blocked step, openclick can continue.",
        timestamp: nil,
        state: .pending
      )
    case .userTakeover:
      return placeholderCard(
        id: "next-user-takeover",
        slot: .next,
        title: "Finish takeover",
        description: "When this step is complete, openclick will save the lesson and resume.",
        timestamp: nil,
        state: .pending
      )
    case .takeoverFeedback:
      return placeholderCard(
        id: "next-takeover-feedback",
        slot: .next,
        title: "Continue task",
        description: "Confirm the step is resolved to move forward.",
        timestamp: nil,
        state: .pending
      )
    case .resuming:
      return placeholderCard(
        id: "next-resuming",
        slot: .next,
        title: "Choose next action",
        description: "Reading the updated screen before acting again.",
        timestamp: nil,
        state: .pending
      )
    case .completed:
      return placeholderCard(
        id: "next-completed",
        slot: .next,
        title: "No next action",
        description: "The task has finished.",
        timestamp: nil,
        state: .completed
      )
    case .failed:
      return placeholderCard(
        id: "next-failed",
        slot: .next,
        title: "Review details",
        description: "Open the details log to inspect what happened.",
        timestamp: nil,
        state: .pending
      )
    case .running:
      return placeholderCard(
        id: "next-placeholder",
        slot: .next,
        title: "Waiting for next action",
        description: "The next card will update as soon as openclick chooses the next step.",
        timestamp: nil,
        state: .pending
      )
    }
  }

  private func cardModel(
    from step: ActivityStep,
    slot: ActivityCardSlot,
    descriptionOverride: String? = nil,
    timestampOverride: String? = nil
  ) -> ActivityActionCardModel {
    ActivityActionCardModel(
      id: step.id.uuidString,
      slot: slot,
      title: step.title,
      description: descriptionOverride ?? step.description,
      context: nil,
      timestamp: timestamp(for: step, slot: slot, override: timestampOverride),
      state: step.state,
      isPlaceholder: false,
      detailEntries: detailEntries(for: step)
    )
  }

  private func issueCard(
    id: String,
    issue: InterventionIssue,
    title: String,
    timestamp: String?,
    state: ActivityStepState
  ) -> ActivityActionCardModel {
    ActivityActionCardModel(
      id: id,
      slot: .current,
      title: title,
      description: issue.description,
      context: issue.title,
      timestamp: timestamp,
      state: state,
      isPlaceholder: false,
      detailEntries: detailEntries(forStepId: id)
    )
  }

  private func placeholderCard(
    id: String,
    slot: ActivityCardSlot,
    title: String,
    description: String?,
    timestamp: String?,
    state: ActivityStepState
  ) -> ActivityActionCardModel {
    ActivityActionCardModel(
      id: id,
      slot: slot,
      title: title,
      description: description,
      context: nil,
      timestamp: timestamp,
      state: state,
      isPlaceholder: true,
      detailEntries: []
    )
  }

  private func fallbackDescription(for step: ActivityStep) -> String? {
    if let description = step.description, !description.isEmpty {
      return description
    }
    let clean = currentAction.trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.isEmpty || clean == step.title {
      return nil
    }
    return clean
  }

  private func currentLogStartIndex() -> Int {
    max(0, logs.count - 1)
  }

  private func detailEntries(for step: ActivityStep) -> [ActivityLogEntry] {
    guard !logs.isEmpty else { return [] }
    let start = max(0, min(step.detailLogStartIndex, logs.count - 1))
    let end = nextDetailBoundary(after: step) ?? logs.count
    guard start < end else { return [] }
    return Array(logs[start..<min(end, logs.count)])
  }

  private func detailEntries(forStepId id: String) -> [ActivityLogEntry] {
    guard let step = steps.first(where: { $0.id.uuidString == id }) else {
      return Array(logs.suffix(6))
    }
    return detailEntries(for: step)
  }

  private func nextDetailBoundary(after step: ActivityStep) -> Int? {
    guard let index = steps.firstIndex(where: { $0.id == step.id }) else { return nil }
    let nextIndex = steps.index(after: index)
    guard steps.indices.contains(nextIndex) else { return nil }
    return steps[nextIndex].detailLogStartIndex
  }

  private func timestamp(for step: ActivityStep, slot: ActivityCardSlot, override: String?) -> String? {
    if let override { return override }
    guard let timestamp = step.timestamp else { return nil }
    switch slot {
    case .previous:
      if timestamp == "now" || timestamp.contains("ago") {
        return timestamp
      }
      return "\(timestamp) ago"
    case .current:
      return "Now"
    case .next:
      return timestamp == "Waiting to start" ? nil : timestamp
    }
  }

  private static let timeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()
}

struct ActivityPanelView: View {
  @ObservedObject var viewModel: ActivityPanelViewModel

  var body: some View {
    VStack(spacing: 18) {
      if !viewModel.isFinished {
        ActivityHeaderView(task: viewModel.task, mode: viewModel.mode)
      }
      if viewModel.isFinished {
        FinalActivityCard(
          result: viewModel.result,
          mode: viewModel.mode,
          task: viewModel.task,
          output: viewModel.currentAction,
          elapsed: viewModel.elapsedLabel,
          logs: viewModel.logs
        )
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      } else {
        ActivityCardStack(
          cards: viewModel.actionCards,
          mode: viewModel.mode,
          detailsExpanded: viewModel.detailsExpanded,
          stopEnabled: true,
          onTakeover: { viewModel.beginTakeover() },
          onCancelTakeover: { viewModel.requestTakeover() },
          onFinishTakeover: { viewModel.finishTakeover() },
          onSubmitTakeoverFeedback: { success in viewModel.submitTakeoverFeedback(success: success) },
          onToggleDetails: {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
              viewModel.detailsExpanded.toggle()
            }
          },
          onStop: { viewModel.onStop?() }
        )
      }
      if viewModel.isFinished {
        ActivityDoneFooter(onHide: { viewModel.onHide?() })
      } else {
        ActivityFooter(
          mode: viewModel.mode,
          detailsExpanded: viewModel.detailsExpanded,
          stopEnabled: true,
          onHide: { viewModel.onHide?() },
          onTakeover: { viewModel.beginTakeover() },
          onCancelTakeover: { viewModel.requestTakeover() },
          onFinishTakeover: { viewModel.finishTakeover() },
          onSubmitTakeoverFeedback: { success in viewModel.submitTakeoverFeedback(success: success) },
          onToggleDetails: {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
              viewModel.detailsExpanded.toggle()
            }
          },
          onStop: { viewModel.onStop?() }
        )
      }
    }
    .padding(8)
    .frame(width: viewModel.isFinished || viewModel.detailsExpanded ? 560 : 460)
    .animation(.spring(response: 0.25, dampingFraction: 0.85), value: viewModel.detailsExpanded)
    .animation(.spring(response: 0.25, dampingFraction: 0.85), value: viewModel.isFinished)
  }
}

struct ActivityHeaderView: View {
  let task: String
  let mode: TaskActivityMode

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      ActivityOrb(isWarning: isIntervention)
      VStack(alignment: .leading, spacing: 6) {
        Text(title)
          .font(.system(size: 20, weight: .bold))
          .foregroundStyle(DarkPalette.textPrimary)
        Text(task.isEmpty ? "Preparing task" : task)
          .font(.system(size: 13.5, weight: .regular))
          .foregroundStyle(DarkPalette.textSecondary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
  }

  private var isIntervention: Bool {
    if case .interventionNeeded = mode { return true }
    if case .userTakeover = mode { return true }
    if case .takeoverFeedback = mode { return true }
    return false
  }

  private var title: String {
    switch mode {
    case .interventionNeeded:
      return "Task needs your help"
    case .userTakeover:
      return "You are in control"
    case .takeoverFeedback:
      return "Ready to continue?"
    case .resuming:
      return "Resuming task"
    case .completed:
      return "Task complete"
    case .failed:
      return "Task needs attention"
    default:
      return "Working on it"
    }
  }
}

struct ActivityOrb: View {
  let isWarning: Bool
  @State private var pulse = false

  var body: some View {
    ZStack {
      Circle()
        .fill(orbPrimary.opacity(0.28))
        .frame(width: 66, height: 66)
        .blur(radius: 10)
        .scaleEffect(pulse ? 1.08 : 0.92)
      Circle()
        .fill(
          RadialGradient(
            colors: [orbPrimary, orbSecondary.opacity(0.72), Color.white.opacity(0.18)],
            center: .center,
            startRadius: 4,
            endRadius: 28
          )
        )
        .frame(width: 54, height: 54)
        .overlay(Circle().strokeBorder(Color.white.opacity(0.55), lineWidth: 1))
        .shadow(color: orbPrimary.opacity(0.35), radius: 16, x: 0, y: 6)
        .scaleEffect(pulse ? 1.05 : 0.95)
        .opacity(pulse ? 0.86 : 1)
      ForEach(0..<5, id: \.self) { index in
        Circle()
          .fill(orbSecondary.opacity(0.55))
          .frame(width: index == 0 ? 7 : 4, height: index == 0 ? 7 : 4)
          .offset(dotOffset(index))
          .blur(radius: index == 0 ? 1 : 0.3)
      }
    }
    .frame(width: 64, height: 64)
    .onAppear {
      withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) {
        pulse = true
      }
    }
  }

  private var orbPrimary: Color { isWarning ? Color(hex: 0xEF4444) : Color(hex: 0x5B8CFF) }
  private var orbSecondary: Color { isWarning ? Color(hex: 0xF97373) : Color(hex: 0x8B5CF6) }

  private func dotOffset(_ index: Int) -> CGSize {
    switch index {
    case 0: return CGSize(width: -4, height: 4)
    case 1: return CGSize(width: -18, height: -10)
    case 2: return CGSize(width: 18, height: 8)
    case 3: return CGSize(width: -20, height: 18)
    default: return CGSize(width: 12, height: -18)
    }
  }
}

struct ActivityCardStack: View {
  let cards: ActivityActionCardSnapshot
  let mode: TaskActivityMode
  let detailsExpanded: Bool
  let stopEnabled: Bool
  let onTakeover: () -> Void
  let onCancelTakeover: () -> Void
  let onFinishTakeover: () -> Void
  let onSubmitTakeoverFeedback: (Bool) -> Void
  let onToggleDetails: () -> Void
  let onStop: () -> Void

  var body: some View {
    VStack(spacing: 10) {
      ForEach(cards.items) { card in
        switch card.slot {
        case .previous:
          PreviousActionCard(card: card)
        case .current:
          CurrentActionCard(
            card: card,
            mode: mode,
            actions: ActivityCardMenuActions(
              detailsExpanded: detailsExpanded,
              stopEnabled: stopEnabled,
              onTakeover: onTakeover,
              onCancelTakeover: onCancelTakeover,
              onFinishTakeover: onFinishTakeover,
              onSubmitTakeoverFeedback: onSubmitTakeoverFeedback,
              onToggleDetails: onToggleDetails,
              onStop: onStop
            )
          )
        case .next:
          NextActionCard(card: card)
        }
      }
    }
    .animation(.spring(response: 0.30, dampingFraction: 0.86), value: cards.animationKey)
  }
}

struct PreviousActionCard: View {
  let card: ActivityActionCardModel

  var body: some View {
    ActivityCardView(card: card, menuActions: nil, mode: nil)
      .scaleEffect(0.96)
      .opacity(card.isPlaceholder ? 0.52 : 0.72)
      .transition(.asymmetric(
        insertion: .move(edge: .top).combined(with: .opacity),
        removal: .move(edge: .top).combined(with: .opacity)
      ))
  }
}

struct CurrentActionCard: View {
  let card: ActivityActionCardModel
  let mode: TaskActivityMode
  let actions: ActivityCardMenuActions

  var body: some View {
    ActivityCardView(card: card, menuActions: actions, mode: mode)
      .scaleEffect(1.025)
      .zIndex(2)
      .transition(.asymmetric(
        insertion: .move(edge: .bottom).combined(with: .opacity),
        removal: .move(edge: .top).combined(with: .opacity)
      ))
  }
}

struct NextActionCard: View {
  let card: ActivityActionCardModel

  var body: some View {
    ActivityCardView(card: card, menuActions: nil, mode: nil)
      .scaleEffect(0.94)
      .opacity(card.isPlaceholder ? 0.46 : 0.58)
      .transition(.asymmetric(
        insertion: .move(edge: .bottom).combined(with: .opacity),
        removal: .move(edge: .bottom).combined(with: .opacity)
      ))
  }
}

struct ActivityCardMenuActions {
  let detailsExpanded: Bool
  let stopEnabled: Bool
  let onTakeover: () -> Void
  let onCancelTakeover: () -> Void
  let onFinishTakeover: () -> Void
  let onSubmitTakeoverFeedback: (Bool) -> Void
  let onToggleDetails: () -> Void
  let onStop: () -> Void
}

struct ActivityCardView: View {
  let card: ActivityActionCardModel
  let menuActions: ActivityCardMenuActions?
  let mode: TaskActivityMode?
  @State private var shimmer = false
  @State private var hovering = false

  var body: some View {
    HStack(alignment: .top, spacing: horizontalSpacing) {
      ActivityCardStatusMark(state: card.state, slot: card.slot)
        .padding(.top, card.slot == .current ? 2 : 0)

      VStack(alignment: .leading, spacing: card.slot == .current ? 10 : 6) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          VStack(alignment: .leading, spacing: 4) {
            Text(eyebrow)
              .font(.system(size: card.slot == .current ? 11.5 : 10.5, weight: .bold))
              .textCase(.uppercase)
              .foregroundStyle(eyebrowColor)
            Text(card.title)
              .font(.system(size: titleSize, weight: titleWeight))
              .foregroundStyle(titleColor)
              .lineLimit(card.slot == .current ? 2 : 1)
              .fixedSize(horizontal: false, vertical: true)
          }

          Spacer(minLength: 8)

          if let timestamp = displayTimestamp {
            Text(timestamp)
              .font(.system(size: 11.5, weight: .semibold))
              .foregroundStyle(timestampColor)
              .lineLimit(1)
          }

          if let menuActions {
            ActivityCardMenu(mode: mode, actions: menuActions)
          }
        }

        if let context = card.context, !context.isEmpty {
          Text(context)
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(contextColor)
            .lineLimit(1)
        }

        if let description = card.description, !description.isEmpty {
          descriptionText(description)
        }

        if card.slot == .current {
          CurrentProgressLine(state: card.state, shimmer: shimmer)
            .padding(.top, 2)
          currentModeSupplement
          if menuActions?.detailsExpanded == true {
            ActionDetailsView(entries: card.detailEntries)
              .transition(.opacity.combined(with: .move(edge: .bottom)))
          }
        }
      }
    }
    .padding(.vertical, verticalPadding)
    .padding(.horizontal, horizontalPadding)
    .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
    .background(cardBackground)
    .overlay(cardBorder)
    .overlay(alignment: .top) {
      if card.slot == .current {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(
            LinearGradient(
              colors: [Color.white.opacity(0.38), Color.clear],
              startPoint: .top,
              endPoint: .bottom
            ),
            lineWidth: 1
          )
          .blendMode(.plusLighter)
          .allowsHitTesting(false)
      }
    }
    .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: shadowY)
    .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    .onHover { hovering = $0 }
    .onAppear {
      syncShimmer()
    }
    .onChange(of: card.slot.rawValue) { _ in
      syncShimmer()
    }
    .onChange(of: card.state.animationKey) { _ in
      syncShimmer()
    }
  }

  private var currentModeSupplement: some View {
    Group {
      if case .interventionNeeded(let issue) = mode {
        InlineActivityGuidance(
          icon: "hand.raised",
          title: "Manual help needed",
          detail: "Take over with mouse and keyboard to complete “\(issue.stepTitle)”."
        )
      } else if case .userTakeover(_, let startedAt) = mode {
        InlineActivityGuidance(
          icon: "record.circle",
          title: "Recording takeover",
          detail: "Use the computer normally. Started \(Self.relativeTime(from: startedAt))."
        )
        InlineActivityGuidance(
          icon: "sparkles",
          title: "Learning locally",
          detail: "openclick will use this demonstration to continue the remaining task."
        )
      } else if case .takeoverFeedback(let issue, let elapsed) = mode {
        InlineActivityGuidance(
          icon: "checkmark.seal",
          title: "Confirm takeover result",
          detail: "Did “\(issue.stepTitle)” complete successfully after \(elapsed)?"
        )
      }
    }
  }

  private var eyebrow: String {
    switch card.slot {
    case .previous: return "Previous"
    case .current:
      if case .interventionNeeded = mode { return "Current issue" }
      if case .userTakeover = mode { return "Takeover active" }
      if case .takeoverFeedback = mode { return "Feedback" }
      return "Current action"
    case .next: return "Next"
    }
  }

  @ViewBuilder
  private func descriptionText(_ description: String) -> some View {
    let text = Text(description)
      .font(.system(size: descriptionSize, weight: .regular))
      .foregroundStyle(descriptionColor)
      .lineLimit(descriptionLineLimit)
      .fixedSize(horizontal: false, vertical: true)

    if card.slot == .current {
      text.textSelection(.enabled)
    } else {
      text
    }
  }

  private var displayTimestamp: String? {
    if card.slot == .current {
      if card.state == .completed {
        return card.timestamp
      }
      if case .userTakeover = mode {
        return card.timestamp
      }
      return "Now"
    }
    return card.timestamp
  }

  private var horizontalSpacing: CGFloat {
    card.slot == .current ? 14 : 12
  }

  private var verticalPadding: CGFloat {
    switch card.slot {
    case .previous: return 12
    case .current: return 17
    case .next: return 11
    }
  }

  private var horizontalPadding: CGFloat {
    card.slot == .current ? 16 : 14
  }

  private var minHeight: CGFloat {
    switch card.slot {
    case .previous: return 72
    case .current: return 116
    case .next: return 68
    }
  }

  private var cornerRadius: CGFloat {
    card.slot == .current ? 22 : 18
  }

  private var titleSize: CGFloat {
    switch card.slot {
    case .previous: return 13.5
    case .current: return 16
    case .next: return 13
    }
  }

  private var descriptionSize: CGFloat {
    card.slot == .current ? 13 : 12.2
  }

  private var titleWeight: Font.Weight {
    card.slot == .current ? .semibold : .semibold
  }

  private var descriptionLineLimit: Int {
    switch card.slot {
    case .previous: return 2
    case .current: return card.state == .completed ? 6 : 3
    case .next: return 2
    }
  }

  private var titleColor: Color {
    if card.isPlaceholder {
      return DarkPalette.textPrimary.opacity(card.slot == .current ? 0.82 : 0.60)
    }
    switch card.state {
    case .completed:
      return card.slot == .current ? DarkPalette.textPrimary : DarkPalette.textPrimary.opacity(0.76)
    case .active, .warning:
      return DarkPalette.textPrimary
    case .pending:
      return DarkPalette.textPrimary.opacity(0.66)
    }
  }

  private var descriptionColor: Color {
    switch card.slot {
    case .current:
      return DarkPalette.textSecondary
    case .previous:
      return DarkPalette.textTertiary
    case .next:
      return DarkPalette.textSecondary.opacity(0.76)
    }
  }

  private var contextColor: Color {
    switch card.state {
    case .warning:
      return DarkPalette.warningText
    case .completed:
      return DarkPalette.grantedText
    default:
      return Color.adaptive(lightHex: 0x2563EB, darkHex: 0x93C5FD)
    }
  }

  private var eyebrowColor: Color {
    switch card.slot {
    case .current:
      return Color.adaptive(lightHex: 0x2563EB, darkHex: 0x93C5FD)
    default:
      return DarkPalette.textTertiary
    }
  }

  private var timestampColor: Color {
    card.slot == .current ? Color.adaptive(lightHex: 0x2563EB, darkHex: 0x93C5FD) : DarkPalette.textTertiary
  }

  @ViewBuilder
  private var cardBackground: some View {
    let radius = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    switch card.slot {
    case .current:
      radius
        .fill(
          Color.adaptive(
            light: NSColor.white.withAlphaComponent(1.0),
            dark: NSColor.fromHex(0x151A24, alpha: hovering ? 0.98 : 0.94)
          )
        )
        .overlay(
          radius.fill(Color.adaptive(
            light: NSColor.fromHex(0x3B82F6, alpha: 0.018),
            dark: NSColor.fromHex(0x3B82F6, alpha: 0.050)
          ))
        )
    case .previous, .next:
      radius
        .fill(DarkPalette.rowFillHover.opacity(hovering ? 0.82 : 0.66))
        .background(.regularMaterial, in: radius)
    }
  }

  @ViewBuilder
  private var cardBorder: some View {
    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      .strokeBorder(card.slot == .current ? DarkPalette.rowBorderHover.opacity(0.62) : DarkPalette.rowBorder.opacity(0.55), lineWidth: 1)
  }

  private var shadowColor: Color {
    card.slot == .current ? DarkPalette.cardShadow : Color.clear
  }

  private var shadowRadius: CGFloat {
    card.slot == .current ? 18 : 0
  }

  private var shadowY: CGFloat {
    card.slot == .current ? 8 : 0
  }

  private static func relativeTime(from date: Date) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 2 { return "now" }
    if seconds < 60 { return "\(seconds)s ago" }
    return "\(seconds / 60)m ago"
  }

  private func syncShimmer() {
    guard card.slot == .current else {
      shimmer = false
      return
    }
    shimmer = false
    withAnimation(.linear(duration: 1.65).repeatForever(autoreverses: false)) {
      shimmer = true
    }
  }
}

struct ActivityCardStatusMark: View {
  let state: ActivityStepState
  let slot: ActivityCardSlot
  @State private var pulse = false

  var body: some View {
    ZStack {
      switch state {
      case .completed:
        Circle()
          .fill(Color.adaptive(lightHex: 0x16A34A, darkHex: 0x22C55E))
          .frame(width: markSize, height: markSize)
        Image(systemName: "checkmark")
          .font(.system(size: iconSize, weight: .bold))
          .foregroundStyle(.white)
      case .active:
        if slot == .current {
          Circle()
            .fill(activeColor.opacity(0.16))
            .frame(width: pulse ? 38 : 28, height: pulse ? 38 : 28)
            .opacity(pulse ? 0.16 : 0.54)
        }
        Circle()
          .fill(activeColor)
          .frame(width: activeDotSize, height: activeDotSize)
          .shadow(color: activeColor.opacity(slot == .current ? 0.38 : 0), radius: 8, x: 0, y: 2)
      case .pending:
        Circle()
          .strokeBorder(DarkPalette.glassBorderStrong.opacity(slot == .next ? 0.85 : 0.58), lineWidth: 2)
          .background(Circle().fill(DarkPalette.rowFill.opacity(0.55)))
          .frame(width: markSize, height: markSize)
      case .warning:
        Circle()
          .fill(Color(hex: 0xF59E0B))
          .frame(width: markSize, height: markSize)
        Image(systemName: "exclamationmark")
          .font(.system(size: iconSize, weight: .bold))
          .foregroundStyle(.white)
      }
    }
    .frame(width: slot == .current ? 38 : 28, height: slot == .current ? 38 : 28)
    .onAppear {
      syncPulse()
    }
    .onChange(of: slot.rawValue) { _ in
      syncPulse()
    }
    .onChange(of: state.animationKey) { _ in
      syncPulse()
    }
  }

  private var activeColor: Color {
    Color.adaptive(lightHex: 0x2563EB, darkHex: 0x60A5FA)
  }

  private var markSize: CGFloat {
    slot == .current ? 28 : 20
  }

  private var activeDotSize: CGFloat {
    slot == .current ? 16 : 12
  }

  private var iconSize: CGFloat {
    slot == .current ? 13 : 10.5
  }

  private func syncPulse() {
    guard slot == .current, state == .active else {
      pulse = false
      return
    }
    pulse = false
    withAnimation(.easeInOut(duration: 1.55).repeatForever(autoreverses: true)) {
      pulse = true
    }
  }
}

struct CurrentProgressLine: View {
  let state: ActivityStepState
  let shimmer: Bool

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .leading) {
        Capsule()
          .fill(DarkPalette.glassBorderStrong.opacity(0.34))
        Capsule()
          .fill(fillColor)
          .frame(width: progressWidth(in: proxy.size.width))
        if state == .active {
          Capsule()
            .fill(
              LinearGradient(
                colors: [.clear, Color.white.opacity(0.48), .clear],
                startPoint: .leading,
                endPoint: .trailing
              )
            )
            .frame(width: max(42, proxy.size.width * 0.22))
            .offset(x: shimmer ? proxy.size.width : -proxy.size.width * 0.28)
        }
      }
    }
    .frame(height: 3)
    .clipShape(Capsule())
  }

  private var fillColor: Color {
    switch state {
    case .completed:
      return Color.adaptive(lightHex: 0x16A34A, darkHex: 0x22C55E)
    case .warning:
      return Color(hex: 0xF59E0B)
    default:
      return Color.adaptive(lightHex: 0x2563EB, darkHex: 0x60A5FA)
    }
  }

  private func progressWidth(in width: CGFloat) -> CGFloat {
    switch state {
    case .completed:
      return width
    case .warning:
      return width * 0.76
    case .pending:
      return width * 0.18
    case .active:
      return width * 0.62
    }
  }
}

struct InlineActivityGuidance: View {
  let icon: String
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: icon)
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(DarkPalette.textTertiary)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(DarkPalette.textSecondary)
        Text(detail)
          .font(.system(size: 11.2))
          .foregroundStyle(DarkPalette.textTertiary)
          .lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .padding(.top, 2)
  }
}

struct ActivityCardMenu: View {
  let mode: TaskActivityMode?
  let actions: ActivityCardMenuActions

  var body: some View {
    Menu {
      switch mode {
      case .interventionNeeded:
        Button("Take over with mouse", action: actions.onTakeover)
        Button(actions.detailsExpanded ? "Hide details" : "Show details", action: actions.onToggleDetails)
        Divider()
        Button("Stop task", action: actions.onStop)
          .disabled(!actions.stopEnabled)
      case .userTakeover:
        Button("Finish takeover", action: actions.onFinishTakeover)
        Button("Cancel takeover", action: actions.onCancelTakeover)
        Button(actions.detailsExpanded ? "Hide details" : "Show details", action: actions.onToggleDetails)
      case .takeoverFeedback:
        Button("Yes, continue") { actions.onSubmitTakeoverFeedback(true) }
        Button("Still stuck") { actions.onSubmitTakeoverFeedback(false) }
        Button(actions.detailsExpanded ? "Hide details" : "Show details", action: actions.onToggleDetails)
      case .completed:
        Button(actions.detailsExpanded ? "Hide details" : "Show details", action: actions.onToggleDetails)
      default:
        Button("Take over with mouse", action: actions.onTakeover)
        Button(actions.detailsExpanded ? "Hide details" : "Show details", action: actions.onToggleDetails)
        Divider()
        Button("Stop task", action: actions.onStop)
          .disabled(!actions.stopEnabled)
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(DarkPalette.textSecondary)
        .frame(width: 28, height: 28)
        .background(
          Circle()
            .fill(DarkPalette.rowFill.opacity(0.72))
        )
        .overlay(
          Circle()
            .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
        )
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
  }
}

struct ActionDetailsView: View {
  let entries: [ActivityLogEntry]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Divider()
        .background(DarkPalette.glassBorder)
      Text("Step details")
        .font(.system(size: 10.5, weight: .bold))
        .textCase(.uppercase)
        .foregroundStyle(DarkPalette.textTertiary)
      InlineLogListView(
        entries: entries,
        emptyMessage: "No runner events for this action yet.",
        maxHeight: 96
      )
    }
    .padding(.top, 2)
  }
}

struct FinalActivityCard: View {
  let result: ActivityResult?
  let mode: TaskActivityMode
  let task: String
  let output: String
  let elapsed: String
  let logs: [ActivityLogEntry]

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top, spacing: 14) {
        ZStack {
          Circle()
            .fill(accent.opacity(0.14))
            .frame(width: 38, height: 38)
          Image(systemName: iconName)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(accent)
        }

        VStack(alignment: .leading, spacing: 5) {
          Text(title)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(DarkPalette.textPrimary)
          Text(task.isEmpty ? "Task finished" : task)
            .font(.system(size: 12.5))
            .foregroundStyle(DarkPalette.textSecondary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 8)

        Text(elapsed)
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(DarkPalette.textTertiary)
      }

      VStack(alignment: .leading, spacing: 8) {
        Text(outputHeader)
          .font(.system(size: 10.5, weight: .bold))
          .textCase(.uppercase)
          .foregroundStyle(DarkPalette.textTertiary)
        ScrollView {
          Text(outputText)
            .font(.system(size: 13.5))
            .foregroundStyle(DarkPalette.textSecondary)
            .lineLimit(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        .frame(maxHeight: 150)
      }

      Divider()
        .background(DarkPalette.glassBorder)

      VStack(alignment: .leading, spacing: 8) {
        Text("Complete log")
          .font(.system(size: 10.5, weight: .bold))
          .textCase(.uppercase)
          .foregroundStyle(DarkPalette.textTertiary)
        InlineLogListView(
          entries: logs,
          emptyMessage: "No log events were captured for this run.",
          maxHeight: 230
        )
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(DarkPalette.rowFillHover.opacity(0.90))
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .strokeBorder(DarkPalette.rowBorderHover.opacity(0.62), lineWidth: 1)
    )
    .shadow(color: DarkPalette.cardShadow, radius: 22, x: 0, y: 10)
  }

  private var title: String {
    if case .failed = mode {
      return "Task stopped"
    }
    return result?.title ?? "Done"
  }

  private var outputHeader: String {
    result?.kind == "answer" ? "Result" : "Output"
  }

  private var outputText: String {
    let clean = (result?.body ?? output).trimmingCharacters(in: .whitespacesAndNewlines)
    return clean.isEmpty ? "I have done what you asked." : clean
  }

  private var iconName: String {
    if case .failed = mode {
      return "exclamationmark.triangle"
    }
    return result?.kind == "answer" ? "text.quote" : "checkmark"
  }

  private var accent: Color {
    if case .failed = mode {
      return Color(hex: 0xF59E0B)
    }
    return result?.kind == "answer"
      ? Color.adaptive(lightHex: 0x2563EB, darkHex: 0x60A5FA)
      : DarkPalette.grantedText
  }
}

struct InlineLogListView: View {
  let entries: [ActivityLogEntry]
  let emptyMessage: String
  let maxHeight: CGFloat

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 7) {
          if entries.isEmpty {
            Text(emptyMessage)
              .font(.system(size: 11.5, weight: .regular))
              .foregroundStyle(DarkPalette.textTertiary)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            ForEach(entries) { entry in
              HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(entry.time)
                  .font(.system(size: 10.5, weight: .regular, design: .monospaced))
                  .foregroundStyle(DarkPalette.textTertiary)
                Text(entry.message)
                  .font(.system(size: 11, weight: .regular, design: .monospaced))
                  .foregroundStyle(DarkPalette.textSecondary)
                  .lineLimit(3)
                  .textSelection(.enabled)
                Spacer(minLength: 0)
              }
              .id(entry.id)
            }
          }
        }
        .padding(.vertical, 1)
      }
      .frame(maxHeight: maxHeight)
      .onChange(of: entries.count) { _ in
        if let last = entries.last {
          withAnimation(.easeOut(duration: 0.16)) {
            proxy.scrollTo(last.id, anchor: .bottom)
          }
        }
      }
    }
  }
}

struct ActivityDoneFooter: View {
  let onHide: () -> Void

  var body: some View {
    HStack {
      Spacer()
      Button("Hide", action: onHide)
        .buttonStyle(ActivitySecondaryButtonStyle())
    }
    .padding(.top, 2)
  }
}

struct ActivityResultView: View {
  let result: ActivityResult

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: result.kind == "answer" ? "text.quote" : "checkmark.seal")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(accent)
          .frame(width: 24, height: 24)
          .background(Circle().fill(accent.opacity(0.14)))
        Text(result.title)
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(DarkPalette.textPrimary)
        Spacer(minLength: 0)
      }
      ScrollView {
        Text(result.body)
          .font(.system(size: 13.5, weight: .regular))
          .foregroundStyle(DarkPalette.textSecondary)
          .lineLimit(nil)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 180)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(DarkPalette.rowFill.opacity(0.88))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
    )
  }

  private var accent: Color {
    result.kind == "answer" ? Color(hex: 0x5B8CFF) : DarkPalette.grantedText
  }
}

struct StatusDot: View {
  let state: ActivityStepState
  @State private var pulse = false

  var body: some View {
    ZStack {
      switch state {
      case .completed:
        Circle()
          .fill(Color.adaptive(lightHex: 0x16A34A, darkHex: 0x22C55E))
          .frame(width: 18, height: 18)
        Image(systemName: "checkmark")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(.white)
      case .active:
        Circle()
          .fill(Color(hex: 0x6B7CFF).opacity(0.20))
          .frame(width: pulse ? 28 : 20, height: pulse ? 28 : 20)
          .opacity(pulse ? 0.08 : 0.42)
        Circle()
          .fill(LinearGradient(colors: [Color(hex: 0x4D8BFF), Color(hex: 0x8B5CF6)], startPoint: .topLeading, endPoint: .bottomTrailing))
          .frame(width: 14, height: 14)
          .shadow(color: Color(hex: 0x6B7CFF).opacity(0.45), radius: 8)
      case .pending:
        Circle()
          .strokeBorder(DarkPalette.glassBorderStrong, lineWidth: 2)
          .background(Circle().fill(DarkPalette.panelFill.opacity(0.5)))
          .frame(width: 18, height: 18)
      case .warning:
        Circle()
          .fill(Color(hex: 0xF59E0B))
          .frame(width: 18, height: 18)
        Image(systemName: "exclamationmark")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(.white)
      }
    }
    .frame(width: 28, height: 28)
    .onAppear {
      if case .active = state {
        withAnimation(.easeInOut(duration: 1.45).repeatForever(autoreverses: true)) {
          pulse = true
        }
      }
    }
  }
}

struct ActivityFooter: View {
  let mode: TaskActivityMode
  let detailsExpanded: Bool
  let stopEnabled: Bool
  let onHide: () -> Void
  let onTakeover: () -> Void
  let onCancelTakeover: () -> Void
  let onFinishTakeover: () -> Void
  let onSubmitTakeoverFeedback: (Bool) -> Void
  let onToggleDetails: () -> Void
  let onStop: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Button("Hide", action: onHide)
        .buttonStyle(ActivitySecondaryButtonStyle())
      Spacer()
      switch mode {
      case .interventionNeeded:
        Button(action: onToggleDetails) {
          Label("Show details", systemImage: "list.bullet.rectangle")
        }
          .buttonStyle(ActivitySecondaryButtonStyle())
        Button("Take over with mouse", action: onTakeover)
          .buttonStyle(ActivityStopButtonStyle())
      case .userTakeover:
        Button("Cancel takeover", action: onCancelTakeover)
          .buttonStyle(ActivitySecondaryButtonStyle())
        Button("Finish takeover", action: onFinishTakeover)
          .buttonStyle(ActivityStopButtonStyle())
      case .takeoverFeedback:
        Button("Still stuck", action: { onSubmitTakeoverFeedback(false) })
          .buttonStyle(ActivitySecondaryButtonStyle())
        Button("Yes, continue", action: { onSubmitTakeoverFeedback(true) })
          .buttonStyle(ActivityStopButtonStyle())
      default:
        Button(action: onToggleDetails) {
          Label(detailsExpanded ? "Hide details" : "Show details", systemImage: detailsExpanded ? "rectangle.compress.vertical" : "list.bullet.rectangle")
        }
          .buttonStyle(ActivitySecondaryButtonStyle())
        Button(action: onStop) {
          Label("Stop task", systemImage: "stop.fill")
        }
          .buttonStyle(ActivityStopButtonStyle())
          .disabled(!stopEnabled)
      }
    }
    .padding(.top, 2)
  }
}

struct InterventionHelpView: View {
  let issue: InterventionIssue
  let isRecording: Bool
  let elapsed: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if isRecording {
        HStack(spacing: 10) {
          StatusDot(state: .warning)
          VStack(alignment: .leading, spacing: 3) {
            Text("You are in control")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(DarkPalette.textPrimary)
            Text("I’m watching and learning from your actions.")
              .font(.system(size: 12.5))
              .foregroundStyle(DarkPalette.textSecondary)
          }
          Spacer()
          Text(elapsed ?? "00:00")
            .font(.system(size: 13, weight: .medium, design: .monospaced))
            .foregroundStyle(DarkPalette.textSecondary)
        }
      } else {
        VStack(alignment: .leading, spacing: 6) {
          Text("What you can do")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(DarkPalette.textSecondary)
          Text("Take control using your mouse and keyboard to complete this step. I’ll watch, learn, and continue automatically.")
            .font(.system(size: 12.5))
            .foregroundStyle(DarkPalette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      VStack(alignment: .leading, spacing: 9) {
        Label("Use your mouse and keyboard normally", systemImage: "computermouse")
        Label("I’ll learn your actions locally", systemImage: "brain")
        Label("I’ll continue once you finish this step", systemImage: "play.circle")
      }
      .font(.system(size: 11.5, weight: .medium))
      .foregroundStyle(DarkPalette.textTertiary)
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(DarkPalette.rowFill.opacity(0.8))
      )

      Text("Blocked step: \(issue.stepTitle)")
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(DarkPalette.textTertiary)
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(DarkPalette.warningFill.opacity(isRecording ? 0.35 : 0.22))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(DarkPalette.warningBorder.opacity(0.38), lineWidth: 1)
    )
  }
}

struct TakeoverFeedbackView: View {
  let issue: InterventionIssue
  let elapsed: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: "checkmark.seal")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(Color(hex: 0x22C55E))
          .frame(width: 28, height: 28)
          .background(Circle().fill(Color(hex: 0x22C55E).opacity(0.12)))
        VStack(alignment: .leading, spacing: 3) {
          Text("Did that complete the blocked step?")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(DarkPalette.textPrimary)
          Text("Your answer controls whether openclick resumes or keeps waiting for help.")
            .font(.system(size: 12.5))
            .foregroundStyle(DarkPalette.textSecondary)
        }
        Spacer()
        Text(elapsed)
          .font(.system(size: 13, weight: .medium, design: .monospaced))
          .foregroundStyle(DarkPalette.textSecondary)
      }

      Text("Blocked step: \(issue.stepTitle)")
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(DarkPalette.textTertiary)
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(DarkPalette.rowFill.opacity(0.82))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(DarkPalette.rowBorder, lineWidth: 1)
    )
  }
}

struct DetailsLogView: View {
  let entries: [ActivityLogEntry]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Details")
        .font(.system(size: 11, weight: .bold))
        .textCase(.uppercase)
        .foregroundStyle(DarkPalette.textTertiary)
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(entries) { entry in
              HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(entry.time)
                  .font(.system(size: 11, weight: .regular, design: .monospaced))
                  .foregroundStyle(DarkPalette.textTertiary)
                Text(entry.message)
                  .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                  .foregroundStyle(DarkPalette.textSecondary)
                  .lineLimit(2)
                Spacer(minLength: 0)
              }
              .id(entry.id)
            }
          }
          .padding(.vertical, 2)
        }
        .frame(maxHeight: 150)
        .onChange(of: entries.count) { _ in
          if let last = entries.last {
            withAnimation(.easeOut(duration: 0.16)) {
              proxy.scrollTo(last.id, anchor: .bottom)
            }
          }
        }
      }
    }
    .padding(14)
    .background {
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(Color.adaptive(lightHex: 0xF8FAFC, darkHex: 0xFFFFFF, darkOpacity: 0.04))
    }
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(DarkPalette.glassBorder, lineWidth: 1)
    )
  }
}

struct ActivitySecondaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(DarkPalette.textPrimary)
      .padding(.horizontal, 18)
      .frame(height: 38)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(configuration.isPressed ? DarkPalette.rowFillHover : DarkPalette.rowFill)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(DarkPalette.glassBorderStrong, lineWidth: 1)
      )
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
  }
}

struct ActivityStopButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(Color.adaptive(light: .white, dark: NSColor.fromHex(0xFCA5A5)))
      .padding(.horizontal, 22)
      .frame(height: 38)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(
            Color.adaptive(
              light: NSColor.fromHex(0xEF4444, alpha: configuration.isPressed ? 0.88 : 1),
              dark: NSColor.fromHex(0xEF4444, alpha: configuration.isPressed ? 0.26 : 0.18)
            )
          )
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(
            Color.adaptive(light: NSColor.clear, dark: NSColor.fromHex(0xEF4444, alpha: 0.40)),
            lineWidth: 1
          )
      )
      .shadow(color: Color(hex: 0xEF4444).opacity(0.20), radius: 12, x: 0, y: 5)
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
  }
}
