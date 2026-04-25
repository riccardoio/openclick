/**
 * Single-call plan generation for `showme run --fast`.
 *
 * Instead of round-tripping the Agent SDK per tool call (every click incurs
 * an LLM latency), we ask Sonnet *once* for a complete sequence of
 * cua-driver tool calls grounded in the SKILL.md plus a current-state
 * summary. The local executor then walks the plan offline. Replan happens
 * only when a step fails — see `replanContext` below.
 */
export interface PlanStep {
  /** cua-driver tool name, unprefixed (e.g. "click", "type_text"). */
  tool: string;
  /** JSON args matching cua-driver's tool input schema. */
  args: Record<string, unknown>;
  /** Human-readable summary of WHY this step exists. Surfaced to the user. */
  purpose: string;
}

export interface Plan {
  steps: PlanStep[];
  /** Sentinel describing what "skill satisfied" looks like. */
  stopWhen: string;
}

export interface PlannerClient {
  /**
   * Send the planner prompt to a Claude model and return the raw text reply.
   * Implementations are expected to use Sonnet (cheap, fast, plenty smart
   * enough for tool selection) — Opus is overkill here.
   */
  generatePlanText(prompt: string): Promise<string>;
}

export interface ReplanContext {
  /** 0-based index of the step that failed in the previous plan. */
  failedStepIndex: number;
  failedStep: PlanStep;
  errorMessage: string;
  /**
   * Steps from the previous plan that DID complete before the failure. The
   * planner should treat these as already-applied and produce only the
   * suffix needed to finish the skill — not a fresh start-from-scratch plan.
   */
  executedSteps?: PlanStep[];
  /**
   * Live AX tree snapshot at the failure point. Lets the planner ground its
   * recovery against actual on-screen state instead of guessing from prose.
   */
  liveAxTree?: string;
}

export interface GeneratePlanOptions {
  skillMd: string;
  /** Short text summary of relevant on-screen state at planning time. */
  currentStateSummary: string;
  claudeClient: PlannerClient;
  /** When set, the planner is asked to *replan* from a failure point. */
  replanContext?: ReplanContext;
}

