import { describe, expect, it } from "vitest";
import {
  describeToolInput,
  summarizeToolInput,
  summarizeToolResult,
} from "./transcriptPresentation";

describe("summarizeToolInput", () => {
  it("prefers human descriptions over raw commands when both exist", () => {
    expect(
      summarizeToolInput("command_execution", {
        description: "Inspect the issue chat thread layout classes",
        command: "zsh -lc 'sed -n \"1,220p\" ui/src/components/IssueChatThread.tsx'",
      }),
    ).toBe("Inspect the issue chat thread layout classes");
  });
});

describe("summarizeToolResult", () => {
  it("uses a concise human preview for structured JSON results", () => {
    expect(summarizeToolResult(JSON.stringify({ status: "ok", items: [] }), false)).toBe("2 fields returned");
    expect(summarizeToolResult(JSON.stringify([{ id: 1 }, { id: 2 }]), false)).toBe("2 items returned");
  });

  it("does not expose structured JSON when the tool failed", () => {
    expect(summarizeToolResult(JSON.stringify({ error: "secret detail" }), true)).toBe("Tool failed");
  });
});

describe("describeToolInput", () => {
  it("keeps command tools description-first in the detail view", () => {
    expect(
      describeToolInput("command_execution", {
        description: "Inspect the issue chat thread layout classes",
        command: "zsh -lc 'sed -n \"1,220p\" ui/src/components/IssueChatThread.tsx'",
        cwd: "/workspace/paperclip",
      }),
    ).toEqual([
      { label: "Intent", value: "Inspect the issue chat thread layout classes", tone: "default" },
      { label: "Directory", value: "/workspace/paperclip", tone: "default" },
    ]);
  });

  it("surfaces concise structured details for file tools", () => {
    expect(
      describeToolInput("read_file", {
        path: "ui/src/lib/issue-chat-messages.ts",
      }),
    ).toEqual([
      { label: "Path", value: "ui/src/lib/issue-chat-messages.ts", tone: "default" },
    ]);
  });
});
