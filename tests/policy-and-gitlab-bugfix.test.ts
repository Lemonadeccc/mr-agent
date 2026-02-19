import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepoPolicyConfig,
  parseYamlBoolean,
  resolveGitHubReviewBehaviorPolicy,
} from "../src/integrations/github/github-policy.ts";
import {
  buildMergeRequestPayloadFromNote,
  inferMergeRequestLabels,
  mapGitLabStatusToConclusion,
} from "../src/integrations/gitlab/gitlab-review.ts";
import type { PullRequestReviewResult } from "../src/review/review-types.ts";

const lowRiskResult: PullRequestReviewResult = {
  summary: "ok",
  riskLevel: "low",
  reviews: [],
  positives: [],
  actionItems: [],
};

test("github parseYamlBoolean supports yes/on/1 and false/no/off/0", () => {
  assert.equal(parseYamlBoolean("yes"), true);
  assert.equal(parseYamlBoolean("'on'"), true);
  assert.equal(parseYamlBoolean("1"), true);

  assert.equal(parseYamlBoolean("no"), false);
  assert.equal(parseYamlBoolean("off"), false);
  assert.equal(parseYamlBoolean("0"), false);
});

test("gitlab check conclusion is semantic mapping, not raw status copy", () => {
  assert.equal(mapGitLabStatusToConclusion("success"), "success");
  assert.equal(mapGitLabStatusToConclusion("failed"), "failure");
  assert.equal(mapGitLabStatusToConclusion("running"), "pending");
  assert.equal(mapGitLabStatusToConclusion("canceled"), "cancelled");
  assert.equal(mapGitLabStatusToConclusion("manual"), "action_required");
  assert.equal(mapGitLabStatusToConclusion(undefined), "unknown");
});

test("gitlab title labels use whole-word boundaries", () => {
  const labelsFromDebug = inferMergeRequestLabels({
    title: "debug logging for auth flow",
    files: [],
    reviewResult: lowRiskResult,
    hasSecretFinding: false,
  });
  assert.equal(labelsFromDebug.includes("bugfix"), false);

  const labelsFromFix = inferMergeRequestLabels({
    title: "fix payment timeout bug",
    files: [],
    reviewResult: lowRiskResult,
    hasSecretFinding: false,
  });
  assert.equal(labelsFromFix.includes("bugfix"), true);

  const labelsFromPrefeature = inferMergeRequestLabels({
    title: "prefeature rollout notes",
    files: [],
    reviewResult: lowRiskResult,
    hasSecretFinding: false,
  });
  assert.equal(labelsFromPrefeature.includes("feature"), false);

  const labelsFromReadme = inferMergeRequestLabels({
    title: "update readme",
    files: [],
    reviewResult: lowRiskResult,
    hasSecretFinding: false,
  });
  assert.equal(labelsFromReadme.includes("docs"), true);
});

test("github yaml parser keeps quoted # in custom rules", () => {
  const config = parseRepoPolicyConfig([
    "review:",
    "  customRules:",
    '    - "变量命名用 #prefix 格式"',
  ].join("\n"));

  assert.deepEqual(config.review?.customRules, ["变量命名用 #prefix 格式"]);
});

test("github yaml parser throws on invalid tab indentation instead of silent skip", () => {
  assert.throws(() =>
    parseRepoPolicyConfig(["review:", "\taskCommandEnabled: false"].join("\n")),
  );
});

test("github yaml parser supports anchors/inline map and key aliases", () => {
  const config = parseRepoPolicyConfig([
    "defaults: &review_defaults",
    "  ask_command_enabled: no",
    "  include_ci_checks: yes",
    "review:",
    "  <<: *review_defaults",
    "pull_request: { requireLinkedIssue: yes, min_body_length: 8 }",
  ].join("\n"));

  assert.equal(config.review?.askCommandEnabled, false);
  assert.equal(config.review?.includeCiChecks, true);
  assert.equal(config.pullRequest?.requireLinkedIssue, true);
  assert.equal(config.pullRequest?.minBodyLength, 8);
});

test("github json policy parser rejects unexpected structure before normalize", () => {
  assert.throws(() =>
    parseRepoPolicyConfig(
      JSON.stringify({
        review: {
          customRules: "not-an-array",
        },
      }),
    ),
  );
});

test("github json policy parser keeps valid structures", () => {
  const config = parseRepoPolicyConfig(
    JSON.stringify({
      mode: "enforce",
      review: {
        askCommandEnabled: false,
        customRules: ["规则 A"],
      },
    }),
  );

  assert.equal(config.mode, "enforce");
  assert.equal(config.review?.askCommandEnabled, false);
  assert.deepEqual(config.review?.customRules, ["规则 A"]);
});

test("gitlab note payload builder accepts string iid and noteable_iid fallback", () => {
  const fromMergeRequest = buildMergeRequestPayloadFromNote({
    project: {
      id: 1,
      name: "demo",
      web_url: "https://gitlab.example.com/acme/demo",
    },
    object_attributes: {
      note: "/ask why",
      noteable_type: "MergeRequest",
      url: "https://gitlab.example.com/acme/demo/-/merge_requests/12#note_1",
    },
    merge_request: {
      iid: "12" as unknown as number,
      title: "feat: add endpoint",
      source_branch: "feat/x",
      target_branch: "main",
      url: "https://gitlab.example.com/acme/demo/-/merge_requests/12",
    },
  } as never);
  assert.equal(fromMergeRequest.object_attributes.iid, 12);

  const fromNoteableIid = buildMergeRequestPayloadFromNote({
    project: {
      id: 1,
      name: "demo",
      web_url: "https://gitlab.example.com/acme/demo",
    },
    object_attributes: {
      note: "/ask why",
      noteable_type: "MergeRequest",
      noteable_iid: "34" as unknown as number,
      url: "https://gitlab.example.com/acme/demo/-/merge_requests/34#note_2",
    },
    merge_request: {
      title: "feat: fallback iid",
      source_branch: "feat/y",
      target_branch: "main",
      url: "https://gitlab.example.com/acme/demo/-/merge_requests/34",
    },
  } as never);
  assert.equal(fromNoteableIid.object_attributes.iid, 34);
});

test("github review behavior policy exposes describe flags from repo config", async () => {
  const yaml = [
    "review:",
    "  describeEnabled: false",
    "  describeAllowApply: true",
  ].join("\n");
  const encoded = Buffer.from(yaml, "utf8").toString("base64");

  const policy = await resolveGitHubReviewBehaviorPolicy({
    context: {
      repo: () => ({ owner: "acme", repo: "demo" }),
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      octokit: {
        repos: {
          getContent: async () => ({
            data: {
              type: "file",
              content: encoded,
              encoding: "base64",
            },
          }),
        },
      },
    } as never,
  });

  assert.equal((policy as { describeEnabled?: boolean }).describeEnabled, false);
  assert.equal((policy as { describeAllowApply?: boolean }).describeAllowApply, true);
});