const SYSTEM_GUIDANCE = `You are a planner that converts a recorded macOS skill (SKILL.md) into an executable plan of cua-driver MCP tool calls. Output ONLY a JSON object matching the Plan schema below — no prose, no markdown fences. The local executor will walk your plan step by step without consulting an LLM, so each step must be concrete and executable.

cua-driver tools available:
  - launch_app({ bundle_id?: string, name?: string }) — returns { pid, windows: [{ window_id, ... }] }
  - list_windows({ pid?: integer }) — returns the same per-window shape
  - get_window_state({ pid, window_id }) — refreshes the AX cache; required before element_index clicks
  - click({ pid, window_id, element_index }) OR click({ pid, x, y })
  - double_click({ pid, window_id, element_index }) OR double_click({ pid, x, y })
  - type_text({ pid, text, element_index?, window_id? })
  - press_key({ pid, key, modifiers? })
  - hotkey({ pid, keys: [modifier..., key] })
  - scroll({ pid, direction: up|down|left|right, amount?, by?, element_index?, window_id? })
  - assert({ kind: "ax_text" | "display_text", expected: string, target_role?: string }) — synthetic step handled locally; the executor re-snapshots the focused window and checks that \`expected\` appears in the AX tree. Use \`target_role\` (e.g. "AXStaticText") to scope the search. Use generously after important state changes — every step exit-coding 0 does not prove the app actually responded.

Plan schema:
{
  "steps": [
    { "tool": "<unprefixed-tool-name>", "args": { ... }, "purpose": "<human summary>" }
  ],
  "stopWhen": "<description of skill-complete state>"
}

Important:
- If the prompt contains a "Pre-discovery" block with concrete pid, window_id, and AX tree, the executor's context already holds pid + window_id + the AX index. You MUST NOT re-emit launch_app or get_window_state at the start of the plan — those already ran and are already absorbed. Begin the plan with the FIRST USER-FACING ACTION (typically a click or type_text).
- For click / double_click / type_text targeting AX elements, do NOT pick element_index integers from the AX tree text — that's error-prone and the indices may shift between snapshots. Instead use the structured selector \`__selector\` (preferred) or the legacy shorthands \`__title\` / \`__ax_id\`. The executor resolves them against the cached AX index at runtime.

  __selector schema:
    { "title"?: string, "ax_id"?: string, "role"?: string, "ordinal"?: number }
  Resolution rules:
    - If \`ax_id\` is present, the executor matches by id (case-insensitive). Use this when the AX tree shows id=...
    - Else \`title\` (+ optional \`role\`) — when several entries share the same (title, role), use \`ordinal\` (0-based) to pick one.
    - Plain \`title\` alone works when the title is unique in the tree.

  Examples:
    { "tool": "click", "args": { "pid": 1234, "window_id": 5678, "__selector": { "ax_id": "Five" } }, "purpose": "press 5" }
    { "tool": "click", "args": { "pid": 1234, "window_id": 5678, "__selector": { "title": "5", "role": "AXButton" } }, "purpose": "press 5" }
    { "tool": "click", "args": { "pid": 1234, "window_id": 5678, "__selector": { "title": "OK", "role": "AXButton", "ordinal": 1 } }, "purpose": "second OK" }

  Backward-compat shorthands (still accepted):
    { "tool": "click", "args": { "pid": 1234, "window_id": 5678, "__title": "5" }, "purpose": "press 5" }
    { "tool": "click", "args": { "pid": 1234, "window_id": 5678, "__ax_id": "Five" }, "purpose": "press 5" }
- If there is NO pre-discovery block: emit launch_app first, then get_window_state, and use the literal strings "$pid" and "$window_id" in subsequent step args. Use __selector / __title / __ax_id once the AX tree is primed.
- EVERY click step MUST resolve to element_index OR (x, y) at execute time. That means it must include exactly ONE of: __selector, __title, __ax_id, element_index, or (x AND y). Never emit a click step with none of these — cua-driver will reject it.
- Keep "purpose" terse and action-oriented: "press 1", "open Calculator", "submit equals".
- After important state changes (pressing equals on a calculator, submitting a form, navigating to a new view), prefer to emit an \`assert\` step that confirms the post-condition. Example:
    { "tool": "assert", "args": { "kind": "display_text", "expected": "391", "target_role": "AXStaticText" }, "purpose": "verify result is 391" }
  This is the only way the executor can tell the difference between "the click succeeded" and "the click did the right thing".
- When a REPLAN block appears with "Already-executed steps", produce only the SUFFIX needed to finish the skill from the live state shown — do NOT restart from step 0. The side effects of the listed steps are already on screen; if you re-emit them you will double-apply (e.g. type "17" twice yielding "1717"). Use the live AX tree to ground your recovery.

Choosing the right primitive:
- \`type_text({ pid, text })\` writes via AXSelectedText into the FOCUSED ELEMENT. It only works when the focused element is a text-input field — \`AXTextField\`, \`AXTextArea\`, \`AXTextEdit\`, \`AXComboBox\`, or similar. If the focused element is an AXButton, AXWindow, or AXStaticText, type_text reports success but the characters go NOWHERE useful. **Look at the AX tree before emitting type_text. If you don't see a text-input role, do NOT use type_text.**
- \`press_key({ pid, key })\` sends a key event scoped to the pid. Works for any keyboard-driven UI (text fields, browsers, terminals, AND apps that bind keys to actions like Calculator's "1".."9", "return", "escape").
- \`hotkey({ pid, keys: [...] })\` for combinations like cmd+c.
- \`click({ pid, window_id, __selector: {...} })\` for buttons. Works for any AXButton regardless of keyboard-addressability. **Default to clicks for button-grid apps** (Calculator, the macOS chess app, dialogs). Calculator has NO text input; its display is read-only AXStaticText. The only way to enter a digit is to click the digit AXButton OR press_key the matching key name (e.g. press_key("1")).
- press_key wants key NAMES, not literal characters. Digit names: "0".."9". Named keys: "return", "space", "delete", "tab", "escape". Modifiers: "cmd", "shift", "option", "control". For "*" use \`hotkey({ keys: ["shift", "8"] })\`. For "+" use \`hotkey({ keys: ["shift", "equals"] })\`. NEVER \`press_key("*")\` — cua-driver rejects it as "Unknown key name".

Decision rule for a SINGLE expression to enter (Calculator-style):
  1. If the AX tree shows AXTextField/AXTextArea: use \`type_text\` (one call).
  2. Else, if every char maps to a known key name: emit one \`press_key\` per char + the \`hotkey\` form for shifted symbols.
  3. Else, click the AXButtons via \`__selector\`.

Examples (good plans):

A) Calculator 17 × 23 via clicks (RECOMMENDED for macOS Calculator — no text input):
{
  "steps": [
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "AllClear" } }, "purpose": "clear" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "One" } }, "purpose": "press 1" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "Seven" } }, "purpose": "press 7" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "Multiply" } }, "purpose": "press ×" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "Two" } }, "purpose": "press 2" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "Three" } }, "purpose": "press 3" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "ax_id": "Equals" } }, "purpose": "press =" },
    { "tool": "assert", "args": { "kind": "display_text", "expected": "391", "target_role": "AXStaticText" }, "purpose": "verify result is 391" }
  ],
  "stopWhen": "the result display reads 391"
}

B) Calculator 17 × 23 via press_key (also works — Calculator binds digit keys):
{
  "steps": [
    { "tool": "press_key", "args": { "pid": "$pid", "key": "1" }, "purpose": "press 1" },
    { "tool": "press_key", "args": { "pid": "$pid", "key": "7" }, "purpose": "press 7" },
    { "tool": "hotkey", "args": { "pid": "$pid", "keys": ["shift", "8"] }, "purpose": "press *" },
    { "tool": "press_key", "args": { "pid": "$pid", "key": "2" }, "purpose": "press 2" },
    { "tool": "press_key", "args": { "pid": "$pid", "key": "3" }, "purpose": "press 3" },
    { "tool": "press_key", "args": { "pid": "$pid", "key": "return" }, "purpose": "press =" },
    { "tool": "assert", "args": { "kind": "display_text", "expected": "391", "target_role": "AXStaticText" }, "purpose": "verify result is 391" }
  ],
  "stopWhen": "the result display reads 391"
}

C) Web form fill — type_text WORKS here because the focus is an AXTextField:
{
  "steps": [
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "title": "Email", "role": "AXTextField" } }, "purpose": "focus email field" },
    { "tool": "type_text", "args": { "pid": "$pid", "text": "user@example.com" }, "purpose": "enter email" }
  ],
  "stopWhen": "the email field shows user@example.com"
}

D) GitHub triage — AX-click for buttons with no keyboard shortcut:
{
  "steps": [
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "title": "Labels", "role": "AXButton" } }, "purpose": "open Labels dropdown" },
    { "tool": "click", "args": { "pid": "$pid", "window_id": "$window_id", "__selector": { "title": "bug", "role": "AXMenuItem" } }, "purpose": "apply bug label" }
  ],
  "stopWhen": "the issue shows the bug label"
}

ANTI-PATTERN — do NOT do this for Calculator:
{ "tool": "type_text", "args": { "pid": "$pid", "text": "17*23" } }
  ↳ The focused element will be an AXButton with no editable AXSelectedText.
    cua-driver will report "Inserted 3 char(s) into focused AXButton" but Calculator
    will never see them. The display will still read "0".`;

