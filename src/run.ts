import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  type ExecutionPolicy,
  type ExecutorContext,
  type StepRunner,
  classifyToolSafety,
  executePlan,
  parseAxTreeIndex,
  runCuaDriverStep,
} from "./executor.ts";
import { addAppMemoryFact, renderRelevantMemoriesForPrompt } from "./memory.ts";
import { requireCuaDriverBinary, resolveCuaDriverBinary } from "./paths.ts";
import {
  AnthropicPlannerClient,
  type GeneratePlanOptions,
  type Plan,
  type PlannerClient,
  generatePlan,
} from "./planner.ts";
import { type SkillIntent, readTargetMetadata } from "./schema.ts";
import {
  TraceRecorder,
  acquireRunLock,
  isRunCancelRequested,
} from "./trace.ts";

export interface RunOptions {
  taskPrompt: string;
  /** Optional user-defined success criteria, stricter than the task text. */
  criteria?: string;
  live: boolean;
  maxSteps: number;
  confirm?: boolean;
  /**
   * Enable cua-driver's agent cursor overlay for the duration of the run so
   * the user can SEE the cursor move + click. Off by default (faster, less
   * jarring). Restored to its previous state when the run ends.
   */
  cursor?: boolean;
  /** Use the cheap local planner/executor loop instead of Agent SDK mode. */
  fast?: boolean;
  /** Cap on automatic replans after a step failure or unverified batch. Default: 2. */
  maxReplans?: number;
  /** Maximum small action batches before stopping. Default: 6. */
  maxBatches?: number;
  /** Maximum model calls for planner + verifier. Default: 12. */
  maxModelCalls?: number;
  /** Maximum screenshots attached to model calls. Default: 8. */
  maxScreenshots?: number;
  /** Disable reading local app memories into planner prompts. */
  memory?: boolean;
  /** Disable writing new app memories during this run. */
  learn?: boolean;
  /** Injectable for tests. In production, leave unset to load the real SDK. */
  queryFn?: QueryFn;
  /** Injectable for tests. Toggles cua-driver's agent cursor overlay. */
  cursorToggleFn?: (enabled: boolean) => Promise<void>;
  /** Injectable for tests / production override of the Sonnet planner client. */
  plannerClient?: PlannerClient;
  /** Injectable/configurable verifier client. Defaults to SHOWME_VERIFIER_MODEL. */
  verifierClient?: PlannerClient;
  /** Injectable for tests. In production, leave unset to shell out to cua-driver. */
  stepRunner?: StepRunner;
  /**
   * Opt-in escape hatch for tools that may steal focus, move the real cursor, or
   * modify global state. Default false keeps the Mac usable by the human.
   */
  allowForeground?: boolean;
}

export type QueryFn = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export async function runSkill(opts: RunOptions): Promise<void> {
  if (opts.fast) {
    await runTaskFast(opts);
    return;
  }
  await runTaskAgent(opts);
}

export const runTask = runSkill;

