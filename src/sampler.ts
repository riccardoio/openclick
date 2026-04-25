import type { TrajectoryEvent } from "./trajectory.ts";

/**
 * Derive a "key state" string for an event so the sampler can detect transitions
 * even when the recorder doesn't emit an explicit `post_state` field.
 *
 * Order of preference:
 *   1. `event.post_state` (test fixtures + future Swift recorders may set this)
 *   2. `event.pid` + the focused window's AX tree title or role
 *   3. just `event.pid`
 *
 * If two consecutive events differ in any of these, the second one is a
 * "key-change frame" worth keeping for the LLM.
 */
function deriveState(e: TrajectoryEvent): string {
  if (typeof e.post_state === "string") return e.post_state;
  const pid = e.pid ?? 0;
  const ax = e.ax_tree as { role?: string; title?: string | null } | undefined;
  const axKey = ax?.title ?? ax?.role ?? "";
  return `${pid}|${axKey}`;
}

export function sampleScreenshots(
  events: TrajectoryEvent[],
  cap: number,
): string[] {
  const eventsWithFrame = events.filter(
    (e) => typeof e.screenshot === "string" && e.screenshot.length > 0,
  );
  const frames = eventsWithFrame.map((e) => e.screenshot as string);
  if (frames.length === 0) return [];
  if (frames.length <= cap) return frames;

  const states = eventsWithFrame.map(deriveState);

  // Always include first and last frame.
  const result = new Set<string>();
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first !== undefined) result.add(first);
  if (last !== undefined) result.add(last);

  // Key-change frames: state changed vs previous.
  for (let i = 1; i < frames.length; i++) {
    if (result.size >= cap) break;
    if (states[i] !== states[i - 1]) {
      const f = frames[i];
      if (f !== undefined) result.add(f);
    }
  }
  return Array.from(result);
}