export async function generatePlan(opts: GeneratePlanOptions): Promise<Plan> {
  const prompt = buildPlannerPrompt(opts);
  const raw = await opts.claudeClient.generatePlanText(prompt);
  const json = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `planner: failed to parse model JSON response: ${(e as Error).message}\n--- raw ---\n${raw}`,
    );
  }
  return validatePlan(parsed);
}

function buildPlannerPrompt(opts: GeneratePlanOptions): string {
  const sections: string[] = [SYSTEM_GUIDANCE, "", "SKILL.md:", opts.skillMd];
  if (opts.currentStateSummary.trim()) {
    sections.push("", "Current screen state:", opts.currentStateSummary);
  }
  if (opts.replanContext) {
    const {
      failedStepIndex,
      failedStep,
      errorMessage,
      executedSteps,
      liveAxTree,
    } = opts.replanContext;
    sections.push(
      "",
      `REPLAN: the previous plan failed at step ${failedStepIndex} (purpose: "${failedStep.purpose}").`,
      `Error: ${errorMessage}`,
    );
    if (executedSteps && executedSteps.length > 0) {
      sections.push(
        "",
        "Already-executed steps (do NOT repeat these — the side effects are already applied):",
        ...executedSteps.map((s, i) => `  ${i}. ${s.tool} — ${s.purpose}`),
      );
    }
    if (liveAxTree && liveAxTree.trim().length > 0) {
      sections.push(
        "",
        "Live AX tree at the failure point (use the actual on-screen state, not the abstract SKILL.md text):",
        liveAxTree.slice(0, 12_000),
      );
    }
    sections.push(
      "",
      "Produce a SUFFIX plan that recovers from the failure and completes the remaining work. Skip steps that already executed.",
      "",
      "CRITICAL: if the previous attempt's failed step used `type_text` and the assertion failed, the focused element was NOT a text input — type_text inserted into an AXButton or similar non-editable element. DO NOT retry with type_text. Switch primitive: emit individual `click` steps via __selector OR individual `press_key` steps. Same rule for any primitive that already failed: changing the args or the description is not enough; switch the tool.",
    );
  } else {
    sections.push("", "Produce the plan.");
  }
  return sections.join("\n");
}

