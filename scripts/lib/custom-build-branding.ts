import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export function isCustomBuildBranch(branch: string): boolean {
  return /^custom_builds\/\d{4}_\d{2}_\d{2}_\d{2}_\d{2}$/.test(branch.trim());
}

export const readCustomBuildBranding = Effect.fn("readCustomBuildBranding")(function* (
  repoRoot: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make("git", ["branch", "--show-current"], { cwd: repoRoot }))
    .pipe(
      Effect.map(isCustomBuildBranch),
      Effect.orElseSucceed(() => false),
    );
});
