import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS, heartbeatService } from "../services/heartbeat.ts";

// Regression coverage for a production incident: a transient Postgres error
// (HA failover dropping the connection, SQLSTATE 57P01) during the
// non-critical run-output-progress flush was propagated uncaught through the
// onLog callback and failed the heartbeat run as adapter_failed.
// flushOutputProgress must now catch its own DB errors so a dropped
// connection on this write does not fail the run.

const adapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute: adapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres output-progress flush resilience tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

/**
 * The rejected value flushOutputProgress ultimately awaits. `writeFencedRunPatch`
 * chains `.returning().then()` onto the `.where()` result for its CAS read-back,
 * so a bare rejected promise here would be orphaned: the awaited chain rejects
 * once and the original rejection surfaces again as an unhandled rejection,
 * which fails the run even though every assertion passes. Returning a
 * thenable whose `returning()` yields itself keeps exactly one rejection in
 * play, whether the caller awaits `.where()` directly or continues the chain.
 */
function rejectedFencedWrite(): Promise<never> & { returning: () => Promise<never> } {
  const rejection = Promise.reject(
    Object.assign(
      new Error(
        "canceling the wait for synchronous replication and terminating connection due to administrator command",
      ),
      { code: "57P01" },
    ),
  ) as Promise<never> & { returning: () => Promise<never> };
  // Attach before any await so the rejection is never momentarily unobserved.
  rejection.returning = () => rejection;
  // The chain below always observes it; this keeps Node from flagging the tick
  // between construction and the first `.then()` as an unhandled rejection.
  rejection.catch(() => {});
  return rejection;
}

/**
 * Wraps a real Db so that the specific `heartbeatRuns` update issued by
 * flushOutputProgress (identifiable by the `lastOutputSeq` field it alone
 * writes) fails with a simulated dropped-connection error, matching
 * Postgres SQLSTATE 57P01 seen in production during HA failover. All other
 * queries pass through untouched.
 */
function withOutputProgressFlushFailureInjected(realDb: Db): Db {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return (table: unknown) => {
          const builder = (target as unknown as { update: (t: unknown) => any }).update(table);
          if (table !== heartbeatRuns) return builder;
          const originalSet = builder.set.bind(builder);
          builder.set = (values: Record<string, unknown>) => {
            if (values && typeof values === "object" && "lastOutputSeq" in values) {
              return { where: () => rejectedFencedWrite() };
            }
            return originalSet(values);
          };
          return builder;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

/**
 * Same interception point as `withOutputProgressFlushFailureInjected`, but
 * only fails the first `lastOutputSeq` write; every write after that passes
 * through to the real DB. `attemptCounter` records every write attempt
 * (failed or not) so a test can assert how many times the DB was actually
 * hit, independent of how many log chunks triggered `flushOutputProgress`.
 */
function withOutputProgressFlushFailureInjectedOnce(realDb: Db, attemptCounter: { count: number }): Db {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return (table: unknown) => {
          const builder = (target as unknown as { update: (t: unknown) => any }).update(table);
          if (table !== heartbeatRuns) return builder;
          const originalSet = builder.set.bind(builder);
          builder.set = (values: Record<string, unknown>) => {
            if (values && typeof values === "object" && "lastOutputSeq" in values) {
              attemptCounter.count += 1;
              if (attemptCounter.count === 1) {
                return { where: () => rejectedFencedWrite() };
              }
            }
            return originalSet(values);
          };
          return builder;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function errorHasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === code) return true;
    current = record.cause;
  }
  return false;
}

async function truncateCompaniesWithDeadlockRetry(db: Db) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      return;
    } catch (error) {
      if (!errorHasPostgresCode(error, "40P01") || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return heartbeat.getRun(runId);
}

async function seedRunTarget(db: Db) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await db.insert(companies).values({
    id: companyId,
    name: "Flush Resilience Co",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
    defaultResponsibleUserId: "responsible-user",
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
    },
    permissions: {},
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Survive a dropped connection during output-progress flush",
    status: "in_progress",
    priority: "medium",
    responsibleUserId: "responsible-user",
    assigneeAgentId: agentId,
    issueNumber: 1,
    identifier: `${issuePrefix}-1`,
  });

  return { companyId, agentId, issueId };
}

