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
   *
   * `imagePaths` is optional. When provided, each path is read and attached
   * as a vision content block alongside the text prompt. Production planner
   * uses this to send a live screenshot of the focused window so Sonnet can
   * see the actual on-screen state, not just the AX tree text. Tests can
   * pass empty / omit it; multimodal is best-effort, never required.
   */
  generatePlanText(prompt: string, imagePaths?: string[]): Promise<string>;
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
  /**
   * Optional image paths to attach to the planner request as vision blocks.
   * Production passes a live screenshot of the focused window so Sonnet can
   * see UI state directly (e.g. dialogs, error toasts) instead of inferring
   * from AX text. Best-effort — when capture fails the planner still works
   * text-only.
   */
  imagePaths?: string[];
}

const SYSTEM_GUIDANCE = `You plan cua-driver actions for a macOS app.

Inputs you'll see: an \`intent:\` block from SKILL.md (the goal + success signals), a live screenshot of the app, and a serialized AX tree.

Output ONLY a JSON object {"steps":[...], "stopWhen": "..."} — no prose, no markdown fences. Each step is { "tool": "...", "args": {...}, "purpose": "..." }.

Available tools (cua-driver MCP):
- launch_app, list_windows, get_window_state — pre-discovery already ran; do NOT re-emit at start
- click / double_click / right_click — args { pid, window_id, __selector: { title?, ax_id?, role?, ordinal? } } OR { pid, x, y }
- type_text — args { pid, text }; ONLY use when the focused element is an editable role (AXTextField, AXTextArea, AXTextEdit, AXComboBox)
- press_key — args { pid, key }; key NAMES not characters ("1", "return", "space", "shift")
- hotkey — args { pid, keys: ["modifier", "key"] } for shifted symbols and shortcuts

Principles:
- Prefer the shortest plan that satisfies the intent from the CURRENT state. The recording captures intent, not the literal sequence.
- AX selectors when targets are addressable; (x,y) only when the screenshot shows them clearly but AX doesn't.
- type_text requires a focused editable role. If you don't see one in the AX tree, click the buttons or press_key instead.
- On replan, return only the SUFFIX (the remaining work). Don't restart from step 0.
- Do NOT emit \`assert\` steps. Mid-flight verification is the executor's job and is checked once at the end against the SKILL.md success_signals. Just produce the action sequence.

OUTPUT FORMAT IS STRICT: emit ONLY the JSON object — no leading prose, no thinking, no "Looking at the tree…", no markdown, no commentary. The first character of your response must be \`{\` and the last must be \`}\`. The executor parses with JSON.parse and crashes on anything else.

Concrete pid + window_id come from pre-discovery and appear in the state block as integers (e.g. \`pid: 14002\`, \`window_id: 3745\`). Use those exact integers in step args. NEVER emit \`pid: 0\` or \`window_id: 0\` — there are no placeholder slots; cua-driver receives the integers verbatim and 0 is "no process" / "no window." Either use the discovered integer values OR the literal strings "$pid" / "$window_id" (the executor substitutes them at run time).`;

export async function generatePlan(opts: GeneratePlanOptions): Promise<Plan> {
  const prompt = buildPlannerPrompt(opts);
  const raw = await opts.claudeClient.generatePlanText(
    prompt,
    opts.imagePaths ?? [],
  );
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
      "CRITICAL: when retrying, switch the primitive. If type_text failed, the focused element was NOT editable — emit individual `click` steps via __selector OR individual `press_key` steps. For any primitive that already failed, changing the args or the description is not enough — switch the tool.",
    );
  } else {
    sections.push("", "Produce the plan.");
  }
  return sections.join("\n");
}

/**
 * Defensively extract a JSON object from a model response. Handles three
 * common drifts: (1) ```json fences, (2) prose preamble like "Looking at
 * the AX tree…" before the JSON, (3) trailing prose after the JSON. We
 * scan from the first `{` to the last `}` since plans are always objects.
 */
function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const inner = fenceMatch?.[1]?.trim() ?? trimmed;
  const first = inner.indexOf("{");
  const last = inner.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return inner;
  return inner.slice(first, last + 1);
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

  async generatePlanText(
    prompt: string,
    imagePaths: string[] = [],
  ): Promise<string> {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    // Multimodal request: attach each image as a base64 vision block. This
    // mirrors AnthropicClaudeClient.generate in src/compile.ts. Sonnet sees
    // the AX tree as text AND the live screenshot as image, so it can ground
    // its plan in actual on-screen state.
    let userContent: unknown;
    if (imagePaths.length === 0) {
      userContent = prompt;
    } else {
      const { readFileSync } = await import("node:fs");
      const { detectImageMimeType } = await import("./imagemime.ts");
      const blocks: Array<unknown> = [{ type: "text", text: prompt }];
      for (const path of imagePaths) {
        try {
          const data = readFileSync(path);
          const mediaType = detectImageMimeType(data);
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: data.toString("base64"),
            },
          });
        } catch (e) {
          // Best-effort: a missing/unreadable screenshot shouldn't block the
          // plan. Drop the image and continue with text-only.
          console.warn(
            `[planner] couldn't attach image ${path}: ${(e as Error).message}`,
          );
        }
      }
      userContent = blocks;
    }

    const msg = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      // biome-ignore lint/suspicious/noExplicitAny: SDK content union not exported cleanly
      messages: [{ role: "user", content: userContent as any }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK content block union, narrowed by type tag
    const textBlock = msg.content.find((b: any) => b.type === "text") as any;
    return textBlock?.text ?? "";
  }
}
