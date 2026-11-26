import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const externalUsage = { label: "GitHub Copilot usage", url: "https://github.com/settings/copilot" };
const MaxFrameBytes = 1024 * 1024;
const separator = Buffer.from("\r\n\r\n");
const nonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const formatCredits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const observation = Schema.Struct({
  unit: Schema.Literal("ai_credits"),
  observationKind: Schema.Literal("account_snapshot"),
  quantityKind: Schema.Literal("authoritative_budget"),
  acquisitionStatus: Schema.Literal("succeeded"),
  entitledQuantity: nonNegative,
  availableQuantity: nonNegative,
  budgetMetadata: Schema.Struct({
    resetAtEpochMs: Schema.optional(nonNegative),
    usageAllowedWhenExhausted: Schema.optional(Schema.Boolean),
    overageAllowedWhenExhausted: Schema.optional(Schema.Boolean),
  }),
});
const decodeObservation = Schema.decodeUnknownOption(observation);
const decodeQuota = Schema.decodeUnknownOption(
  Schema.Struct({ providerQuotas: Schema.Array(Schema.Unknown) }),
);
const responseSchema = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number })),
});
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(responseSchema));
const decodeSession = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export function copilotMonthlyWindow(payload: unknown): ServerProviderUsageWindow | undefined {
  const quota = decodeQuota(payload);
  if (Option.isNone(quota)) return undefined;
  const budgets = quota.value.providerQuotas
    .flatMap((value) => Option.toArray(decodeObservation(value)))
    .filter((budget) => budget.entitledQuantity > 0);
  if (budgets.length !== 1) return undefined;
  const budget = budgets[0]!;
  const used = Math.max(0, budget.entitledQuantity - budget.availableQuantity);
  const reset = DateTime.make(budget.budgetMetadata.resetAtEpochMs ?? NaN);
  return {
    id: "github-copilot-monthly",
    kind: "monthly",
    label: `Copilot: ${formatCredits.format(used)} / ${formatCredits.format(budget.entitledQuantity)} AI credits`,
    usedPercent: Math.min(100, (100 * used) / budget.entitledQuantity),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
    ...(budget.budgetMetadata.usageAllowedWhenExhausted === true ||
    budget.budgetMetadata.overageAllowedWhenExhausted === true
      ? { canContinueAfterExhaustion: true }
      : {}),
  };
}

class CopilotQuotaError extends Schema.TaggedError<
  CopilotQuotaError,
  { readonly brand: unique symbol }
>()("CopilotQuotaError", {}) {}

const probeFailed = new CopilotQuotaError();

export const readCopilotUsageLimits = Effect.fn("CopilotUsageLimits.read")(function* (input: {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly oauthToken?: string;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const result = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-quota-" });
    const env = {
      ...input.env,
      MISE_OFFLINE: "1",
      ...(input.oauthToken === undefined
        ? {}
        : { T3_COPILOT_QUOTA_TOKEN: input.oauthToken, COPILOT_GH_HOST: "https://github.com" }),
    };
    const { command, args, shell } = yield* resolveSpawnCommand(
      input.command,
      [
        ...(input.args ?? []).filter((arg) => arg !== "--acp"),
        "--headless",
        "--stdio",
        "--no-auto-update",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        ...(input.oauthToken === undefined
          ? []
          : ["--no-auto-login", "--auth-token-env", "T3_COPILOT_QUOTA_TOKEN"]),
      ],
      { env },
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: false,
        shell,
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    );
    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const incoming = yield* Queue.sliding<typeof responseSchema.Type>(8);
    let buffer = Buffer.alloc(0);
    const reader = child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length > 0) {
            const end = buffer.indexOf(separator);
            if (end < 0 && buffer.length <= 1024) return;
            if (end < 0 || end > 1024) return yield* probeFailed;
            const length = Number(
              /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(
                buffer.subarray(0, end).toString("ascii"),
              )?.[1],
            );
            if (!Number.isSafeInteger(length) || length < 1 || length > MaxFrameBytes)
              return yield* probeFailed;
            const start = end + separator.length;
            if (buffer.length < start + length) return;
            const response = decodeResponse(buffer.subarray(start, start + length).toString());
            buffer = buffer.subarray(start + length);
            if (
              Option.isSome(response) &&
              ("result" in response.value || response.value.error !== undefined)
            )
              yield* Queue.offer(incoming, response.value);
          }
        }),
      ),
      Effect.andThen(Effect.fail(probeFailed)),
    );
    let id = 0;
    const request = Effect.fnUntraced(function* (method: string, params: Record<string, unknown>) {
      const requestId = ++id;
      const body = yield* encodeRequest({ jsonrpc: "2.0", id: requestId, method, params });
      yield* Queue.offer(
        outgoing,
        Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`),
      );
      while (true) {
        const response = yield* Queue.take(incoming);
        if (response.id !== requestId) continue;
        if (response.error) return yield* probeFailed;
        return response.result;
      }
    });
    return yield* Effect.gen(function* () {
      const session = decodeSession(
        yield* request("session.create", {
          workingDirectory: cwd,
          configDirectory: cwd,
          enableConfigDiscovery: false,
          hooks: { enableRepositoryHooks: false, directories: [] },
          extensions: { enabled: false },
          skills: { enabled: false },
          git: { enableHostGitOperations: false },
          mcp: { servers: {} },
        }),
      );
      if (Option.isNone(session)) return yield* probeFailed;
      const params = { sessionId: session.value.sessionId };
      const quota = yield* request("session.quota.refresh", params).pipe(Effect.result);
      yield* request("session.destroy", params).pipe(Effect.timeout("1 second"), Effect.ignore);
      yield* request("session.delete", params).pipe(Effect.timeout("1 second"), Effect.ignore);
      if (quota._tag === "Failure") return yield* quota.failure;
      return copilotMonthlyWindow(quota.success);
    }).pipe(
      Effect.raceFirst(reader),
      Effect.raceFirst(
        Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.andThen(probeFailed)),
      ),
    );
  }).pipe(Effect.scoped, Effect.timeout("12 seconds"), Effect.result);
  return {
    checkedAt,
    externalUsage,
    windows: result._tag === "Success" && result.success ? [result.success] : [],
    ...(result._tag === "Failure" ? { unavailable: { reason: "probeFailed" as const } } : {}),
  } satisfies ServerProviderUsageLimits;
});
