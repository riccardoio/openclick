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

Both expect frontmatter with at least \`name\` and \`description\`, and a body with a title and steps.

TASK NAME: ${input.taskName}
TASK DESCRIPTION: ${input.taskDescription}

EVENTS (chronological, JSON Lines):
${input.events.map((e) => JSON.stringify(e)).join("\n")}

AX TREES (one per unique window, truncated):
${input.truncatedAxTrees.map((t) => JSON.stringify(t, null, 2)).join("\n\n")}

You will see ${input.sampledScreenshotPaths.length} representative screenshots inline.

Produce a SKILL.md that:
1. Has frontmatter with \`name\` (kebab-case) and \`description\` (one sentence).
2. Has a top-level \`# <Title>\` heading.
3. Has a \`## Goal\` section with one paragraph explaining intent.
4. Has a \`## Steps\` section with a numbered list of high-level actions, NOT pixel coordinates.
5. Each step names the target by AX role + title (e.g. "click the AXButton titled 'Labels' in the toolbar"), NOT by pixel.
6. Has an \`## Anchors\` section with the AX paths observed in the recording, marked as hints.
7. Has a \`## Stop conditions\` section.

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