async function runTaskAgent(opts: RunOptions): Promise<void> {
  const systemPrompt = buildSystemPrompt(
    opts.taskPrompt,
    opts.criteria,
    opts.allowForeground === true,
  );

  if (!opts.live) {
    console.log(
      "[showme] DRY RUN — no cua-driver tools will execute. Pass --live to actually run.",
    );
  }
  console.log("[showme] press Ctrl-C to abort.");

  // Abort flag pattern: SIGINT sets the flag and lets the loop notice it.
  // The previous handler called process.exit(130) immediately, which bypassed
  // the cursor-restore + final-status logging in `finally`. Codex called this
  // out: "the silent exit path is your own process kill, not the executor loop."
  let aborted = false;
  const onSigint = (): void => {
    if (aborted) {
      // Second Ctrl-C: user is impatient, exit hard.
      console.log("\n[showme] hard-aborted (second Ctrl-C).");
      process.exit(130);
    }
    aborted = true;
    console.log(
      "\n[showme] aborting after current step finishes... (Ctrl-C again to force)",
    );
  };
  process.on("SIGINT", onSigint);

  // biome-ignore lint/suspicious/noExplicitAny: SDK hook input is an opaque object.
  const previewHook = async (input: any): Promise<Record<string, unknown>> => {
    const tool = input.tool_name ?? "<unknown>";
    const args = input.tool_input ?? {};
    const summary = summarizeToolCall(tool, args);
    console.log(`[showme] about to: ${summary}`);
    if (!opts.live) {
      // Block execution by returning a "denied" decision.
      return { decision: "block", reason: "dry-run mode" };
    }
    const safety = classifyToolSafety(String(tool));
    if (safety.category === "unsupported") {
      return {
        decision: "block",
        reason: `unsupported tool blocked: ${safety.reason}`,
      };
    }
    if (!opts.allowForeground && safety.category === "foreground_required") {
      return {
        decision: "block",
        reason: `foreground-required tool blocked in shared-seat background mode: ${safety.reason}`,
      };
    }
    if (opts.confirm) {
      const ok = await promptYesNo("execute? [y/N]: ");
      if (!ok) return { decision: "block", reason: "user declined" };
    }
    return {};
  };

  const queryFn = opts.queryFn ?? (await loadRealQuery());
  const toggleCursor = opts.cursorToggleFn ?? defaultCursorToggle;
  const cuaDriver =
    resolveCuaDriverBinary() ??
    (opts.queryFn ? "cua-driver" : requireCuaDriverBinary());

  // Enable the overlay before the agent starts so the very first cua-driver
  // tool call already animates. Only when --live (otherwise no actions fire).
  if (opts.cursor && opts.live) {
    try {
      await toggleCursor(true);
      console.log("[showme] agent cursor overlay: ON");
    } catch (e) {
      console.warn(`[showme] couldn't enable agent cursor: ${e}`);
    }
  }

  let stepCount = 0;
  try {
    for await (const message of queryFn({
      prompt: opts.taskPrompt,
      options: {
        systemPrompt,
        mcpServers: { "cua-driver": { command: cuaDriver, args: ["mcp"] } },
        allowedTools: [
          "mcp__cua-driver__click",
          "mcp__cua-driver__type_text",
          "mcp__cua-driver__get_window_state",
          "mcp__cua-driver__screenshot",
          "mcp__cua-driver__press_key",
          "mcp__cua-driver__hotkey",
          "mcp__cua-driver__list_apps",
          "mcp__cua-driver__list_windows",
          "mcp__cua-driver__launch_app",
          "mcp__cua-driver__scroll",
        ],
        hooks: { PreToolUse: [{ matcher: ".*", hooks: [previewHook] }] },
        maxTurns: opts.maxSteps,
      },
    })) {
      if (aborted) break;
      // biome-ignore lint/suspicious/noExplicitAny: SDK message union not exported.
      const msg = message as any;
      if (msg.type === "tool_use") stepCount++;
      if (msg.type === "result" && "result" in msg) {
        console.log(`[showme] ${msg.result}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (opts.cursor && opts.live) {
      try {
        await toggleCursor(false);
      } catch {
        // Best-effort restore; don't crash the run report on cleanup failure.
      }
    }
  }
  if (aborted) {
    process.exitCode = 130;
    console.log(`[showme] aborted. ${stepCount} tool calls.`);
    return;
  }
  console.log(`[showme] done. ${stepCount} tool calls.`);
}

/**
 * Prompt-first path: ask Sonnet for a small action batch, execute it locally,
 * screenshot/snapshot, and replan only when execution fails or completion is
 * not verified. This avoids Agent SDK per-tool LLM round-trips while keeping
 * fresh visual grounding.
 */
async function runTaskFast(opts: RunOptions): Promise<void> {
  if (!opts.live) {
    console.log(
      "[showme] DRY RUN — no cua-driver tools will execute. Pass --live to actually run.",
    );
  }
  console.log("[showme] press Ctrl-C to abort.");
  console.log("[showme] mode: prompt planner (small batches, local executor)");
  console.log(
    opts.allowForeground
      ? "[showme] execution mode: foreground opt-in (may use global/foreground primitives)."
      : "[showme] execution mode: shared-seat background (no real cursor/focus ownership).",
  );

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const trace = new TraceRecorder({
    runId,
    prompt: opts.taskPrompt,
    criteria: opts.criteria,
  });
  console.log(`[showme] run id: ${runId}`);
  const lock = opts.live && !opts.stepRunner ? acquireRunLock(runId) : null;
  if (lock && !lock.ok) {
    trace.event("lock_blocked", lock.message);
    trace.finish("failed");
    console.error(`[showme] ${lock.message}`);
    process.exitCode = 15;
    return;
  }

  // CRITICAL: the daemon MUST be running before any element-indexed click,
  // because the AX state cache only persists across CLI calls when those calls
  // route through the daemon. Without it, get_window_state populates a cache
  // in subprocess A, then click runs in subprocess B with an empty cache and
  // fails with "No cached AX state for pid <X>". Auto-start if needed.
  //
  // When a custom stepRunner is injected (tests, dry-run harnesses), no real
  // cua-driver subprocess will be spawned — skip the daemon check so CI runners
  // without cua-driver installed can still exercise the planning logic.
  if (opts.live && !opts.stepRunner) {
    await ensureDaemonRunning();
  }

  // Abort flag pattern (see runTaskAgent for rationale).
  let aborted = false;
  const onSigint = (): void => {
    if (aborted) {
      console.log("\n[showme] hard-aborted (second Ctrl-C).");
      process.exit(130);
    }
    aborted = true;
    trace.event("abort_requested", "SIGINT received");
    console.log(
      "\n[showme] aborting after current step finishes... (Ctrl-C again to force)",
    );
  };
  process.on("SIGINT", onSigint);

  const plannerClient = opts.plannerClient ?? new AnthropicPlannerClient();
  const verifierClient =
    opts.verifierClient ??
    opts.plannerClient ??
    new AnthropicPlannerClient({
      model:
        Bun.env.SHOWME_VERIFIER_MODEL ??
        Bun.env.SHOWME_PLANNER_MODEL ??
        "claude-sonnet-4-6",
    });
  if (!plannerClient) {
    throw new Error(
      "run requires either ANTHROPIC_API_KEY or an injected plannerClient",
    );
  }
  const toggleCursor = opts.cursorToggleFn ?? defaultCursorToggle;
  const maxActionRetries = opts.maxReplans ?? 2;
  const maxBatches = opts.maxBatches ?? 6;
  const maxModelCalls =
    opts.maxModelCalls ?? Number(Bun.env.SHOWME_MAX_MODEL_CALLS ?? 12);
  const maxScreenshots =
    opts.maxScreenshots ?? Number(Bun.env.SHOWME_MAX_SCREENSHOTS ?? 8);
  const maxCriteriaRefinements = opts.criteria?.trim()
    ? 2
    : Number.POSITIVE_INFINITY;
  const executionPolicy: ExecutionPolicy = opts.allowForeground
    ? "foreground"
    : "background";
  const telemetry: RunTelemetry = {
    modelCalls: 0,
    plannerCalls: 0,
    verifierCalls: 0,
    screenshotsAttached: 0,
    promptChars: 0,
  };

  if (opts.cursor && opts.live) {
    try {
      await toggleCursor(true);
      console.log("[showme] agent cursor overlay: ON");
    } catch (e) {
      console.warn(`[showme] couldn't enable agent cursor: ${e}`);
    }
  }

  let totalExecuted = 0;
  let runSucceeded = false;
  let plan: Plan | null = null;
  let lastResult: Awaited<ReturnType<typeof executePlan>> | null = null;
  let initialContext: ExecutorContext | undefined;
  let stopWhenVerified = false;
  let batchesUsed = 0;
  let actionRetriesUsed = 0;
  let criteriaRefinementsUsed = 0;
  let lastScreenshotHash: string | undefined;
  let learningDisabled = false;
  let pendingCritique: string | undefined;
  const critiqueHistory: string[] = [];
  const runHistory: string[] = [];
  const tempPaths = new Set<string>();
  let initialLiveState: InitialLiveState | null = null;
  const seatMonitor =
    opts.live && !opts.stepRunner ? await SeatActivityMonitor.create() : null;
  if (seatMonitor) {
    trace.event("seat_baseline", seatMonitor.describeBaseline());
  }
  let seatActivityReported = false;
  const noteSeatActivity = async (phase: string): Promise<void> => {
    const activity = await seatMonitor?.check();
    if (!activity) return;
    learningDisabled = true;
    trace.event("external_seat_activity", activity, { phase });
    if (!seatActivityReported) {
      console.warn(
        `[showme] external seat activity detected (${activity}); continuing in background mode and disabling learning for this run.`,
      );
      seatActivityReported = true;
    }
  };
  try {
    let stateSummary = taskStateSummary(opts);
    let discoveryScreenshot: string | undefined;
    if (opts.live && !opts.stepRunner) {
      const apps = await discoverAppsForPrompt(
        opts.taskPrompt,
        opts.memory !== false,
      );
      if (apps) stateSummary = `${stateSummary}\n\n${apps}`;
      const initialState = await discoverInitialLiveState(opts.taskPrompt);
      initialLiveState = initialState;
      if (initialState) {
        stateSummary = `${stateSummary}\n\n${initialState.promptText}`;
        initialContext = initialState.context;
        discoveryScreenshot = addScreenshotIfChanged(
          initialState.screenshot?.path,
          tempPaths,
          (hash) => {
            lastScreenshotHash = hash;
            return undefined;
          },
        );
        console.log(
          `[showme] discovered initial state (pid=${initialState.context.pid}, window=${initialState.context.windowId}, ax-entries=${initialState.context.axIndex?.length ?? 0}${discoveryScreenshot ? ", screenshot attached" : ""})`,
        );
        learnAppCapability({
          initialState,
          description:
            "Target app/window was discovered through background launch/list_windows/get_window_state without requiring foreground activation.",
          enabled: opts.learn !== false && !learningDisabled,
          cause: "background_discovery_succeeded",
          kind: "observation",
        });
      }
    }

    const maxStepsPerPlan = 10;

    trace.event("planning", "initial plan");
    plan = await budgetedGeneratePlan({
      taskPrompt: opts.taskPrompt,
      currentStateSummary: stateSummary,
      claudeClient: plannerClient,
      imagePaths: discoveryScreenshot ? [discoveryScreenshot] : [],
      maxStepsPerPlan,
      telemetry,
      maxModelCalls,
      maxScreenshots,
    });
    console.log(`[showme] plan: ${plan.steps.length} step(s)`);
    trace.event("plan", `${plan.steps.length} step(s)`, {
      steps: plan.steps.map((step) => ({
        tool: step.tool,
        purpose: step.purpose,
        expected_change: step.expected_change,
      })),
    });

    // Wrap an explicit catch around the loop so any mid-loop throw surfaces
    // a clear message rather than terminating the process silently after a
    // partial trace (which is impossible to debug from the user side).
    while (!aborted) {
      await noteSeatActivity("before_batch");
      if (isRunCancelRequested(runId)) {
        aborted = true;
        learningDisabled = true;
        trace.event("cancel_requested", "cancel file detected");
        break;
      }
      if (batchesUsed >= maxBatches) {
        console.error(`[showme] max batch budget exhausted (${maxBatches}).`);
        break;
      }
      const remainingStepBudget = opts.maxSteps - totalExecuted;
      if (remainingStepBudget <= 0) {
        console.error(`[showme] max step budget exhausted (${opts.maxSteps}).`);
        break;
      }
      let result: Awaited<ReturnType<typeof executePlan>>;
      let preBatchHash: string | null = null;
      try {
        if (plan.status === "done") {
          console.log(
            `[showme] planner says done: ${plan.message ?? plan.stopWhen}`,
          );
          if (
            opts.live &&
            !opts.stepRunner &&
            initialContext?.pid !== undefined &&
            initialContext.windowId !== undefined &&
            plan.stopWhen.trim().length > 0
          ) {
            const ok = await budgetedVerifyStopWhen({
              plannerClient: verifierClient,
              stopWhen: plan.stopWhen,
              criteria: opts.criteria,
              pid: initialContext.pid,
              windowId: initialContext.windowId,
              intent: {
                goal: opts.taskPrompt,
                successSignals: successSignalsFor(opts, plan),
              },
              executedStepPurposes: [],
              telemetry,
              maxModelCalls,
              maxScreenshots,
              tempPaths,
            });
            if (ok.verdict === "yes") {
              runSucceeded = true;
              stopWhenVerified = true;
            } else {
              console.error(
                `[showme] planner done was not verified (${ok.verdict}): ${ok.explanation}`,
              );
              process.exitCode = opts.criteria?.trim() ? 3 : 1;
            }
          } else {
            runSucceeded = true;
            stopWhenVerified = !opts.live;
          }
          break;
        }
        if (
          plan.status === "blocked" ||
          plan.status === "needs_clarification"
        ) {
          console.error(
            `[showme] ${plan.status}: ${plan.message ?? "planner cannot safely continue"}`,
          );
          break;
        }
        if (plan.steps.length === 0) {
          console.error(
            "[showme] planner returned no actions and did not mark the task done.",
          );
          break;
        }
        const preBatchShot =
          opts.live &&
          !opts.stepRunner &&
          initialContext?.windowId !== undefined &&
          hasHighRiskVisualStep(plan)
            ? await captureFocusedWindowScreenshot(initialContext.windowId)
            : undefined;
        if (preBatchShot?.path) tempPaths.add(preBatchShot.path);
        preBatchHash = preBatchShot?.path ? hashFile(preBatchShot.path) : null;
        batchesUsed++;
        result = await executePlan(plan, {
          stepRunner: opts.stepRunner ?? makeVerboseStepRunner(executionPolicy),
          dryRun: !opts.live,
          confirm: opts.confirm,
          initialContext,
          maxSteps: remainingStepBudget,
          executionPolicy,
        });
      } catch (e) {
        console.error(`[showme] executor crashed: ${e}`);
        throw e;
      }
      totalExecuted += result.stepsExecuted;
      lastResult = result;
      initialContext = cloneExecutorContext(result.lastContext);
      await noteSeatActivity("after_batch");
      for (const [index, step] of plan.steps
        .slice(0, result.stepsExecuted)
        .entries()) {
        runHistory.push(`${step.tool}: ${step.purpose}`);
        trace.step(step, index);
      }
      if (result.error === undefined) {
        if (!opts.live || opts.stepRunner) {
          runSucceeded = true;
          break;
        }
        if (
          plan.stopWhen.trim().length === 0 ||
          result.lastContext.pid === undefined ||
          result.lastContext.windowId === undefined
        ) {
          console.error(
            "[showme] batch completed but live context is missing; cannot verify success safely.",
          );
          break;
        }
        if (isOpenFocusOnlyTask(opts.taskPrompt, plan)) {
          stopWhenVerified = true;
          runSucceeded = true;
          console.log(
            "[showme] app availability verified from launch context.",
          );
          break;
        }
        const liveState = await snapshotContextForPrompt(result.lastContext);
        const postBatchHash = liveState.screenshot?.path
          ? hashFile(liveState.screenshot.path)
          : null;
        const shot = addScreenshotIfChanged(
          liveState.screenshot?.path,
          tempPaths,
          (hash) => {
            if (hash === lastScreenshotHash) return false;
            lastScreenshotHash = hash;
            return true;
          },
        );
        const unchanged =
          hasHighRiskVisualStep(plan) &&
          ((preBatchHash !== null && postBatchHash === preBatchHash) ||
            shot === undefined);
        if (unchanged) {
          learnAppCapability({
            initialState: initialLiveState,
            description:
              "Background visual gesture batch reported success but did not materially change the target screenshot; treat background canvas dragging as unreliable for this app until a different strategy succeeds.",
            enabled: opts.learn !== false && !learningDisabled,
            cause: "background_visual_delta_failed",
            kind: "avoid",
          });
          pendingCritique = await budgetedCritiqueVisualFailure({
            taskPrompt: opts.taskPrompt,
            failedSteps: plan.steps.slice(0, result.stepsExecuted),
            evidence:
              "A high-risk visual action batch completed, but the post-action screenshot did not materially change from the previous screenshot.",
            liveState: liveState.liveAxTree,
            imagePaths: await visualEvidenceImages({
              screenshot: liveState.screenshot,
              step: lastHighRiskVisualStep(plan),
              tempPaths,
            }),
            plannerClient,
            telemetry,
            maxModelCalls,
            maxScreenshots,
          });
          critiqueHistory.push(pendingCritique);
          trace.event("critique", pendingCritique);
        }
        if (!unchanged) {
          const ok = await budgetedVerifyStopWhen({
            plannerClient: verifierClient,
            stopWhen: plan.stopWhen,
            criteria: opts.criteria,
            pid: result.lastContext.pid,
            windowId: result.lastContext.windowId,
            intent: {
              goal: opts.taskPrompt,
              successSignals: successSignalsFor(opts, plan),
            },
            executedStepPurposes: plan.steps
              .slice(0, result.stepsExecuted)
              .map((s) => s.purpose),
            telemetry,
            maxModelCalls,
            maxScreenshots,
            tempPaths,
          });
          trace.event("verify", ok.explanation, { verdict: ok.verdict });
          if (ok.verdict === "yes") {
            if (hasHighRiskVisualStep(plan)) {
              learnAppCapability({
                initialState: initialLiveState,
                description:
                  "Pid/window-targeted visual gestures produced a verified visible result in background mode.",
                enabled: opts.learn !== false && !learningDisabled,
                cause: "background_visual_gesture_succeeded",
                kind: "affordance",
              });
            }
            stopWhenVerified = true;
            runSucceeded = true;
            console.log(`[showme] stopWhen verified: ${ok.explanation}`);
            break;
          }
          if (batchesUsed >= maxBatches) {
            console.error(
              `[showme] stopWhen not verified after ${batchesUsed} batch(es): ${ok.explanation}`,
            );
            break;
          }
          const countsAsCriteriaRefinement = shouldSpendCriteriaRefinement(ok);
          if (
            countsAsCriteriaRefinement &&
            criteriaRefinementsUsed >= maxCriteriaRefinements
          ) {
            console.error(
              `[showme] criteria not satisfied after ${criteriaRefinementsUsed} refinement round(s): ${ok.explanation}`,
            );
            process.exitCode = 3;
            break;
          }
          if (countsAsCriteriaRefinement) criteriaRefinementsUsed++;
          learnFromVerifierFeedback({
            taskPrompt: opts.taskPrompt,
            explanation: ok.explanation,
            initialState: initialLiveState,
            enabled: opts.learn !== false && !learningDisabled,
          });
          if (hasHighRiskVisualStep(plan)) {
            pendingCritique = await budgetedCritiqueVisualFailure({
              taskPrompt: opts.taskPrompt,
              failedSteps: plan.steps.slice(0, result.stepsExecuted),
              evidence: ok.explanation,
              liveState: liveState.liveAxTree,
              imagePaths: await visualEvidenceImages({
                screenshot: liveState.screenshot,
                step: lastHighRiskVisualStep(plan),
                tempPaths,
              }),
              plannerClient,
              telemetry,
              maxModelCalls,
              maxScreenshots,
            });
            critiqueHistory.push(pendingCritique);
            trace.event("critique", pendingCritique);
            learnAppCapability({
              initialState: initialLiveState,
              description: pendingCritique,
              enabled: opts.learn !== false && !learningDisabled,
              cause: "visual_action_critique",
            });
          }
          console.log(
            `[showme] stopWhen not verified (${ok.verdict}): ${ok.explanation}`,
          );
          console.log(
            `[showme] planning next batch (${batchesUsed + 1}/${maxBatches})...`,
          );
          plan = await budgetedGeneratePlan({
            taskPrompt: opts.taskPrompt,
            currentStateSummary: taskStateSummary(opts),
            claudeClient: plannerClient,
            replanContext: {
              failedStepIndex: plan.steps.length,
              failedStep: {
                tool: "verify",
                args: {},
                purpose:
                  "completed a batch but the live screenshot/AX verifier did not confirm the task is done",
              },
              errorMessage: `${verifierReplanMessage(opts.taskPrompt, ok)}${pendingCritique ? `\nExecution critique: ${pendingCritique}` : ""}`,
              executedSteps: plan.steps.slice(0, result.stepsExecuted),
              liveAxTree: liveState.liveAxTree,
              runHistory,
            },
            imagePaths: await visualEvidenceImages({
              screenshot: liveState.screenshot,
              step: lastHighRiskVisualStep(plan),
              tempPaths,
            }),
            maxStepsPerPlan,
            telemetry,
            maxModelCalls,
            maxScreenshots,
          });
          console.log(`[showme] replan: ${plan.steps.length} step(s)`);
          trace.event("replan", `${plan.steps.length} step(s)`);
          continue;
        }
        console.log(
          "[showme] visual delta check: no material screenshot change; asking planner to change strategy.",
        );
        plan = await budgetedGeneratePlan({
          taskPrompt: opts.taskPrompt,
          currentStateSummary: taskStateSummary(opts),
          claudeClient: plannerClient,
          replanContext: {
            failedStepIndex: plan.steps.length,
            failedStep: {
              tool: "visual_delta",
              args: {},
              purpose:
                "completed visual actions but no material screenshot change was detected",
            },
            errorMessage: `Cheap visual-delta check detected no material change after high-risk visual actions.\nExecution critique: ${pendingCritique}`,
            executedSteps: plan.steps.slice(0, result.stepsExecuted),
            liveAxTree: liveState.liveAxTree,
            runHistory,
          },
          imagePaths: await visualEvidenceImages({
            screenshot: liveState.screenshot,
            step: lastHighRiskVisualStep(plan),
            tempPaths,
          }),
          maxStepsPerPlan,
          telemetry,
          maxModelCalls,
          maxScreenshots,
        });
        console.log(`[showme] replan: ${plan.steps.length} step(s)`);
        continue;
      }
      if (
        result.error === "user declined" ||
        result.error.startsWith("max step budget exhausted")
      ) {
        console.error(
          `[showme] step ${result.failedStepIndex} failed: ${result.error}`,
        );
        break;
      }
      if (isForegroundRequiredError(result.error) && actionRetriesUsed > 0) {
        trace.event("foreground_required", result.error);
        console.error(`[showme] foreground control required: ${result.error}`);
        process.exitCode = 16;
        break;
      }
      if (actionRetriesUsed >= maxActionRetries) {
        console.error(
          `[showme] step ${result.failedStepIndex} failed after ${actionRetriesUsed} action retry/retries: ${result.error}`,
        );
        break;
      }
      actionRetriesUsed++;
      console.log(
        `[showme] step ${result.failedStepIndex} failed: ${result.error}`,
      );
      console.log(
        `[showme] replanning action retry (${actionRetriesUsed}/${maxActionRetries})...`,
      );
      const failedStep = plan.steps[result.failedStepIndex ?? 0];
      if (!failedStep) break;
      runHistory.push(
        `FAILED ${failedStep.tool}: ${failedStep.purpose} (${result.error})`,
      );
      // Snapshot the live window at the failure point so the planner sees
      // actual on-screen state, not the stale pre-discovery dump. Best-effort:
      // if we can't snapshot, fall back to no liveAxTree.
      let liveAxTree: string | undefined;
      let replanScreenshot: string | undefined;
      const ctxAtFailure = result.lastContext;
      // When a stepRunner is injected, this shell-out would fail in CI without
      // cua-driver. The injected runner already produced lastContext, so we
      // can replan from text-only.
      if (
        opts.live &&
        !opts.stepRunner &&
        ctxAtFailure.pid !== undefined &&
        ctxAtFailure.windowId !== undefined
      ) {
        const liveState = isWindowStateTimeout(failedStep, result.error)
          ? await screenshotOnlyContextForPrompt(ctxAtFailure)
          : await snapshotContextForPrompt(ctxAtFailure);
        liveAxTree = liveState.liveAxTree;
        replanScreenshot = addScreenshotIfChanged(
          liveState.screenshot?.path,
          tempPaths,
          (hash) => {
            if (hash === lastScreenshotHash) return false;
            lastScreenshotHash = hash;
            return true;
          },
        );
      }
      // Steps that completed successfully before the failure. The planner
      // is told not to re-emit these.
      const executedSteps = plan.steps.slice(0, result.failedStepIndex ?? 0);
      const replanSummary = taskStateSummary(opts);
      plan = await budgetedGeneratePlan({
        taskPrompt: opts.taskPrompt,
        currentStateSummary: replanSummary,
        claudeClient: plannerClient,
        replanContext: {
          failedStepIndex: result.failedStepIndex ?? 0,
          failedStep,
          errorMessage: actionFailureReplanMessage(failedStep, result.error),
          executedSteps,
          liveAxTree,
          runHistory,
        },
        imagePaths: replanScreenshot ? [replanScreenshot] : [],
        maxStepsPerPlan,
        telemetry,
        maxModelCalls,
        maxScreenshots,
      });
      console.log(`[showme] replan: ${plan.steps.length} step(s)`);
      trace.event("replan", `${plan.steps.length} step(s)`);
    }

    // Post-run stopWhen verification. If the plan completed all steps with
    // no error AND the plan declared a non-trivial stopWhen, do one cheap
    // Sonnet call: snapshot the live AX state, ask the model whether the
    // task actually succeeded. Catches the "every step exit-coded 0 but
    // the result display still says 0" case Codex flagged.
    // Skip post-run verification when a stepRunner is injected — verifyStopWhen
    // shells out to cua-driver via defaultSnapshot, which fails on CI without
    // cua-driver installed. Test harnesses that want to exercise the verifier
    // call it directly.
    if (
      runSucceeded &&
      !stopWhenVerified &&
      opts.live &&
      !opts.stepRunner &&
      plan &&
      plan.stopWhen.trim().length > 0 &&
      lastResult?.lastContext.pid !== undefined &&
      lastResult.lastContext.windowId !== undefined
    ) {
      const ok = await budgetedVerifyStopWhen({
        plannerClient: verifierClient,
        stopWhen: plan.stopWhen,
        criteria: opts.criteria,
        pid: lastResult.lastContext.pid,
        windowId: lastResult.lastContext.windowId,
        intent: {
          goal: opts.taskPrompt,
          successSignals: successSignalsFor(opts, plan),
        },
        executedStepPurposes: plan.steps
          .slice(0, lastResult.stepsExecuted)
          .map((s) => s.purpose),
        telemetry,
        maxModelCalls,
        maxScreenshots,
        tempPaths,
      });
      if (ok.verdict === "no") {
        console.error(
          `[showme] stopWhen verification FAILED: ${ok.explanation}`,
        );
        process.exitCode = 3;
      } else if (ok.verdict === "unknown") {
        if (opts.criteria?.trim()) {
          console.error(
            `[showme] criteria verifier couldn't confirm success: ${ok.explanation}`,
          );
          process.exitCode = 3;
        } else {
          console.warn(
            `[showme] stopWhen verifier couldn't tell from the screenshot/AX (${ok.explanation}). All steps completed without errors — treating as success.`,
          );
        }
      } else {
        console.log(`[showme] stopWhen verified: ${ok.explanation}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    cleanupTempPaths(tempPaths);
    if (lock?.ok) lock.release();
    if (opts.cursor && opts.live) {
      try {
        await toggleCursor(false);
      } catch {
        // Best-effort restore.
      }
    }
  }
  if (aborted) {
    process.exitCode = 130;
    trace.finish(
      isRunCancelRequested(runId) ? "cancelled" : "aborted",
      telemetryRecord(telemetry),
    );
    console.log(`[showme] aborted. ${totalExecuted} tool calls.`);
    return;
  }
  if (!runSucceeded) {
    process.exitCode =
      process.exitCode && process.exitCode !== 0 ? process.exitCode : 1;
    console.log(formatTelemetry(telemetry));
    trace.finish("failed", telemetryRecord(telemetry));
    return;
  }
  if (critiqueHistory.length > 0) {
    learnAppCapability({
      initialState: initialLiveState,
      description: `A strategy critique led to successful completion: ${critiqueHistory.at(-1)}`,
      enabled: opts.learn !== false && !learningDisabled,
      cause: "successful_strategy_after_critique",
      kind: "affordance",
    });
  }
  console.log(formatTelemetry(telemetry));
  trace.finish("succeeded", telemetryRecord(telemetry));
  console.log(`[showme] done. ${totalExecuted} tool calls.`);
}

async function snapshotContextForPrompt(
  ctx: ExecutorContext,
): Promise<{ liveAxTree?: string; screenshot?: CapturedScreenshot }> {
  if (ctx.pid === undefined || ctx.windowId === undefined) return {};
  const snap = await runCuaDriverCapture([
    "call",
    "get_window_state",
    JSON.stringify({
      pid: ctx.pid,
      window_id: ctx.windowId,
    }),
  ]);
  const screenshot = await captureFocusedWindowScreenshot(ctx.windowId);
  const dimensionBlock =
    screenshot?.width && screenshot.height
      ? `Attached screenshot metadata:\n  screenshot_width: ${screenshot.width}\n  screenshot_height: ${screenshot.height}\nUse these exact dimensions in drag args when using screenshot coordinates.\n\n`
      : "";
  return {
    liveAxTree: snap.ok
      ? `${dimensionBlock}${snap.stdout.slice(0, 12_000)}`
      : dimensionBlock || undefined,
    screenshot,
  };
}

async function screenshotOnlyContextForPrompt(
  ctx: ExecutorContext,
): Promise<{ liveAxTree?: string; screenshot?: CapturedScreenshot }> {
  if (ctx.windowId === undefined) return {};
  const screenshot = await captureFocusedWindowScreenshot(ctx.windowId);
  const dimensionBlock =
    screenshot?.width && screenshot.height
      ? `Attached screenshot metadata:\n  screenshot_width: ${screenshot.width}\n  screenshot_height: ${screenshot.height}\nUse these exact dimensions in drag args when using screenshot coordinates.\n\n`
      : "";
  return {
    liveAxTree: `${dimensionBlock}AX inspection timed out for this window. Do not call get_window_state again immediately. Use the attached screenshot, list_windows, keyboard shortcuts, visible coordinates, and normal app UI to recover and continue.`,
    screenshot,
  };
}

interface RunTelemetry {
  modelCalls: number;
  plannerCalls: number;
  verifierCalls: number;
  screenshotsAttached: number;
  promptChars: number;
}

function telemetryRecord(t: RunTelemetry): Record<string, number> {
  return {
    modelCalls: t.modelCalls,
    plannerCalls: t.plannerCalls,
    verifierCalls: t.verifierCalls,
    screenshotsAttached: t.screenshotsAttached,
    promptChars: t.promptChars,
  };
}

interface CapturedScreenshot {
  path: string;
  width?: number;
  height?: number;
}

function taskStateSummary(opts: RunOptions): string {
  const lines = [`User asked: ${opts.taskPrompt}`];
  lines.push(
    "",
    "Execution mode:",
    opts.allowForeground
      ? "Foreground opt-in is enabled. Prefer background-safe pid/window-targeted actions, but foreground/global primitives are allowed only when necessary."
      : "Shared-seat background mode. Do not steal focus, move the human's real cursor, or rely on the target app being frontmost. Use only pid/window-targeted background-safe primitives; if foreground control is truly required, return blocked with a concise message.",
  );
  if (opts.criteria?.trim()) {
    lines.push("", "User success criteria:", opts.criteria.trim());
  }
  if (isFreshDocumentTask(opts.taskPrompt)) {
    lines.push(
      "",
      "Fresh document requirement:",
      "The user asked to create/open a new file/document/canvas. Before creating the final content, make sure the target app is active and a fresh editable document/canvas is open. Use normal visible app UI or standard new-document shortcuts; do not keep working in a stale/wrong canvas if verification says the visible content is old or malformed.",
    );
  }
  return lines.join("\n");
}

function successSignalsFor(opts: RunOptions, plan: Plan): string[] {
  return [
    plan.stopWhen,
    ...(opts.criteria?.trim() ? [opts.criteria.trim()] : []),
  ];
}

function hasHighRiskVisualStep(plan: Plan): boolean {
  return plan.steps.some((step) => {
    if (["drag", "multi_drag", "click_hold"].includes(step.tool)) return true;
    if (
      ["click", "double_click", "right_click"].includes(step.tool) &&
      /\b(canvas|draw|line|shape|tool|select|resize|move|place|mark|hand|circle)\b/i.test(
        `${step.purpose} ${step.expected_change ?? ""}`,
      )
    ) {
      return true;
    }
    return false;
  });
}

function lastHighRiskVisualStep(plan: Plan): Plan["steps"][number] | undefined {
  return [...plan.steps]
    .reverse()
    .find((step) => hasHighRiskVisualStep({ ...plan, steps: [step] }));
}

async function visualEvidenceImages(args: {
  screenshot?: CapturedScreenshot;
  step?: Plan["steps"][number];
  tempPaths: Set<string>;
}): Promise<string[]> {
  const screenshot = args.screenshot;
  const full = screenshot?.path;
  if (!full) return [];
  const crop = await cropScreenshotAroundStep(screenshot, args.step);
  if (crop) {
    args.tempPaths.add(crop);
    return [full, crop];
  }
  return [full];
}

async function cropScreenshotAroundStep(
  screenshot: CapturedScreenshot,
  step?: Plan["steps"][number],
): Promise<string | null> {
  if (!screenshot.width || !screenshot.height || !step) return null;
  const points = pointsFromStep(step);
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.max(0, Math.min(...xs) - 180);
  const minY = Math.max(0, Math.min(...ys) - 180);
  const maxX = Math.min(screenshot.width, Math.max(...xs) + 180);
  const maxY = Math.min(screenshot.height, Math.max(...ys) + 180);
  const width = Math.max(80, Math.round(maxX - minX));
  const height = Math.max(80, Math.round(maxY - minY));
  const outPath = screenshot.path.replace(/\.png$/i, `.crop-${Date.now()}.png`);
  const proc = Bun.spawn(
    [
      "sips",
      "-c",
      String(height),
      String(width),
      "--cropOffset",
      String(Math.round(minY)),
      String(Math.round(minX)),
      screenshot.path,
      "--out",
      outPath,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  return proc.exitCode === 0 ? outPath : null;
}

function pointsFromStep(
  step: Plan["steps"][number],
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const add = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.x === "number" && typeof record.y === "number")
      points.push({ x: record.x, y: record.y });
  };
  add(step.args.from);
  add(step.args.to);
  if (typeof step.args.x === "number" && typeof step.args.y === "number")
    points.push({ x: step.args.x, y: step.args.y });
  if (Array.isArray(step.args.gestures)) {
    for (const gesture of step.args.gestures) {
      if (gesture && typeof gesture === "object") {
        const record = gesture as Record<string, unknown>;
        add(record.from);
        add(record.to);
      }
    }
  }
  return points;
}

async function budgetedCritiqueVisualFailure(args: {
  taskPrompt: string;
  failedSteps: Plan["steps"];
  evidence: string;
  liveState?: string;
  imagePaths: string[];
  plannerClient: PlannerClient;
  telemetry: RunTelemetry;
  maxModelCalls: number;
  maxScreenshots: number;
}): Promise<string> {
  enforceModelBudget(args.telemetry, args.maxModelCalls);
  enforceScreenshotBudget(
    args.telemetry,
    args.maxScreenshots,
    args.imagePaths.length,
  );
  args.telemetry.modelCalls++;
  args.telemetry.plannerCalls++;
  const prompt = [
    "You are critiquing a failed macOS UI action attempt.",
    "Do not propose app-specific hardcoded scripts. Infer the likely reason from visible state, failed steps, and generic desktop UI behavior.",
    "",
    `User task: ${args.taskPrompt}`,
    "",
    "Failed or ineffective steps:",
    ...args.failedSteps.map(
      (step, i) =>
        `  ${i}. ${step.tool}: ${step.purpose}${step.expected_change ? ` (expected: ${step.expected_change})` : ""}`,
    ),
    "",
    `Observed evidence: ${args.evidence}`,
    args.liveState ? `\nLive state:\n${args.liveState.slice(0, 8000)}` : "",
    "",
    "Answer in one concise paragraph: why the action likely did not persist or visibly change the app, and what the next strategy should change. Mention concrete UI state if visible.",
  ].join("\n");
  args.telemetry.promptChars += prompt.length;
  const text = await args.plannerClient.generatePlanText(
    prompt,
    args.imagePaths,
  );
  return text.trim().replace(/\s+/g, " ").slice(0, 800);
}

function learnAppCapability(args: {
  initialState: InitialLiveState | null;
  description: string;
  enabled: boolean;
  cause: string;
  kind?: "affordance" | "observation" | "avoid";
}): void {
  if (
    !args.enabled ||
    !args.initialState ||
    args.description.trim().length < 10
  )
    return;
  addAppMemoryFact({
    bundleId: args.initialState.app.bundleId,
    appName: args.initialState.app.name,
    kind: args.kind ?? "observation",
    description: args.description,
    confidence: args.kind === "affordance" ? 0.65 : 0.55,
    status: args.kind === "affordance" ? "candidate" : "candidate",
    scope: "capability",
    cause: args.cause,
    evidence: [args.description],
  });
}

function isOpenFocusOnlyTask(taskPrompt: string, plan: Plan): boolean {
  const task = normalizeForMatch(taskPrompt);
  if (
    !/^(open|launch|focus|switch to|bring up|show)\b/.test(task) ||
    /\b(draw|create|make|search|type|write|click|calculate|edit|delete|move|upload|download|fill)\b/.test(
      task,
    )
  ) {
    return false;
  }
  return plan.steps.some((step) => step.tool === "launch_app");
}

async function budgetedGeneratePlan(
  opts: GeneratePlanOptions & {
    telemetry: RunTelemetry;
    maxModelCalls: number;
    maxScreenshots: number;
  },
): Promise<Plan> {
  enforceModelBudget(opts.telemetry, opts.maxModelCalls);
  enforceScreenshotBudget(
    opts.telemetry,
    opts.maxScreenshots,
    opts.imagePaths?.length ?? 0,
  );
  opts.telemetry.plannerCalls++;
  return await generatePlan({
    ...opts,
    claudeClient: wrapPlannerClientForTelemetry(
      opts.claudeClient,
      opts.telemetry,
      opts.maxScreenshots,
    ),
  });
}

function wrapPlannerClientForTelemetry(
  client: PlannerClient,
  telemetry: RunTelemetry,
  maxScreenshots: number,
): PlannerClient {
  return {
    async generatePlanText(prompt, imagePaths = []) {
      enforceScreenshotBudget(telemetry, maxScreenshots, imagePaths.length);
      telemetry.modelCalls++;
      telemetry.promptChars += prompt.length;
      telemetry.screenshotsAttached += imagePaths.length;
      return await client.generatePlanText(prompt, imagePaths);
    },
  };
}

async function budgetedVerifyStopWhen(
  args: Parameters<typeof verifyStopWhen>[0] & {
    telemetry: RunTelemetry;
    maxModelCalls: number;
    maxScreenshots: number;
    tempPaths?: Set<string>;
  },
): Promise<Awaited<ReturnType<typeof verifyStopWhen>>> {
  enforceModelBudget(args.telemetry, args.maxModelCalls);
  args.telemetry.verifierCalls++;
  args.telemetry.promptChars +=
    args.stopWhen.length +
    (args.intent?.goal.length ?? 0) +
    (args.executedStepPurposes ?? []).join("\n").length;
  return await verifyStopWhen({
    ...args,
    plannerClient: wrapPlannerClientForVerifier(
      args.plannerClient,
      args.telemetry,
      args.maxScreenshots,
    ),
    captureScreenshot: args.captureScreenshot
      ? args.captureScreenshot
      : async (windowId) => {
          const shot = await captureFocusedWindowScreenshot(windowId);
          if (shot) args.tempPaths?.add(shot.path);
          return shot;
        },
  });
}

function wrapPlannerClientForVerifier(
  client: PlannerClient,
  telemetry: RunTelemetry,
  maxScreenshots: number,
): PlannerClient {
  return {
    async generatePlanText(prompt, imagePaths = []) {
      enforceScreenshotBudget(telemetry, maxScreenshots, imagePaths.length);
      telemetry.modelCalls++;
      telemetry.promptChars += prompt.length;
      telemetry.screenshotsAttached += imagePaths.length;
      return await client.generatePlanText(prompt, imagePaths);
    },
  };
}

function enforceModelBudget(
  telemetry: RunTelemetry,
  maxModelCalls: number,
): void {
  if (telemetry.modelCalls >= maxModelCalls) {
    throw new Error(`model call budget exhausted (${maxModelCalls})`);
  }
}

function enforceScreenshotBudget(
  telemetry: RunTelemetry,
  maxScreenshots: number,
  requested: number,
): void {
  if (telemetry.screenshotsAttached + requested > maxScreenshots) {
    throw new Error(`screenshot budget exhausted (${maxScreenshots})`);
  }
}

function formatTelemetry(t: RunTelemetry): string {
  return `[showme] cost telemetry: model_calls=${t.modelCalls} planner_calls=${t.plannerCalls} verifier_calls=${t.verifierCalls} screenshots=${t.screenshotsAttached} prompt_chars~=${t.promptChars}`;
}

function addScreenshotIfChanged(
  path: string | undefined,
  tempPaths: Set<string>,
  acceptHash: (hash: string) => boolean | undefined,
): string | undefined {
  if (!path) return undefined;
  const hash = hashFile(path);
  if (hash && acceptHash(hash) === false) {
    tempPaths.add(path);
    return undefined;
  }
  tempPaths.add(path);
  return path;
}

function hashFile(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    return String(Bun.hash(bytes.toString("base64")));
  } catch {
    return null;
  }
}

function cleanupTempPaths(paths: Set<string>): void {
  for (const path of paths) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function cloneExecutorContext(ctx: ExecutorContext): ExecutorContext {
  return {
    pid: ctx.pid,
    windowId: ctx.windowId,
    axIndex: ctx.axIndex ? [...ctx.axIndex] : undefined,
    screenshotWidth: ctx.screenshotWidth,
    screenshotHeight: ctx.screenshotHeight,
  };
}

/**
 * cua-driver ships slow cinematic cursor defaults (glide=750ms + dwell=400ms)
 * so background agents are easy to glance at. For a focused replay demo the
 * user is *watching*, that animation budget dominates. We tune to a snappier
 * preset on enable. The motion settings persist in cua-driver's config, so
 * we keep these values across runs (no need to restore — they're saner than
 * the defaults for users running showme).
 */
const CURSOR_MOTION_PRESET = {
  glide_duration_ms: 250,
  dwell_after_click_ms: 80,
};

async function defaultCursorToggle(enabled: boolean): Promise<void> {
  if (enabled) {
    // Tune motion BEFORE enabling so the very first click animates with the
    // snappy preset rather than the slow defaults.
    await runCuaDriver([
      "set_agent_cursor_motion",
      JSON.stringify(CURSOR_MOTION_PRESET),
    ]);
  }
  await runCuaDriver(["set_agent_cursor_enabled", JSON.stringify({ enabled })]);
}

async function runCuaDriver(args: string[]): Promise<void> {
  const cuaDriver = requireCuaDriverBinary();
  const proc = Bun.spawn([cuaDriver, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const { exitCode, stderr, timedOut } = await collectProcess(proc, 20_000);
  if (timedOut) throw new Error(`cua-driver ${args[0]} timed out`);
  if (exitCode !== 0) {
    throw new Error(
      `cua-driver ${args[0]} exited ${exitCode}: ${stderr.trim()}`,
    );
  }
}

/**
 * Verifies the cua-driver daemon is up. If not, launches it via LaunchServices
 * (`open -n -g -a CuaDriver --args serve`) and polls `cua-driver status` until
 * the socket appears. Throws if the daemon doesn't come up within ~6 seconds —
 * that's an environment problem the user has to fix.
 *
 * Why this matters: element-indexed clicks read an AX cache populated by
 * `get_window_state`. The cache lives in the daemon process. If the daemon
 * isn't running, each `cua-driver call` runs in-process, the cache dies with
 * each invocation, and clicks fail with "No cached AX state for pid <X>".
 */
async function ensureDaemonRunning(): Promise<void> {
  const cuaDriver = requireCuaDriverBinary();
  if (await isDaemonRunning(cuaDriver)) return;
  console.log("[showme] cua-driver daemon not running; auto-starting...");
  // Fire-and-forget. `open -n -g` is non-blocking — daemon starts in the
  // background while open exits immediately.
  Bun.spawn(["open", "-n", "-g", "-a", "CuaDriver", "--args", "serve"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isDaemonRunning(cuaDriver)) {
      console.log("[showme] daemon up");
      return;
    }
  }
  throw new Error(
    "cua-driver daemon failed to start within 6s. Try `open -n -g -a CuaDriver --args serve` manually, then re-run.",
  );
}

async function isDaemonRunning(
  cuaDriver: string = requireCuaDriverBinary(),
): Promise<boolean> {
  const proc = Bun.spawn([cuaDriver, "status"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const { exitCode } = await collectProcess(proc, 3_000);
  return exitCode === 0;
}

/**
 * Wraps the default cua-driver subprocess runner with extra logging so we can
 * see the actual stdout / stderr per step. Currently surfaces:
 *   - exit code
 *   - first 200 chars of stdout (typically a JSON summary)
 *   - any stderr (cua-driver writes warnings + AX failure detail here)
 *
 * Without this, a step that "succeeded" per exit code but didn't actually
 * register a UI press (wrong element_index, click sent to a hidden element,
 * etc.) is invisible — cua-driver returns 0 either way.
 */
function makeVerboseStepRunner(
  executionPolicy: ExecutionPolicy,
): import("./executor.ts").StepRunner {
  return async (step) => {
    const cuaDriver = requireCuaDriverBinary();
    const trim = (s: string, n = 200): string =>
      s.length <= n ? s.trim() : `${s.slice(0, n).trim()}…`;
    const result = await runCuaDriverStep(step, cuaDriver, {
      executionPolicy,
    });
    if (!result.ok) {
      console.log(`[showme]   ✗ ${trim(result.error ?? "unknown error")}`);
      return result;
    }
    console.log(`[showme]   ✓ ${trim(result.stdout ?? "", 160)}`);
    return result;
  };
}

async function runCuaDriverCapture(
  args: string[],
  timeoutMs?: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cuaDriver = requireCuaDriverBinary();
  const proc = Bun.spawn([cuaDriver, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const { exitCode, stdout, stderr, timedOut } = await collectProcess(
    proc,
    timeoutMs,
  );
  return {
    ok: !timedOut && exitCode === 0,
    stdout,
    stderr: timedOut ? `${stderr}\nprocess timed out`.trim() : stderr,
  };
}

async function collectProcess(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = Number(Bun.env.SHOWME_SUBPROCESS_TIMEOUT_MS ?? 20_000),
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
  const stderrPromise = new Response(proc.stderr as ReadableStream).text();
  let timedOut = false;
  let timer: Timer | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve(null);
    }, timeoutMs);
  });
  await Promise.race([proc.exited, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (!timedOut) await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { exitCode: proc.exitCode, stdout, stderr, timedOut };
}

interface CursorPoint {
  x: number;
  y: number;
}

interface FrontmostApp {
  name?: string;
  bundleId?: string;
  pid?: number;
}

class SeatActivityMonitor {
  private reported = new Set<string>();

  private constructor(
    private readonly cursor: CursorPoint | null,
    private readonly frontmost: FrontmostApp | null,
  ) {}

  static async create(): Promise<SeatActivityMonitor | null> {
    const [cursor, frontmost] = await Promise.all([
      sampleCursorPosition(),
      sampleFrontmostApp(),
    ]);
    if (!cursor && !frontmost) return null;
    return new SeatActivityMonitor(cursor, frontmost);
  }

  describeBaseline(): string {
    const parts: string[] = [];
    if (this.cursor) parts.push(`cursor=(${this.cursor.x},${this.cursor.y})`);
    if (this.frontmost?.bundleId) {
      parts.push(
        `frontmost=${this.frontmost.name ?? "unknown"} [${this.frontmost.bundleId}]`,
      );
    }
    return parts.join(" ") || "unavailable";
  }

  async check(): Promise<string | null> {
    const changes: string[] = [];
    const [cursor, frontmost] = await Promise.all([
      sampleCursorPosition(),
      sampleFrontmostApp(),
    ]);
    if (this.cursor && cursor) {
      const distance = Math.hypot(
        cursor.x - this.cursor.x,
        cursor.y - this.cursor.y,
      );
      if (distance >= 8 && !this.reported.has("cursor")) {
        this.reported.add("cursor");
        changes.push(
          `cursor moved ${Math.round(distance)}px from baseline (${this.cursor.x},${this.cursor.y})`,
        );
      }
    }
    if (this.frontmost?.bundleId && frontmost?.bundleId) {
      if (
        frontmost.bundleId !== this.frontmost.bundleId &&
        !this.reported.has("frontmost")
      ) {
        this.reported.add("frontmost");
        changes.push(
          `frontmost app changed from ${this.frontmost.bundleId} to ${frontmost.bundleId}`,
        );
      }
    }
    return changes.length > 0 ? changes.join("; ") : null;
  }
}

async function sampleCursorPosition(): Promise<CursorPoint | null> {
  const out = await runCuaDriverCapture(
    ["call", "get_cursor_position", "{}"],
    2_000,
  );
  if (!out.ok) return null;
  const match = out.stdout.match(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  if (!match?.[1] || !match[2]) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function sampleFrontmostApp(): Promise<FrontmostApp | null> {
  const script = [
    "import AppKit",
    "if let app = NSWorkspace.shared.frontmostApplication {",
    '  print("\\(app.localizedName ?? "")\\t\\(app.bundleIdentifier ?? "")\\t\\(app.processIdentifier)")',
    "}",
  ].join("\n");
  const proc = Bun.spawn(["swift", "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const { exitCode, stdout, timedOut } = await collectProcess(proc, 2_000);
  if (timedOut || exitCode !== 0) return null;
  const [name, bundleId, pidRaw] = stdout.trim().split("\t");
  if (!bundleId) return null;
  const pid = pidRaw ? Number(pidRaw) : undefined;
  return {
    name: name || undefined,
    bundleId,
    pid: Number.isFinite(pid) ? pid : undefined,
  };
}

/**
 * One-shot Sonnet call that takes a snapshot of the live AX tree and the
 * skill's stopWhen description, and asks "did this succeed?". The model
 * answers YES/NO + a one-sentence explanation, which we surface to the user.
 *
 * This is the safety net for the case where every step exit-coded 0 but
 * the actual app state didn't change (silent click on the wrong element,
 * keyboard input swallowed by a modal, etc.).
 *
 * `snapshot` is injectable so tests can avoid the cua-driver subprocess.
 */
export async function verifyStopWhen(args: {
  plannerClient: PlannerClient;
  stopWhen: string;
  criteria?: string;
  pid: number;
  windowId: number;
  /**
   * Full skill intent (goal + success_signals). When present, we ground the
   * verifier in the user's WHAT (not just the planner's stopWhen sentinel).
   * Browser/web apps don't expose web view content in AX, so the AX tree
   * alone falsely says "menu bar only"; goal + screenshot together unstick
   * that case.
   */
  intent?: SkillIntent;
  /**
   * Plan steps that ran (purpose strings). Adds "what did we actually do"
   * context so the verifier knows e.g. "we typed claude code and pressed
   * return" even if the AX tree is sparse.
   */
  executedStepPurposes?: string[];
  snapshot?: (
    pid: number,
    windowId: number,
  ) => Promise<{ ok: boolean; stdout: string; error?: string }>;
  /**
   * Optional screenshot capture hook. Defaults to a real cua-driver call.
   * Tests inject a no-op so they don't shell out.
   */
  captureScreenshot?: (
    windowId: number,
  ) => Promise<string | CapturedScreenshot | undefined>;
  /**
   * Settle delay (ms) before snapshotting + screenshotting. Pages render and
   * navigations resolve in real time — a 0ms gap captures pre-render. Tests
   * inject 0 to skip the wait. Default ~1500ms.
   */
  settleMs?: number;
}): Promise<{ verdict: "yes" | "no" | "unknown"; explanation: string }> {
  const settleMs = args.settleMs ?? 1500;
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  const snapshotFn = args.snapshot ?? defaultSnapshot;
  const snap = await snapshotFn(args.pid, args.windowId);
  if (!snap.ok)
    return {
      verdict: "unknown",
      explanation: `couldn't snapshot window for verification: ${snap.error ?? "unknown"}`,
    };
  const trimmed = snap.stdout.slice(0, 12_000);
  const deterministic = deterministicVerifyFromAx({
    axTree: trimmed,
    stopWhen: args.stopWhen,
    intent: args.intent,
  });
  if (deterministic && !args.criteria?.trim()) return deterministic;

  const sections: string[] = [
    "You are verifying that a macOS task succeeded. You have THREE pieces of context: the goal, the steps that just ran, and a screenshot + AX tree of the target window.",
    "",
    "The SCREENSHOT is your PRIMARY evidence. The AX tree is supplementary and is often sparse for browser web views, full-screen file viewers, video players, and any app that renders content outside the AX hierarchy. When the screenshot clearly shows the goal completed, answer YES even if the AX tree only shows a menu bar or chrome.",
    "",
    "For visual creation tasks, be strict: answer YES only when the requested artifact is clearly recognizable, complete, and decent. It must include the requested attributes (for example shape, parts, labels/time/marks, layout). If the output is partial, rough, malformed, misaligned, missing requested parts, or merely resembles the artifact loosely, answer NO with the concrete missing/poor parts. Do not give credit for progress.",
    "",
    "Three possible verdicts:",
    "  YES — the screenshot (primary) or the AX tree (supplementary) shows clear evidence the goal was met.",
    "  NO — there is positive evidence of FAILURE (an error dialog, a captcha block, the wrong app in front, a known-bad state).",
    "  UNKNOWN — neither source contains enough information to tell. Sparse evidence is NOT failure — answer UNKNOWN.",
    "",
    "Default to UNKNOWN over NO when evidence is missing or ambiguous. Only answer NO when you can point to a specific contradicting signal.",
  ];
  if (args.intent) {
    sections.push("", `Goal: ${args.intent.goal}`);
    if (args.intent.successSignals.length > 0) {
      sections.push(
        args.criteria?.trim()
          ? "General success signals (helpful context; NOT sufficient if required criteria below are unmet):"
          : "Success signals (any one is enough):",
      );
      for (const s of args.intent.successSignals) sections.push(`  - ${s}`);
    }
  }
  if (args.criteria?.trim()) {
    sections.push(
      "",
      "Required success criteria (ALL must be visibly satisfied for verdict yes):",
      args.criteria.trim(),
    );
  }
  sections.push("", `Planner stopWhen: ${args.stopWhen}`);
  if (args.executedStepPurposes && args.executedStepPurposes.length > 0) {
    sections.push("", "Steps that just ran (all returned exit-code 0):");
    for (const p of args.executedStepPurposes) sections.push(`  - ${p}`);
  }
  sections.push(
    "",
    "Live AX tree of the target window (supplementary, may be incomplete):",
    trimmed,
    "",
    "Reply ONLY as JSON:",
    '{"verdict":"yes|no|unknown","criteria_met":true|false,"missing":["..."],"quality_issues":["..."],"explanation":"one sentence grounded in visible evidence"}',
    "Use verdict=yes only if the goal is complete and every required criterion is met.",
  );
  const prompt = sections.join("\n");
  // Best-effort: attach a screenshot too. Falsy from the capture hook (tests,
  // failed grant) just degrades to text-only, same as planning.
  const captureFn = args.captureScreenshot ?? captureFocusedWindowScreenshot;
  const shot = await captureFn(args.windowId);
  const shotPath = screenshotPath(shot);
  const imagePaths = shotPath ? [shotPath] : [];
  const reply = await args.plannerClient.generatePlanText(prompt, imagePaths);
  const trimmedReply = reply.trim();
  const structured = parseVerifierJson(trimmedReply);
  if (structured) {
    if (
      args.criteria?.trim() &&
      (structured.verdict !== "yes" || structured.criteria_met !== true)
    ) {
      return {
        verdict: structured.verdict === "yes" ? "unknown" : structured.verdict,
        explanation: verifierExplanation(structured),
      };
    }
    if (structured.verdict === "yes" && !args.criteria?.trim()) {
      const weakVisualYes = rejectWeakVisualArtifactYes({
        explanation: structured.explanation,
        stopWhen: args.stopWhen,
        intent: args.intent,
      });
      if (weakVisualYes) return weakVisualYes;
    }
    return {
      verdict: structured.verdict,
      explanation: verifierExplanation(structured),
    };
  }
  const unknownMatch = trimmedReply.match(/^UNKNOWN\b\s*[—:-]?\s*(.*)$/i);
  if (unknownMatch)
    return {
      verdict: "unknown",
      explanation: unknownMatch[1]?.trim() || "evidence sparse",
    };
  const yesMatch = trimmedReply.match(/^YES\b\s*[—:-]?\s*(.*)$/i);
  if (yesMatch) {
    const explanation = yesMatch[1]?.trim() || "skill complete";
    if (args.criteria?.trim()) {
      return {
        verdict: "unknown",
        explanation:
          "verifier did not return structured criteria results for required criteria",
      };
    }
    const weakVisualYes = rejectWeakVisualArtifactYes({
      explanation,
      stopWhen: args.stopWhen,
      intent: args.intent,
    });
    if (weakVisualYes) return weakVisualYes;
    return {
      verdict: "yes",
      explanation,
    };
  }
  const noMatch = trimmedReply.match(/^NO\b\s*[—:-]?\s*(.*)$/i);
  if (noMatch)
    return {
      verdict: "no",
      explanation: noMatch[1]?.trim() || "model returned NO without detail",
    };
  return {
    verdict: "unknown",
    explanation: `verifier returned an unparseable reply: ${trimmedReply.slice(0, 200)}`,
  };
}

interface StructuredVerifierReply {
  verdict: "yes" | "no" | "unknown";
  criteria_met?: boolean;
  missing?: string[];
  quality_issues?: string[];
  explanation: string;
}

function parseVerifierJson(reply: string): StructuredVerifierReply | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    const verdictRaw =
      typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "";
    if (!["yes", "no", "unknown"].includes(verdictRaw)) return null;
    return {
      verdict: verdictRaw as "yes" | "no" | "unknown",
      criteria_met:
        typeof parsed.criteria_met === "boolean"
          ? parsed.criteria_met
          : undefined,
      missing: stringArray(parsed.missing),
      quality_issues: stringArray(parsed.quality_issues),
      explanation:
        typeof parsed.explanation === "string"
          ? parsed.explanation
          : "verifier returned structured JSON without explanation",
    };
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function verifierExplanation(reply: StructuredVerifierReply): string {
  const details = [
    reply.explanation,
    reply.missing && reply.missing.length > 0
      ? `missing: ${reply.missing.join(", ")}`
      : "",
    reply.quality_issues && reply.quality_issues.length > 0
      ? `quality issues: ${reply.quality_issues.join(", ")}`
      : "",
  ].filter(Boolean);
  return details.join("; ");
}

function shouldSpendCriteriaRefinement(result: {
  verdict: "yes" | "no" | "unknown";
  explanation: string;
}): boolean {
  if (result.verdict === "no") return true;
  return !/\b(menu bar|no canvas|screenshot only shows|wrong app|window state|sparse evidence|couldn't snapshot|cannot verify)\b/i.test(
    result.explanation,
  );
}

function verifierReplanMessage(
  taskPrompt: string,
  result: { verdict: "yes" | "no" | "unknown"; explanation: string },
): string {
  const base = `stopWhen verifier returned ${result.verdict}: ${result.explanation}`;
  if (!isFreshDocumentTask(taskPrompt)) return base;
  if (!looksLikeWrongOrStaleWorkspace(result.explanation)) return base;
  return `${base}\nRecovery instruction: the verifier suggests the workspace/canvas is stale, wrong, malformed, or not a fresh document. Before adding more content, recover generically without stealing focus: use the target app's background-safe shortcuts/AX controls to open or create a fresh editable document/canvas, clear only if safe, then recreate the artifact. Do not keep adding strokes to the same stale canvas.`;
}

function actionFailureReplanMessage(
  failedStep: Plan["steps"][number],
  error: string,
): string {
  if (isForegroundRequiredError(error)) {
    return `${error}\nRecovery instruction: do not retry this primitive in shared-seat background mode. Choose a pid/window-targeted background-safe strategy. If no such strategy exists, return status "blocked" and explain that foreground control is required.`;
  }
  if (isWindowStateTimeout(failedStep, error)) {
    return `${error}\nRecovery instruction: get_window_state timed out. A modal dialog, file picker, save/open panel, or heavy app state may be blocking accessibility. Do not retry get_window_state immediately. Use the screenshot and normal visible UI instead: if the task is not about choosing/opening/saving a file, dismiss the blocking dialog with Escape or a visible Cancel/close control, then continue using keyboard shortcuts, clicks, drags, and screenshots rather than AX inspection.`;
  }
  return error;
}

function isForegroundRequiredError(error: string | undefined): boolean {
  return !!error && /foreground-required|unsupported tool blocked/.test(error);
}

function isWindowStateTimeout(
  failedStep: Plan["steps"][number],
  error: string,
): boolean {
  return failedStep.tool === "get_window_state" && /\btimed out\b/i.test(error);
}

function looksLikeWrongOrStaleWorkspace(text: string): boolean {
  return /\b(stale|wrong|old|existing|malformed|misaligned|overlapping|scattered|not a fresh|not recognizable|menu is open|no canvas|wrong app|home|start screen)\b/i.test(
    text,
  );
}

function isFreshDocumentTask(taskPrompt: string): boolean {
  return /\b(create|new|open|start|make|draw)\b[\s\S]{0,80}\b(file|document|doc|canvas|design|board|project)\b/i.test(
    taskPrompt,
  );
}

function rejectWeakVisualArtifactYes(args: {
  explanation: string;
  stopWhen: string;
  intent?: SkillIntent;
}): { verdict: "unknown"; explanation: string } | null {
  const taskText = normalizeForMatch(args.intent?.goal ?? args.stopWhen);
  if (!/\b(draw|drawing|create|created|make|made|design)\b/.test(taskText))
    return null;
  if (
    !/\b(draw|drawing|drawn|canvas|visible|design|art|shape)\b/.test(taskText)
  )
    return null;

  const requiredTerms = visualArtifactTerms(taskText);
  if (requiredTerms.length === 0) return null;
  const explanation = normalizeForMatch(args.explanation);
  const matchedTerms = requiredTerms.filter((term) =>
    explanation.includes(term),
  );
  const negativeQuality =
    /\b(rough|partial|incomplete|missing|malformed|misaligned|not clear|unclear|poor|bad|loose|approximate|only|no)\b/.test(
      explanation,
    );
  if (
    matchedTerms.length >= Math.min(3, requiredTerms.length) &&
    !negativeQuality
  )
    return null;
  return {
    verdict: "unknown",
    explanation: `verifier YES did not confirm enough requested visual criteria (${requiredTerms.join(", ")})`,
  };
}

function visualArtifactTerms(text: string): string[] {
  const artifactText =
    text.match(/\b(?:draw|drawing|drawn)\b(.+?)(?:\bstop\b|$)/)?.[1] ?? text;
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "app",
    "canvas",
    "create",
    "created",
    "design",
    "draw",
    "drawing",
    "file",
    "figma",
    "make",
    "made",
    "new",
    "on",
    "open",
    "simple",
    "the",
    "to",
    "visible",
    "with",
  ]);
  const terms = artifactText.match(/\b[a-z][a-z0-9-]{2,}\b/g) ?? [];
  return [
    ...new Set(
      terms.map((term) => term.trim()).filter((term) => !stopwords.has(term)),
    ),
  ].slice(0, 8);
}

function deterministicVerifyFromAx(args: {
  axTree: string;
  stopWhen: string;
  intent?: SkillIntent;
}): { verdict: "yes"; explanation: string } | null {
  if (requiresVisualVerification(args.stopWhen, args.intent)) return null;
  const haystack = normalizeForMatch(args.axTree);
  const signals = [
    args.stopWhen,
    ...(args.intent?.successSignals ?? []),
  ].flatMap(extractConcreteSignals);
  const hit = signals.find((signal) =>
    haystack.includes(normalizeForMatch(signal)),
  );
  return hit
    ? { verdict: "yes", explanation: `AX tree contains ${JSON.stringify(hit)}` }
    : null;
}

function requiresVisualVerification(
  stopWhen: string,
  intent?: SkillIntent,
): boolean {
  const text = normalizeForMatch(
    [stopWhen, intent?.goal, ...(intent?.successSignals ?? [])]
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );
  return (
    /\b(search results?|web ?page|browser page|page results?)\b/.test(text) ||
    /\b(draw|drawing|drawn|canvas|visual|artwork|diagram|shape|clock)\b/.test(
      text,
    )
  );
}

function extractConcreteSignals(text: string): string[] {
  const signals: string[] = [];
  for (const match of text.matchAll(/["'“”]([^"'“”]{2,80})["'“”]/g)) {
    if (match[1]) signals.push(match[1]);
  }
  for (const match of text.matchAll(
    /\b(?:shows?|reads?|contains?|display(?:s|ed)?)\s+([A-Za-z0-9][A-Za-z0-9 .:_-]{1,60})/gi,
  )) {
    if (match[1]) signals.push(match[1].trim());
  }
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) {
    if (match[0].length >= 2) signals.push(match[0]);
  }
  return [
    ...new Set(signals.map((s) => s.trim()).filter((s) => s.length >= 2)),
  ];
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function defaultSnapshot(
  pid: number,
  windowId: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const snap = await runCuaDriverCapture([
    "call",
    "get_window_state",
    JSON.stringify({ pid, window_id: windowId }),
  ]);
  return {
    ok: snap.ok,
    stdout: snap.stdout,
    error: snap.ok ? undefined : snap.stderr.trim() || snap.stdout.trim(),
  };
}

export interface DiscoveryResult {
  pid: number;
  windowId: number;
  /** Structured AX entries from the target window. */
  axIndex: import("./executor.ts").AxIndexEntry[];
  /** Pretty-printed AX tree + ids to thread into the planner prompt. */
  promptText: string;
  /**
   * Filesystem path to a PNG screenshot of the target window, captured
   * during pre-discovery. The planner attaches this as a vision block so
   * Sonnet can read off-screen affordances the AX tree omits (icons,
   * dialogs, color cues). Undefined when the screenshot subprocess failed —
   * the planner falls back to text-only.
   */
  screenshotPath?: string;
}

/**
 * Reads SKILL.md, finds the first reverse-DNS bundle id (e.g. com.apple.calculator),
 * launches that app via cua-driver, then snapshots the target window.
 *
 * Returns a {@link DiscoveryResult} containing the live pid + window_id, a
 * pre-built AX index map (so the executor doesn't need an in-plan
 * `get_window_state` to populate context), and a prompt-ready text block for
 * the planner. Returns null if discovery isn't possible (no bundle_id in
 * skill, cua-driver subprocess errors, etc.) — the planner then falls back to
 * placeholders and the executor will populate context via in-plan steps.
 */
async function preDiscoverAppState(
  skillMd: string,
): Promise<DiscoveryResult | null> {
  // PRIMARY path: structured `target.bundle_id` from frontmatter (Fix #8).
  const target = readTargetMetadata(skillMd);
  let bundleId: string | null = target?.bundleId ?? null;
  // Legacy fallback for SKILL.md files written before structured target
  // metadata was required. Deprecated — leave in place so older skills keep
  // working but the warning gives the user a path to fix it.
  if (!bundleId) {
    bundleId = extractBundleId(skillMd);
    if (!bundleId) {
      // Deprecated heuristic: match a running/installed app NAME against the
      // SKILL.md prose. Codex flagged this as fragile — Fix #8 makes compile
      // emit the bundle id directly so we don't need to guess.
      bundleId = await guessBundleIdByAppName(skillMd);
    }
    if (bundleId) {
      console.warn(
        "[showme] SKILL.md is missing structured `target.bundle_id` frontmatter; falling back to prose scan (deprecated). Re-run `showme compile` to regenerate.",
      );
    }
  }
  if (!bundleId) {
    console.warn(
      "[showme] no bundle_id found in SKILL.md and no app name matched a running/installed app; skipping pre-discovery",
    );
    return null;
  }

  // Launch (idempotent — returns existing pid if app already running).
  const launch = await runCuaDriverCapture([
    "call",
    "launch_app",
    JSON.stringify({ bundle_id: bundleId }),
  ]);
  if (!launch.ok) {
    console.warn(
      `[showme] launch_app(${bundleId}) failed: ${launch.stderr.trim() || "(no stderr)"}`,
    );
    return null;
  }
  let launchData: { pid?: number; windows?: Array<{ window_id?: number }> };
  try {
    launchData = JSON.parse(launch.stdout);
  } catch {
    return null;
  }
  const pid = launchData.pid;
  const windowId = launchData.windows?.[0]?.window_id;
  if (typeof pid !== "number" || typeof windowId !== "number") {
    return null;
  }

  // Snapshot the target window for the AX tree.
  const state = await runCuaDriverCapture([
    "call",
    "get_window_state",
    JSON.stringify({ pid, window_id: windowId }),
  ]);
  if (!state.ok) return null;

  // Trim AX tree to keep the prompt small. Most useful info is in the first
  // ~12k chars (the visible toolbar + main controls).
  const axTreeTrim = state.stdout.slice(0, 12_000);
  const axIndex = parseAxTreeIndex(state.stdout);

  // Best-effort: capture a PNG of the target window and stash it under /tmp
  // for the planner. Failure (TCC not granted, daemon flake) just drops the
  // screenshot — the rest of pre-discovery still proceeds.
  const screenshot = await captureFocusedWindowScreenshot(windowId);

  const promptText = [
    "Pre-discovery (already executed; the executor's context already holds pid, window_id, and the AX index — do NOT re-emit launch_app or get_window_state at the start of the plan):",
    `  bundle_id: ${bundleId}`,
    `  pid: ${pid}`,
    `  window_id: ${windowId}`,
    "",
    "AX tree of the target window. Use the __title / __ax_id / __selector synthetic keys (NOT element_index integers) to address controls — the executor will resolve them against this tree.",
    "",
    axTreeTrim,
  ].join("\n");

  return {
    pid,
    windowId,
    axIndex,
    promptText,
    screenshotPath: screenshot?.path,
  };
}

/**
 * Best-effort: shell out to `cua-driver call screenshot ... --image-out` and
 * return the path to the resulting PNG. Returns undefined on any failure so
 * callers can degrade to text-only planning.
 *
 * Uses /tmp + a random suffix to avoid collisions across concurrent runs.
 */
async function captureFocusedWindowScreenshot(
  windowId: number,
): Promise<CapturedScreenshot | undefined> {
  const path = `/tmp/showme-discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const out = await runCuaDriverCapture([
    "call",
    "screenshot",
    JSON.stringify({ window_id: windowId }),
    "--image-out",
    path,
  ]);
  if (!out.ok) {
    console.warn(
      `[showme] screenshot capture failed (continuing text-only): ${out.stderr.trim() || "(no stderr)"}`,
    );
    return undefined;
  }
  return await optimizeScreenshotForPlanner(path);
}

async function optimizeScreenshotForPlanner(
  path: string,
): Promise<CapturedScreenshot> {
  if (Bun.env.SHOWME_SCREENSHOT_OPTIMIZE === "0") {
    return { path, ...(await readImageDimensions(path)) };
  }
  const maxEdge = Number(Bun.env.SHOWME_SCREENSHOT_MAX_EDGE ?? 1280);
  if (!Number.isFinite(maxEdge) || maxEdge <= 0)
    return { path, ...(await readImageDimensions(path)) };

  // `sips -Z` caps the longer edge without upscaling smaller images. Keeping
  // PNG avoids JPEG artifacts on UI text while cutting image-token cost for
  // Retina/fullscreen captures.
  const outPath = path.replace(/\.png$/i, `.max${Math.round(maxEdge)}.png`);
  const proc = Bun.spawn(
    ["sips", "-Z", String(Math.round(maxEdge)), path, "--out", outPath],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.warn(
      `[showme] screenshot optimization failed (using original): ${stderr.trim() || "(no stderr)"}`,
    );
    return { path, ...(await readImageDimensions(path)) };
  }
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cleanup of the full-size original.
  }
  return { path: outPath, ...(await readImageDimensions(outPath)) };
}

async function readImageDimensions(
  path: string,
): Promise<{ width?: number; height?: number }> {
  const proc = Bun.spawn(
    ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return {
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
  };
}

function screenshotPath(
  shot: string | CapturedScreenshot | undefined,
): string | undefined {
  return typeof shot === "string" ? shot : shot?.path;
}

const BUNDLE_ID_RE =
  /\b((?:com|org|io|net|app|us|edu|me|co|info)\.[a-zA-Z0-9._-]{2,})\b/;

function extractBundleId(skillMd: string): string | null {
  const m = skillMd.match(BUNDLE_ID_RE);
  return m?.[1] ?? null;
}

// `cua-driver call list_apps` line format:
//   - AppName (pid 1234) [com.example.app]   ← running
//   - AppName [com.example.app]              ← installed but not running
const APP_LINE_RE =
  /^-\s+(.+?)\s+(?:\(pid\s+\d+\)\s+)?\[([a-zA-Z0-9._-]+)\]\s*$/;

interface AppEntry {
  name: string;
  bundleId: string;
  pid?: number;
}

function parseListAppsOutput(stdout: string): AppEntry[] {
  const apps: AppEntry[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(APP_LINE_RE);
    if (m?.[1] && m[2]) {
      const pidMatch = line.match(/\(pid\s+(\d+)\)/);
      const pid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
      apps.push({ name: m[1].trim(), bundleId: m[2], pid });
    }
  }
  return apps;
}

/**
 * Given a SKILL.md and a list of apps cua-driver knows about, pick the bundle
 * id whose app NAME appears EARLIEST in the SKILL.md text. The earliest match
 * wins because compiled SKILL.md files typically name the target app in the
 * title or the first sentence (e.g. "# Calculator: 17 × 23"); other app names
 * mentioned later (Finder, Safari) are usually decoration.
 */
function pickBundleIdByEarliestMention(
  skillMd: string,
  apps: AppEntry[],
): string | null {
  const lower = skillMd.toLowerCase();
  let best: { app: AppEntry; position: number } | null = null;
  for (const app of apps) {
    const idx = lower.indexOf(app.name.toLowerCase());
    if (idx < 0) continue;
    if (best === null || idx < best.position) best = { app, position: idx };
  }
  return best?.app.bundleId ?? null;
}

async function guessBundleIdByAppName(skillMd: string): Promise<string | null> {
  const out = await runCuaDriverCapture(["call", "list_apps"]);
  if (!out.ok) return null;
  const apps = parseListAppsOutput(out.stdout);
  if (apps.length === 0) return null;
  return pickBundleIdByEarliestMention(skillMd, apps);
}

// Exported for tests.
export const _internals = {
  extractBundleId,
  parseListAppsOutput,
  pickBundleIdByEarliestMention,
};

interface InitialLiveState {
  context: ExecutorContext;
  promptText: string;
  screenshot?: CapturedScreenshot;
  app: AppEntry;
}

async function discoverInitialLiveState(
  taskPrompt: string,
): Promise<InitialLiveState | null> {
  const appsOut = await runCuaDriverCapture(["call", "list_apps"]);
  if (!appsOut.ok) return null;
  const lowerTask = taskPrompt.toLowerCase();
  const apps = parseListAppsOutput(appsOut.stdout);
  const named = apps.filter(
    (app) =>
      lowerTask.includes(app.name.toLowerCase()) ||
      lowerTask.includes(app.bundleId.toLowerCase()),
  );
  const running = apps.filter((app) => app.pid !== undefined);
  const candidatePool = named.length > 0 ? named : running;
  const candidates = candidatePool.filter(
    (app, index, all) =>
      all.findIndex((other) => other.bundleId === app.bundleId) === index,
  );
  for (const app of candidates.slice(0, 8)) {
    // `cua-driver launch_app` is a hidden/background primitive. Use it even for
    // already-running apps so we get a pid/window list without stealing focus.
    const pid = (await launchAppForDiscovery(app.bundleId)) ?? app.pid;
    if (typeof pid !== "number") continue;
    const windowsOut = await runCuaDriverCapture([
      "call",
      "list_windows",
      JSON.stringify({ pid }),
    ]);
    if (!windowsOut.ok) continue;
    const blocker = blockingDialogFromWindows(windowsOut.stdout);
    const windowId = firstWindowId(windowsOut.stdout);
    if (windowId === null) continue;
    const state = await runCuaDriverCapture(
      [
        "call",
        "get_window_state",
        JSON.stringify({ pid, window_id: windowId }),
      ],
      5_000,
    );
    if (!state.ok) continue;
    const axIndex = parseAxTreeIndex(state.stdout);
    const screenshot = await captureFocusedWindowScreenshot(windowId);
    const screenshotLines =
      screenshot?.width && screenshot.height
        ? [
            "",
            "Attached screenshot metadata:",
            `  screenshot_width: ${screenshot.width}`,
            `  screenshot_height: ${screenshot.height}`,
            "Use these exact dimensions in drag args when using screenshot coordinates.",
          ]
        : [];
    return {
      context: {
        pid,
        windowId,
        axIndex,
        screenshotWidth: screenshot?.width,
        screenshotHeight: screenshot?.height,
      },
      app,
      screenshot,
      promptText: [
        "Initial live state from the selected target app/window candidate:",
        `  app_name: ${app.name}`,
        `  bundle_id: ${app.bundleId}`,
        `  pid: ${pid}`,
        `  window_id: ${windowId}`,
        ...(blocker
          ? [
              "",
              "Blocking modal/dialog detected:",
              `  title: ${blocker.title}`,
              `  window_id: ${blocker.windowId}`,
              "This dialog is currently above the working window. If the user's task is not about choosing/opening/saving a file, dismiss it first using visible UI (Cancel/Escape/close), then continue in the app.",
            ]
          : []),
        ...screenshotLines,
        "",
        "Compact actionable AX state:",
        compactAxTreeForPrompt(state.stdout),
      ].join("\n"),
    };
  }
  return null;
}

async function launchAppForDiscovery(bundleId: string): Promise<number | null> {
  const launch = await runCuaDriverCapture([
    "call",
    "launch_app",
    JSON.stringify({ bundle_id: bundleId }),
  ]);
  if (!launch.ok) return await pidForBundleId(bundleId);
  try {
    const parsed = JSON.parse(launch.stdout) as { pid?: number };
    return typeof parsed.pid === "number"
      ? parsed.pid
      : await pidForBundleId(bundleId);
  } catch {
    return await pidForBundleId(bundleId);
  }
}

async function pidForBundleId(bundleId: string): Promise<number | null> {
  const appsOut = await runCuaDriverCapture(["call", "list_apps"]);
  if (!appsOut.ok) return null;
  const app = parseListAppsOutput(appsOut.stdout).find(
    (entry) => entry.bundleId === bundleId,
  );
  return app?.pid ?? null;
}

function firstWindowId(stdout: string): number | null {
  try {
    const parsed = JSON.parse(stdout) as {
      windows?: Array<{
        window_id?: number;
        title?: string;
        bounds?: { width?: number; height?: number };
        is_on_screen?: boolean;
        on_current_space?: boolean;
        z_index?: number;
      }>;
    };
    const windows = parsed.windows ?? [];
    const usable =
      windows
        .filter((window) => typeof window.window_id === "number")
        .sort((a, b) => windowScore(b) - windowScore(a))
        .find((window) => {
          const width = Number(window.bounds?.width ?? 0);
          const height = Number(window.bounds?.height ?? 0);
          return (
            width >= 240 &&
            height >= 160 &&
            window.is_on_screen !== false &&
            window.on_current_space !== false
          );
        }) ??
      windows
        .filter((window) => typeof window.window_id === "number")
        .sort((a, b) => windowScore(b) - windowScore(a))
        .find((window) => {
          const width = Number(window.bounds?.width ?? 0);
          const height = Number(window.bounds?.height ?? 0);
          return width >= 240 && height >= 160;
        }) ??
      windows.find((window) => typeof window.window_id === "number");
    const id = usable?.window_id;
    return typeof id === "number" ? id : null;
  } catch {
    const match = stdout.match(/\bwindow_id["=:\s]+(\d+)/);
    return match?.[1] ? Number(match[1]) : null;
  }
}

function blockingDialogFromWindows(
  stdout: string,
): { windowId: number; title: string } | null {
  try {
    const parsed = JSON.parse(stdout) as {
      windows?: Array<{
        window_id?: number;
        title?: string;
        bounds?: { width?: number; height?: number };
        is_on_screen?: boolean;
        on_current_space?: boolean;
        z_index?: number;
      }>;
    };
    const visible = (parsed.windows ?? [])
      .filter((window) => typeof window.window_id === "number")
      .filter(
        (window) =>
          window.is_on_screen !== false && window.on_current_space !== false,
      )
      .sort((a, b) => Number(b.z_index ?? 0) - Number(a.z_index ?? 0));
    const top = visible[0];
    const title = top?.title?.trim() ?? "";
    const width = Number(top?.bounds?.width ?? 0);
    const height = Number(top?.bounds?.height ?? 0);
    if (
      top?.window_id !== undefined &&
      width >= 240 &&
      height >= 120 &&
      /\b(open|save|import|export|place|choose|select|file|dialog)\b/i.test(
        title,
      )
    ) {
      return { windowId: top.window_id, title: title || "Untitled dialog" };
    }
  } catch {
    return null;
  }
  return null;
}

function windowScore(window: {
  title?: string;
  bounds?: { width?: number; height?: number };
  is_on_screen?: boolean;
  on_current_space?: boolean;
  z_index?: number;
}) {
  const area =
    Number(window.bounds?.width ?? 0) * Number(window.bounds?.height ?? 0);
  const titleBonus = window.title?.trim() ? 50_000 : 0;
  const visibleBonus = window.is_on_screen === false ? -1_000_000 : 500_000;
  const spaceBonus = window.on_current_space === false ? -1_000_000 : 500_000;
  const zBonus = Number(window.z_index ?? 0);
  return area + titleBonus + visibleBonus + spaceBonus + zBonus;
}

function compactAxTreeForPrompt(stdout: string): string {
  const entries = parseAxTreeIndex(stdout);
  const actionableRoles = new Set([
    "AXButton",
    "AXTextField",
    "AXTextArea",
    "AXTextEdit",
    "AXComboBox",
    "AXCheckBox",
    "AXRadioButton",
    "AXMenuButton",
    "AXPopUpButton",
    "AXStaticText",
  ]);
  const lines = entries
    .filter((entry) => actionableRoles.has(entry.role))
    .slice(0, 160)
    .map((entry) => {
      const parts = [`[${entry.index}]`, entry.role];
      if (entry.title) parts.push(JSON.stringify(entry.title));
      if (entry.id) parts.push(`id=${entry.id}`);
      if (entry.ordinal > 0) parts.push(`ordinal=${entry.ordinal}`);
      return `- ${parts.join(" ")}`;
    });
  return lines.length > 0 ? lines.join("\n") : stdout.slice(0, 12_000);
}

async function discoverAppsForPrompt(
  taskPrompt: string,
  includeMemory = true,
): Promise<string | null> {
  const out = await runCuaDriverCapture(["call", "list_apps"]);
  if (!out.ok) return null;
  const apps = parseListAppsOutput(out.stdout);
  const lowerTask = taskPrompt.toLowerCase();
  const candidates = apps
    .filter(
      (app) =>
        app.pid !== undefined ||
        lowerTask.includes(app.name.toLowerCase()) ||
        lowerTask.includes(app.bundleId.toLowerCase()),
    )
    .slice(0, 30);
  const memories = includeMemory
    ? renderRelevantMemoriesForPrompt(candidates)
    : null;
  return [
    "Relevant running/installed app candidates. Use these to choose bundle_id for launch_app when needed:",
    ...candidates.map(
      (app) =>
        `- ${app.name}${app.pid !== undefined ? ` (pid ${app.pid})` : ""} [${app.bundleId}]`,
    ),
    ...(memories ? ["", memories] : []),
  ].join("\n");
}

function learnFromVerifierFeedback(args: {
  taskPrompt: string;
  explanation: string;
  initialState: InitialLiveState | null;
  enabled: boolean;
}): void {
  if (!args.enabled) return;
  const app = args.initialState?.app;
  if (!app) return;
  const lower = args.explanation.toLowerCase();
  const evidence = [
    `task: ${args.taskPrompt}`,
    `verifier: ${args.explanation}`,
  ];
  try {
    if (/\bmenu bar|screenshot only shows|no canvas\b/.test(lower)) {
      addAppMemoryFact({
        bundleId: app.bundleId,
        appName: app.name,
        kind: "avoid",
        description:
          "Do not use tiny menu-bar/chrome-only windows as the task window; prefer the largest content window with a visible workspace.",
        confidence: 0.9,
        scope: "window selection",
        cause: "wrong_window",
        evidence,
      });
    }
    if (/\bmissing|quality issues|not clean|messy|incomplete\b/.test(lower)) {
      addAppMemoryFact({
        bundleId: app.bundleId,
        appName: app.name,
        kind: "observation",
        description:
          "Verifier rejected the current approach; use the live UI to change strategy instead of repeating the same gestures.",
        confidence: 0.6,
        scope: "task strategy",
        cause: "verifier_quality_failure",
        evidence,
      });
    }
  } catch {
    // Memory is opportunistic; never fail a live automation because learning failed.
  }
}

function buildSystemPrompt(
  taskPrompt: string,
  criteria?: string,
  allowForeground = false,
): string {
  const criteriaBlock = criteria?.trim()
    ? `\n\nSUCCESS CRITERIA:\n${criteria.trim()}`
    : "";
  const executionBlock = allowForeground
    ? "Foreground opt-in is enabled for this run. Prefer background-safe pid/window-targeted actions, but foreground/global primitives are allowed if the task cannot otherwise proceed."
    : "Non-blocking invariant: do not steal focus, do not require the target app to be frontmost, and do not rely on the human's real cursor. Use pid/window-targeted actions. If the task cannot be completed without foreground/global control, stop and explain that foreground control is required.";
  return `You are an agent completing the user's macOS task via cua-driver.

You have access to cua-driver MCP tools: click, type_text, get_window_state, screenshot, press_key, hotkey, list_apps, list_windows, launch_app, scroll.

${executionBlock}

Before each tool call, the system will preview your intended action to the user. Be concise and intentional.

Stop when the user's task is complete OR you cannot proceed (e.g., unrecognized modal, stuck state).

TASK:
${taskPrompt}${criteriaBlock}`;
}

function summarizeToolCall(
  tool: string,
  args: Record<string, unknown>,
): string {
  if (tool.endsWith("click"))
    return `click element ${(args.element_index as number) ?? `${args.x},${args.y}`}`;
  if (tool.endsWith("type_text")) return `type ${JSON.stringify(args.text)}`;
  if (tool.endsWith("press_key")) return `press ${args.key}`;
  if (tool.endsWith("hotkey"))
    return `hotkey ${(args.modifiers as string[])?.join("+")}`;
  if (tool.endsWith("launch_app")) return `launch ${args.bundle_id}`;
  if (tool.endsWith("get_window_state"))
    return `snapshot window ${args.window_id}`;
  return `${tool}(${JSON.stringify(args)})`;
}

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  return buf.toLowerCase() === "y" || buf.toLowerCase() === "yes";
}

async function loadRealQuery(): Promise<QueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  // biome-ignore lint/suspicious/noExplicitAny: SDK input type isn't exported.
  return (input) => sdk.query(input as any) as AsyncIterable<unknown>;
}
