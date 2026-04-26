import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionMetadata {
  task_name: string;
  task_description: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  screenshot_count: number;
}

export interface TrajectoryEvent {
  kind: "click" | "key" | "scroll";
  ts: string;
  pid: number;
  // ... other fields per kind
  screenshot?: string;
  ax_tree?: unknown;
  post_state?: string;
  bundle_id?: string;
  app_name?: string;
  [key: string]: unknown;
}

export interface Trajectory {
  directory: string;
  session: SessionMetadata;
  events: TrajectoryEvent[];
}

export async function readTrajectory(dir: string): Promise<Trajectory> {
  const session: SessionMetadata = JSON.parse(
    readFileSync(join(dir, "session.json"), "utf-8"),
  );
  const eventsRaw = readFileSync(join(dir, "events.jsonl"), "utf-8");
  const events = eventsRaw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TrajectoryEvent);
  return { directory: dir, session, events };
}
