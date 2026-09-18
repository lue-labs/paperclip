import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const BLOCKER_ISSUE_ID_1 = "22222222-2222-4222-8222-222222222222";
const BLOCKER_ISSUE_ID_2 = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("issue update blocker flags", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("PAPERCLIP_API_KEY", undefined);
    vi.stubEnv("PAPERCLIP_API_URL", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the canonical unblockDescriptor shape for --unblock-owner-agent-id", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "issue", "update", ISSUE_ID,
      "--status", "blocked",
      "--unblock-owner-agent-id", AGENT_ID,
      "--unblock-action", "Review the finding",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      status: "blocked",
      unblockDescriptor: { owner: { agentId: AGENT_ID }, action: "Review the finding" },
    });
  });

  it("sends the canonical unblockDescriptor shape for --unblock-owner-user-id", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "issue", "update", ISSUE_ID,
      "--status", "blocked",
      "--unblock-owner-user-id", "user-123",
      "--unblock-action", "Approve the exception",
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      status: "blocked",
      unblockDescriptor: { owner: { userId: "user-123" }, action: "Approve the exception" },
    });
  });

  it("sends the canonical unblockDescriptor shape for --unblock-owner-board", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "issue", "update", ISSUE_ID,
      "--status", "blocked",
      "--unblock-owner-board",
      "--unblock-action", "Review the low-trust stop",
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Review the low-trust stop" },
    });
  });

  it("sends blockedByIssueIds parsed from a comma-separated list", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "issue", "update", ISSUE_ID,
      "--blocked-by-issue-ids", `${BLOCKER_ISSUE_ID_1}, ${BLOCKER_ISSUE_ID_2}`,
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      blockedByIssueIds: [BLOCKER_ISSUE_ID_1, BLOCKER_ISSUE_ID_2],
    });
  });

  it("can explicitly clear the blocker list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    await run(["issue", "update", ISSUE_ID, "--blocked-by-issue-ids", ""]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.blockedByIssueIds).toEqual([]);
  });

  it.each([
    ["invalid agent ID", ["--status", "blocked", "--unblock-owner-agent-id", "invalid", "--unblock-action", "Review"]],
    ["blank action", ["--status", "blocked", "--unblock-owner-board", "--unblock-action", "   "]],
    ["non-blocked status", ["--status", "done", "--unblock-owner-board", "--unblock-action", "Review"]],
    ["invalid blocker ID", ["--blocked-by-issue-ids", "invalid"]],
  ])("rejects %s before HTTP", async (_name, flags) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(["issue", "update", ISSUE_ID, ...flags]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits unblockDescriptor and blockedByIssueIds when no blocker flags are passed", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--title", "New title"]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("unblockDescriptor");
    expect(body).not.toHaveProperty("blockedByIssueIds");
  });

  it("rejects more than one --unblock-owner-* flag before making any HTTP request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await run([
      "issue", "update", ISSUE_ID,
      "--unblock-owner-agent-id", AGENT_ID,
      "--unblock-owner-board",
      "--unblock-action", "Review",
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects --unblock-action without any owner flag before making any HTTP request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await run([
      "issue", "update", ISSUE_ID,
      "--unblock-action", "Review",
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an owner flag without --unblock-action before making any HTTP request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await run([
      "issue", "update", ISSUE_ID,
      "--unblock-owner-board",
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed ownerType-style flags with an unknown option error before any HTTP request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      run([
        "issue", "update", ISSUE_ID,
        "--ownerType", "agent",
        "--unblock-action", "Review",
      ]),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
