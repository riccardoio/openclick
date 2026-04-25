import type { TrajectoryEvent } from "./trajectory.ts";

export function sampleScreenshots(
  events: TrajectoryEvent[],
  cap: number,
): string[] {
  // Pull out screenshot strings up front so the rest of the function never
  // re-narrows `event.screenshot` (avoids non-null assertions and keeps
  // strictNullChecks happy).
  const frames = events
    .map((e) => e.screenshot)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (frames.length === 0) return [];
  if (frames.length <= cap) return frames;

  const states = events
    .filter((e) => typeof e.screenshot === "string" && e.screenshot.length > 0)
    .map((e) => e.post_state);

  // Always include first and last frame.
  const result = new Set<string>();
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first !== undefined) result.add(first);
  if (last !== undefined) result.add(last);

  // Key-change frames: post_state changed vs previous.
  for (let i = 1; i < frames.length; i++) {
    if (result.size >= cap) break;
    if (states[i] !== states[i - 1]) {
      const f = frames[i];
      if (f !== undefined) result.add(f);
    }
  }
  return Array.from(result);
}
