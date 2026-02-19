import type { ApplicationFunction } from "probot";
import {
  handleGitHubIssueCommentCommand,
  recordGitHubFeedbackSignal,
  resolveGitHubPullRequestAutoReviewPolicy,
  resolveGitHubReviewBehaviorPolicy,
  runGitHubIssuePolicyCheck,
  runGitHubPullRequestPolicyCheck,
  runGitHubReview,
} from "#integrations/github";

export const app: ApplicationFunction = (probot): void => {
  probot.log.info("AI reviewer app loaded (GitHub + GitLab compatible)");

  probot.on("issues.opened", async (context) => {
    if (context.payload.issue.pull_request) {
      return;
    }

    await runGitHubIssuePolicyCheck({
      context,
      issueNumber: context.payload.issue.number,
      title: context.payload.issue.title ?? "",
      body: context.payload.issue.body ?? "",
      ref: context.payload.repository.default_branch,
    });
  });

  probot.on("issues.edited", async (context) => {
    if (context.payload.issue.pull_request) {
      return;
    }

    await runGitHubIssuePolicyCheck({
      context,
      issueNumber: context.payload.issue.number,
      title: context.payload.issue.title ?? "",
      body: context.payload.issue.body ?? "",
      ref: context.payload.repository.default_branch,
    });
  });

  probot.on("pull_request.opened", async (context) => {
    await runGitHubPullRequestPolicyCheck({
      context,
      pullNumber: context.payload.pull_request.number,
      title: context.payload.pull_request.title ?? "",
      body: context.payload.pull_request.body ?? "",
      headSha: context.payload.pull_request.head.sha,
      baseRef: context.payload.pull_request.base.ref,
      detailsUrl: context.payload.pull_request.html_url,
    });

    const autoReview = await resolveGitHubPullRequestAutoReviewPolicy({
      context,
      baseRef: context.payload.pull_request.base.ref,
      action: "opened",
    });
    if (autoReview.enabled) {
      await runGitHubReview({
        context,
        pullNumber: context.payload.pull_request.number,
        mode: autoReview.mode,
        trigger: "pr-opened",
        dedupeSuffix: context.payload.pull_request.head.sha,
        customRules: autoReview.customRules,
        includeCiChecks: autoReview.includeCiChecks,
        enableSecretScan: autoReview.secretScanEnabled,
        enableAutoLabel: autoReview.autoLabelEnabled,
      });
    }
  });

  probot.on("pull_request.edited", async (context) => {
    await runGitHubPullRequestPolicyCheck({
      context,
      pullNumber: context.payload.pull_request.number,
      title: context.payload.pull_request.title ?? "",
      body: context.payload.pull_request.body ?? "",
      headSha: context.payload.pull_request.head.sha,
      baseRef: context.payload.pull_request.base.ref,
      detailsUrl: context.payload.pull_request.html_url,
    });

    const autoReview = await resolveGitHubPullRequestAutoReviewPolicy({
      context,
      baseRef: context.payload.pull_request.base.ref,
      action: "edited",
    });
    if (autoReview.enabled) {
      await runGitHubReview({
        context,
        pullNumber: context.payload.pull_request.number,
        mode: autoReview.mode,
        trigger: "pr-edited",
        dedupeSuffix: context.payload.pull_request.head.sha,
        customRules: autoReview.customRules,
        includeCiChecks: autoReview.includeCiChecks,
        enableSecretScan: autoReview.secretScanEnabled,
        enableAutoLabel: autoReview.autoLabelEnabled,
      });
    }
  });

  probot.on("pull_request.synchronize", async (context) => {
    await runGitHubPullRequestPolicyCheck({
      context,
      pullNumber: context.payload.pull_request.number,
      title: context.payload.pull_request.title ?? "",
      body: context.payload.pull_request.body ?? "",
      headSha: context.payload.pull_request.head.sha,
      baseRef: context.payload.pull_request.base.ref,
      detailsUrl: context.payload.pull_request.html_url,
    });

    const autoReview = await resolveGitHubPullRequestAutoReviewPolicy({
      context,
      baseRef: context.payload.pull_request.base.ref,
      action: "synchronize",
    });
    if (autoReview.enabled) {
      await runGitHubReview({
        context,
        pullNumber: context.payload.pull_request.number,
        mode: autoReview.mode,
        trigger: "pr-synchronize",
        dedupeSuffix: context.payload.pull_request.head.sha,
        customRules: autoReview.customRules,
        includeCiChecks: autoReview.includeCiChecks,
        enableSecretScan: autoReview.secretScanEnabled,
        enableAutoLabel: autoReview.autoLabelEnabled,
      });
    }
  });

  probot.on("pull_request.closed", async (context) => {
    if (!context.payload.pull_request.merged) {
      return;
    }

    const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
      context,
      baseRef: context.payload.pull_request.base.ref,
    });
    await runGitHubReview({
      context,
      pullNumber: context.payload.pull_request.number,
      mode: "report",
      trigger: "merged",
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
      enableSecretScan: reviewBehavior.secretScanEnabled,
      enableAutoLabel: reviewBehavior.autoLabelEnabled,
    });
  });

  probot.on("pull_request_review_thread.resolved", async (context) => {
    const repoInfo = context.repo();
    const pullNumber = context.payload.pull_request?.number;
    if (!pullNumber) {
      return;
    }

    recordGitHubFeedbackSignal({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      pullNumber,
      signal: `PR #${pullNumber} review thread resolved: developer indicates suggestion fixed/high-value`,
    });
  });

  probot.on("pull_request_review_thread.unresolved", async (context) => {
    const repoInfo = context.repo();
    const pullNumber = context.payload.pull_request?.number;
    if (!pullNumber) {
      return;
    }

    recordGitHubFeedbackSignal({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      pullNumber,
      signal: `PR #${pullNumber} review thread unresolved: developer indicates suggestion still not satisfied`,
    });
  });

  probot.on("issue_comment.created", async (context) => {
    const body = context.payload.comment.body?.trim() ?? "";
    if (!context.payload.issue.pull_request) {
      return;
    }
    const repoInfo = context.repo();
    await handleGitHubIssueCommentCommand({
      context,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      issueNumber: context.payload.issue.number,
      body,
      commentUser: context.payload.comment.user,
      rateLimitPlatform: "github-app",
      throwOnError: false,
    });
  });
};
