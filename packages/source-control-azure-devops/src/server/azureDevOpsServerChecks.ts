import type { PullRequestCheck } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AzureDevOpsServerContext } from "./AzureDevOpsServerClient.ts";
import type * as Json from "./azureDevOpsServerJson.ts";

const BUILD_POLICY = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY = "cbdc66da-9728-4af8-aada-9a5a32e4a226";

export const Status = Schema.Struct({
  id: Schema.Int,
  state: Schema.String,
  context: Schema.Struct({ name: Schema.NonEmptyString, genre: Schema.optional(Schema.String) }),
  iterationId: Schema.optional(Schema.NullOr(Schema.Int)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  updatedDate: Schema.optional(Schema.String),
});

export const Policy = Schema.Struct({
  evaluationId: Schema.String,
  status: Schema.String,
  configuration: Schema.Struct({
    id: Schema.Int,
    isEnabled: Schema.Boolean,
    isBlocking: Schema.Boolean,
    isDeleted: Schema.optional(Schema.Boolean),
    type: Schema.Struct({ id: Schema.String, displayName: Schema.String }),
    settings: Schema.optional(
      Schema.Struct({
        displayName: Schema.optional(Schema.NullOr(Schema.String)),
        statusName: Schema.optional(Schema.String),
        statusGenre: Schema.optional(Schema.String),
      }),
    ),
  }),
  context: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        lastMergeSourceCommitId: Schema.optional(Schema.String),
        buildDefinitionName: Schema.optional(Schema.String),
        buildId: Schema.optional(Schema.Int),
        isExpired: Schema.optional(Schema.Boolean),
        buildIsNotCurrent: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

export function checks(
  statuses: ReadonlyArray<typeof Status.Type>,
  policies: ReadonlyArray<typeof Policy.Type>,
  iteration: Json.Iteration | undefined,
  context: AzureDevOpsServerContext,
  number: number,
): ReadonlyArray<PullRequestCheck> {
  const current = new Map<string, typeof Status.Type>();
  for (const status of statuses) {
    if (status.iterationId != null && status.iterationId !== iteration?.id) continue;
    const key = `${status.context.genre ?? ""}\0${status.context.name}`;
    if (status.id > (current.get(key)?.id ?? -1)) current.set(key, status);
  }
  const result: PullRequestCheck[] = [];
  for (const policy of policies) {
    const config = policy.configuration;
    if (!config.isEnabled || config.isDeleted || policy.status === "notApplicable") continue;
    const build = config.type.id.toLowerCase() === BUILD_POLICY;
    const statusPolicy = config.type.id.toLowerCase() === STATUS_POLICY;
    let status: PullRequestCheck["status"] =
      policy.status === "approved"
        ? "success"
        : policy.status === "rejected" || policy.status === "broken"
          ? "failure"
          : "pending";
    // Human/metadata policy approvals are not evidence that any CI ran.
    if (!build && !statusPolicy && status !== "failure") continue;
    if (build) {
      if (
        (status === "success" || policy.context?.lastMergeSourceCommitId !== undefined) &&
        (!iteration ||
          policy.context?.lastMergeSourceCommitId !== iteration.sourceRefCommit.commitId)
      )
        status = "pending";
      else if (policy.status === "queued" || policy.status === "running") status = "pending";
      else if (policy.context?.isExpired || policy.context?.buildIsNotCurrent)
        status = "action-required";
    }
    if (statusPolicy && status === "success") {
      const settings = config.settings;
      const posted = current.get(`${settings?.statusGenre ?? ""}\0${settings?.statusName ?? ""}`);
      if (!iteration || posted?.iterationId !== iteration.id || posted.state !== "succeeded")
        status = "pending";
    }
    const name =
      config.settings?.displayName?.trim() ||
      policy.context?.buildDefinitionName?.trim() ||
      config.type.displayName;
    const buildId = policy.context?.buildId;
    result.push({
      name: `Policy: ${name} (#${config.id})`,
      status,
      required: config.isBlocking,
      description:
        build && status === "pending"
          ? "Awaiting a build result for the current head."
          : `Azure policy: ${policy.status}`,
      url: buildId
        ? `${context.projectUrl}/_build/results?buildId=${buildId}`
        : `${context.repositoryUrl}/pullrequest/${number}`,
    });
  }
  for (const posted of current.values()) {
    if (posted.state === "notApplicable") continue;
    // A PR-level status has no revision identity; it cannot prove success for this head.
    const currentIteration = iteration !== undefined && posted.iterationId === iteration.id;
    const updatedSincePush =
      iteration?.createdDate !== undefined &&
      posted.updatedDate !== undefined &&
      Date.parse(posted.updatedDate) >= Date.parse(iteration.createdDate);
    const status: PullRequestCheck["status"] =
      (currentIteration || updatedSincePush) &&
      (posted.state === "failed" || posted.state === "error")
        ? "failure"
        : posted.state === "succeeded" && currentIteration
          ? "success"
          : "pending";
    result.push({
      name: `Status: ${posted.context.genre ? `${posted.context.genre}/` : ""}${posted.context.name}`,
      status,
      required: false,
      description: posted.description ?? null,
      url: posted.targetUrl ?? null,
    });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}
