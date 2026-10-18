import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";

import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as Mcp from "./mcp.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";

const setup = Effect.gen(function* () {
  const requests: Array<{ method: string; path: string; directory: string | undefined }> = [];
  const connected = new Map<string, boolean>();
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const directory =
        new URLSearchParams(UrlParams.toString(request.urlParams)).get("location[directory]") ??
        undefined;
      requests.push({ method: request.method, path, directory });
      if (path.endsWith("/connect")) connected.set(directory!, true);
      if (path.endsWith("/disconnect")) connected.set(directory!, false);
      return HttpClientResponse.fromWeb(
        request,
        request.method === "GET"
          ? Response.json({
              location: { directory: directory ?? "/missing" },
              data: [
                {
                  name: "context7",
                  status: { status: connected.get(directory!) ? "connected" : "disabled" },
                },
                {
                  name: "auth-server",
                  status: {
                    status: "needs_auth",
                    error: "private token must not reach the client",
                  },
                },
                { name: "t3-code-other-thread", status: { status: "connected" } },
              ],
            })
          : new Response(null, { status: 204 }),
      );
    }),
  );
  const api = yield* OpenCode2Client.make.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.flatMap((service) =>
      service.connect({ baseUrl: "http://opencode.test", password: "password" }),
    ),
  );
  const mcp = yield* Mcp.make.pipe(
    Effect.provideService(OpenCode2Server.OpenCode2Server, {
      withConnection: (use) =>
        use({ ...api, url: "http://opencode.test", version: "2.0.28", external: true }),
    }),
  );
  return { mcp, requests };
});

describe("OpenCode V2 MCP runtime management", () => {
  it.effect(
    "connects default-disabled servers and disconnects them without writing configuration",
    () =>
      Effect.gen(function* () {
        const { mcp, requests } = yield* setup;
        expect((yield* mcp.list("/workspace")).servers).toEqual([
          { name: "auth-server", status: "needs-auth" },
          { name: "context7", status: "disabled" },
        ]);
        expect(
          (yield* mcp.setEnabled({ cwd: "/workspace", server: "context7", enabled: true }))
            .servers[1]?.status,
        ).toBe("connected");
        expect((yield* mcp.list("/other-worktree")).servers[1]?.status).toBe("disabled");
        expect(
          (yield* mcp.setEnabled({ cwd: "/workspace", server: "context7", enabled: false }))
            .servers[1]?.status,
        ).toBe("disabled");
        expect(requests.filter((request) => request.method !== "GET")).toEqual([
          {
            method: "POST",
            path: "/api/experimental/mcp/context7/connect",
            directory: "/workspace",
          },
          {
            method: "POST",
            path: "/api/experimental/mcp/context7/disconnect",
            directory: "/workspace",
          },
        ]);
      }),
  );

  it.effect("protects T3-managed connections even for direct mutation requests", () =>
    Effect.gen(function* () {
      const { mcp, requests } = yield* setup;
      for (const server of ["t3-code", "t3-code-other-thread"]) {
        expect(
          (yield* mcp.setEnabled({ cwd: "/workspace", server, enabled: false }).pipe(Effect.flip))
            .reason,
        ).toBe("managed-server");
      }
      expect(requests).toEqual([]);
    }),
  );

  it.effect("addresses server names containing slashes as one path parameter", () =>
    Effect.gen(function* () {
      const { mcp, requests } = yield* setup;
      yield* mcp.setEnabled({ cwd: "/workspace", server: "microsoftdocs/mcp", enabled: true });
      expect(requests[0]?.path).toBe("/api/experimental/mcp/microsoftdocs%2Fmcp/connect");
    }),
  );

  it.effect("reports connection failures without exposing provider error details", () =>
    Effect.gen(function* () {
      const cause = new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "mcp",
        detail: "private connection credentials",
      });
      const mcp = yield* Mcp.make.pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, {
          withConnection: () => Effect.fail(cause),
        }),
      );
      const read = yield* mcp.list("/workspace").pipe(Effect.flip);
      const write = yield* mcp
        .setEnabled({ cwd: "/workspace", server: "context7", enabled: true })
        .pipe(Effect.flip);
      expect(read.reason).toBe("request-failed");
      expect(write.reason).toBe("request-failed");
      expect(read.cause).toBe(cause);
      expect(write.message).not.toContain("private connection credentials");
    }),
  );
});
