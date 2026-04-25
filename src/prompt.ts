import type { AxNode } from "./axtree.ts";
import type { TrajectoryEvent } from "./trajectory.ts";

/** Hard cap on total input tokens we'll send to Claude per compile call. */
export const TOKEN_HARD_CAP = 80_000;
/** Conservative chars-per-token estimate for the prompt text. */
const CHARS_PER_TOKEN = 4;
/** Per-image token cost (Claude vision images are roughly this for 768px). */
const TOKENS_PER_IMAGE = 1500;

export interface CompilePromptInput {
  taskName: string;
  taskDescription: string;
  events: TrajectoryEvent[];
  sampledScreenshotPaths: string[];
  truncatedAxTrees: AxNode[];
}

export interface CompilePrompt {
  text: string;
  imageReferences: string[];
}

export function buildCompilePrompt(input: CompilePromptInput): CompilePrompt {
  const text = `You are a tool that converts a recorded human demonstration on macOS into a SKILL.md file.

The SKILL.md output must satisfy BOTH formats:
- cua's format (https://cua.ai/docs — "Demonstration-Guided Skills")
- agentskills format (https://agentskills.io/specification)

Both expect YAML frontmatter and a body with a title and steps. We extend the standard frontmatter with structured app-metadata AND an \`intent:\` block so the runtime planner can reason about the goal — not just replay clicks:

  ---
  name: <kebab-case slug>
  description: <one sentence>
  target:
    bundle_id: <reverse-DNS bundle id, e.g. com.apple.calculator>
    app_name: <human-readable name, e.g. "Calculator">
  keyboard_addressable: <true | false>
  intent:
    goal: <one-sentence description of what the user is trying to accomplish>
    inputs:                          # OPTIONAL — key/value of user-supplied inputs
      <key>: <value>
    subgoals:                        # 2-5 high-level phases
      - <phase 1>
      - <phase 2>
    success_signals:                 # observable conditions that mean "done"
      - <signal 1>
    observed_input_modes:            # primitives the user used in the recording
      - click | type_text | press_key | hotkey | scroll | other
  ---

\`target.bundle_id\`, \`target.app_name\`, \`intent.goal\`, and \`intent.success_signals\` (non-empty) are REQUIRED. Pull the bundle id from the recording's events (each event has a pid → app mapping). Set \`keyboard_addressable: true\` when the app accepts keystrokes for its primary input (Calculator, text editors, browsers, terminals); set \`false\` for AX-click-only UIs.

\`intent\` describes WHAT the user wanted, NOT how they typed it. The downstream planner uses it to choose the shortest path from the live state — the recording is context, not a literal script.
- \`goal\`: a single sentence. e.g. "Compute 17 × 23 in Calculator".
- \`inputs\`: only when the user typed/picked specific values (search query, file name, expression operands). Omit when there are no inputs.
- \`subgoals\`: 2-5 phases. Describe semantically — "clear current state", "enter the expression", "evaluate" — NOT button-by-button.
- \`success_signals\`: at least one. Observable conditions like "the result display reads 391" or "a new reminder row appears in Today's list".
- \`observed_input_modes\`: the cua-driver primitives the recording used. Helps the planner prefer the same modality.

TASK NAME: ${input.taskName}
TASK DESCRIPTION: ${input.taskDescription}

EVENTS (chronological, JSON Lines):
${input.events.map((e) => JSON.stringify(e)).join("\n")}

AX TREES (one per unique window, truncated):
${input.truncatedAxTrees.map((t) => JSON.stringify(t, null, 2)).join("\n\n")}

You will see ${input.sampledScreenshotPaths.length} representative screenshots inline.

Produce a SKILL.md that:
1. Has frontmatter with \`name\` (kebab-case), \`description\` (one sentence), \`target.bundle_id\`, \`target.app_name\`, \`keyboard_addressable\`, and the full \`intent:\` block as described above.
2. Has a top-level \`# <Title>\` heading.
3. Has a \`## Goal\` section with one paragraph explaining intent.
4. Has a \`## Steps\` section with 2-5 SEMANTIC phases describing what the user is doing — NOT a button-by-button replay. Examples of good phase wording: "clear the calculator", "enter the expression", "evaluate the expression", "open the issues list", "decide a label and apply it". Examples of BAD phase wording (do NOT do this): "click the AXButton titled '1'", "press the 7 key", "type *". The downstream planner re-derives the literal sequence from the live screenshot + AX tree at run time; the steps here are context for it, not a script.
5. Has a \`## Stop conditions\` section.

CRITICAL — INTENT ONLY, NO REPLAY HINTS:
- Do NOT include any \`## Anchors\` section.
- Do NOT include pixel coordinates, x/y values, position approximations ("around y≈47"), region descriptions ("top of the window"), or layout prose ("near the upper-left").
- Do NOT include element_index, ax indices, or any numeric ID from the recorded AX tree — they're stale by run time.
- The planner sees a LIVE screenshot + LIVE AX tree at execution time. It does not need (and is hurt by) frozen positional hints from the recording. Stick to intent + success signals + semantic phases.

Output ONLY the SKILL.md content. No commentary.`;

  // Reserve token budget for inline images. Anthropic vision images aren't
  // counted in the text-token estimate, but they still consume context.
  const imageTokens = input.sampledScreenshotPaths.length * TOKENS_PER_IMAGE;
  const textBudget = TOKEN_HARD_CAP - imageTokens;
  const estimatedTextTokens = text.length / CHARS_PER_TOKEN;
  if (estimatedTextTokens > textBudget) {
    throw new Error(
      `recording too long: prompt text would use ~${Math.round(estimatedTextTokens)} tokens, budget is ${textBudget} (${TOKEN_HARD_CAP} cap minus ${imageTokens} reserved for ${input.sampledScreenshotPaths.length} images). Try a shorter task or fewer events.`,
    );
  }

  return { text, imageReferences: input.sampledScreenshotPaths };
}
