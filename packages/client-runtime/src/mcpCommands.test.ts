import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { parseMcpCommand, supportsMcpManagement } from "./mcpCommands.ts";

describe("MCP composer commands", () => {
  it("recognizes list and workspace connection commands", () => {
    expect(parseMcpCommand(" /mcp ")).toEqual({ action: "list" });
    expect(parseMcpCommand("/mcp list")).toEqual({ action: "list" });
    expect(parseMcpCommand("/mcp enable context7")).toEqual({
      action: "set-enabled",
      server: "context7",
      enabled: true,
    });
    expect(parseMcpCommand("/mcp DISABLE My Server")).toEqual({
      action: "set-enabled",
      server: "My Server",
      enabled: false,
    });
  });

  it("keeps invalid management commands out of agent prompts without capturing ordinary text", () => {
    for (const text of ["/mcp enable", "/mcp remove github", "/mcp enable github\nDo other work"]) {
      expect(parseMcpCommand(text)).toEqual({ action: "invalid" });
    }
    for (const text of ["Explain /mcp", "/mcps", "/mcp-tools", "Use context7"]) {
      expect(parseMcpCommand(text)).toBeNull();
    }
  });

  it("offers management only for enabled OpenCode V2 instances", () => {
    const provider = {
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      version: "2.0.28",
    };
    expect(supportsMcpManagement(provider)).toBe(true);
    expect(supportsMcpManagement({ ...provider, version: "1.14.19" })).toBe(false);
    expect(supportsMcpManagement({ ...provider, version: null })).toBe(false);
    expect(supportsMcpManagement({ ...provider, enabled: false })).toBe(false);
    expect(supportsMcpManagement({ ...provider, driver: ProviderDriverKind.make("codex") })).toBe(
      false,
    );
  });
});
