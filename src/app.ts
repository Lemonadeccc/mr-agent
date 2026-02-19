import type { ApplicationFunction } from "probot";
import {
  resolveGitHubDescribePolicy,
  resolveGitHubPullRequestAutoReviewPolicy,
  resolveGitHubReviewBehaviorPolicy,
  runGitHubAsk,
  runGitHubDescribe,
  runGitHubIssuePolicyCheck,
  runGitHubPullRequestPolicyCheck,
  runGitHubReview,
} from "#integrations/github";
import { parseAskCommand, parseDescribeCommand, parseReviewCommand } from "#review";

const COMMAND = "/ai-review";

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
        enableSecretScan: autoReview.secretScanEnabled,
        enableAutoLabel: autoReview.autoLabelEnabled,
      });
    }
  });

  probot.on("pull_request.closed", async (context) => {
    if (!context.payload.pull_request.merged) {
      return;
    }

    await runGitHubReview({
      context,
      pullNumber: context.payload.pull_request.number,
      mode: "report",
      trigger: "merged",
    });
  });

  probot.on("issue_comment.created", async (context) => {
    const body = context.payload.comment.body?.trim() ?? "";
    if (!context.payload.issue.pull_request) {
      return;
    }

    const describe = parseDescribeCommand(body);
    if (describe.matched) {
      const describePolicy = await resolveGitHubDescribePolicy({
        context,
      });
      if (!describePolicy.enabled) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/describe` 在当前仓库已被禁用（.mr-agent.yml -> review.describeEnabled=false）。",
        });
        return;
      }

      if (describe.apply && !describePolicy.allowApply) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/describe --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.describeAllowApply=false）。",
        });
        return;
      }

      await runGitHubDescribe({
        context,
        pullNumber: context.payload.issue.number,
        apply: describe.apply && describePolicy.allowApply,
        trigger: "describe-command",
      });
      return;
    }

    const ask = parseAskCommand(body);
    if (ask.matched) {
      await runGitHubAsk({
        context,
        pullNumber: context.payload.issue.number,
        question: ask.question,
        trigger: "comment-command",
      });
      return;
    }

    if (!body.startsWith(COMMAND)) {
      return;
    }

    const command = parseReviewCommand(body);
    if (!command.matched) {
      return;
    }

    const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
      context,
    });
    await runGitHubReview({
      context,
      pullNumber: context.payload.issue.number,
      mode: command.mode,
      trigger: "comment-command",
      enableSecretScan: reviewBehavior.secretScanEnabled,
      enableAutoLabel: reviewBehavior.autoLabelEnabled,
    });
  });
};