describeEmbeddedPostgres("heartbeat run output-progress flush resilience", () => {
  let realDb!: Db;
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flush-resilience-");
    realDb = createDb(tempDb.connectionString);
    db = withOutputProgressFlushFailureInjected(realDb);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockReset();
    await truncateCompaniesWithDeadlockRetry(realDb);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("completes the run and does not throw when the output-progress DB write fails", async () => {
    const { agentId, issueId } = await seedRunTarget(realDb);

    adapterExecute.mockImplementationOnce(async (input: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
      // Simulates a real child-process log chunk arriving mid-run. Before the
      // fix, the DB error thrown by the injected proxy above propagated
      // uncaught through this await and out of adapter.execute entirely.
      await input.onLog("stdout", "agent output while Postgres briefly drops the connection\n");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Completed despite a dropped output-progress flush.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);

    // The core regression assertion: this must resolve, not reject or crash
    // the process, even though the onLog-triggered flush fails underneath it.
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", skipIssueComment: true },
    });
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({ status: "succeeded", errorCode: null, error: null });
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    // The flush itself silently failed and was never retried mid-run, so the
    // progress fields it would have written stay at their pre-run defaults —
    // proof the error was swallowed rather than secretly succeeding.
    expect(finishedRun?.lastOutputSeq).toBe(0);
  }, 20_000);

  it("bounds retries after a failed flush and recovers once the flush interval elapses", async () => {
    const { agentId, issueId } = await seedRunTarget(realDb);
    const attemptCounter = { count: 0 };
    const failOnceDb = withOutputProgressFlushFailureInjectedOnce(realDb, attemptCounter);

    const startTime = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startTime);

    try {
      adapterExecute.mockImplementationOnce(async (input: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
        // First chunk: the flush attempt fails. Per the fix, this must still
        // advance the throttle timestamp instead of leaving it unset.
        await input.onLog("stdout", "chunk 1\n");

        // Two more chunks arrive well inside the flush interval opened by the
        // failed attempt. Before the fix, each of these retried the DB write
        // on every chunk; now they must be throttled with no further writes.
        vi.setSystemTime(new Date(startTime.getTime() + 10_000));
        await input.onLog("stdout", "chunk 2\n");
        vi.setSystemTime(new Date(startTime.getTime() + 20_000));
        await input.onLog("stdout", "chunk 3\n");

        // Once the interval has genuinely elapsed, the next chunk must flush
        // again and succeed.
        vi.setSystemTime(new Date(startTime.getTime() + ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS + 5_000));
        await input.onLog("stdout", "chunk 4\n");

        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: "Completed after a bounded retry and a recovered flush.",
          provider: "test",
          model: "test-model",
        };
      });

      const heartbeat = heartbeatService(failOnceDb);
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", skipIssueComment: true },
      });
      expect(run).not.toBeNull();

      // waitForRunToFinish polls with real setTimeouts and compares against
      // real Date.now(), so time-travel bookkeeping must not leak past the
      // point where the mocked run has already produced its chunks.
      vi.useRealTimers();
      const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
      expect(finishedRun).toMatchObject({ status: "succeeded", errorCode: null, error: null });

      // Chunks 2 and 3 landed inside the throttle window opened by the failed
      // first attempt, so they must not have triggered their own DB writes:
      // exactly two attempts total (the failed one, then the recovered one).
      // This holds regardless of any other log lines the run pipeline itself
      // emits before "chunk 1" (e.g. a fresh-session notice on a brand-new
      // agent), since those land at the same instant as the failed attempt
      // and are throttled by the same window.
      expect(attemptCounter.count).toBe(2);

      // The recovered flush persisted chunk 4's progress, proving the run can
      // flush again once the interval has genuinely elapsed. Assert on the
      // timestamp (an exact value we control) rather than the sequence
      // number, which also counts any log lines the pipeline emits before
      // "chunk 1".
      expect(finishedRun?.lastOutputAt).toEqual(new Date(startTime.getTime() + ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS + 5_000));
      expect(finishedRun?.lastOutputSeq).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