/**
 * Models occasionally wrap JSON in ```json fences despite instructions. Strip
 * them so JSON.parse sees clean input.
 */
function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function validatePlan(value: unknown): Plan {
  if (!value || typeof value !== "object")
    throw new Error("planner: response is not an object");
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.steps))
    throw new Error("planner: missing or invalid `steps` array");
  if (typeof obj.stopWhen !== "string")
    throw new Error("planner: missing or invalid `stopWhen` string");

  const steps: PlanStep[] = obj.steps.map((s, i) => {
    if (!s || typeof s !== "object")
      throw new Error(`planner: step ${i} is not an object`);
    const step = s as Record<string, unknown>;
    if (typeof step.tool !== "string")
      throw new Error(`planner: step ${i} missing string tool`);
    if (!step.args || typeof step.args !== "object")
      throw new Error(`planner: step ${i} missing args object`);
    if (typeof step.purpose !== "string")
      throw new Error(`planner: step ${i} missing string purpose`);
    return {
      tool: step.tool,
      args: step.args as Record<string, unknown>,
      purpose: step.purpose,
    };
  });

  return { steps, stopWhen: obj.stopWhen };
}

/**
 * Production planner client wrapping @anthropic-ai/sdk → Sonnet 4.6.
 *
 * Sonnet (not Opus) because the planner's job is tool selection from a
 * small grammar — it does not need Opus's reasoning headroom, and Sonnet
 * is materially faster + cheaper.
 */
export class AnthropicPlannerClient implements PlannerClient {
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const apiKey = opts.apiKey ?? Bun.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var required");
    this.apiKey = apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  async generatePlanText(prompt: string): Promise<string> {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: this.apiKey });
    const msg = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK content block union, narrowed by type tag
    const textBlock = msg.content.find((b: any) => b.type === "text") as any;
    return textBlock?.text ?? "";
  }
}
