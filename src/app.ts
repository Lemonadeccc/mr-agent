import type { ApplicationFunction } from "probot";
import {
  recordGitHubFeedbackSignal,
  resolveGitHubDescribePolicy,
  resolveGitHubPullRequestAutoReviewPolicy,
  resolveGitHubReviewBehaviorPolicy,
  runGitHubAsk,
  runGitHubChangelog,
  runGitHubDescribe,
  runGitHubIssuePolicyCheck,
  runGitHubPullRequestPolicyCheck,
  runGitHubReview,
} from "#integrations/github";
import {
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parseReviewCommand,
} from "#review";

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
      signal: `PR #${pullNumber} review thread resolved: 开发者倾向已修复/高价值建议`,
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
      signal: `PR #${pullNumber} review thread unresolved: 开发者认为建议仍未满足`,
    });
  });

  probot.on("issue_comment.created", async (context) => {
    const body = context.payload.comment.body?.trim() ?? "";
    if (!context.payload.issue.pull_request) {
      return;
    }

    const feedbackCommand = parseFeedbackCommand(body);
    if (feedbackCommand.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.feedbackCommandEnabled) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/feedback` 在当前仓库已被禁用（.mr-agent.yml -> review.feedbackCommandEnabled=false）。",
        });
        return;
      }

      const repoInfo = context.repo();
      const positive =
        feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
      const signalCore = positive
        ? "开发者更偏好高置信、可落地建议"
        : "开发者希望减少低价值或噪音建议";
      const noteText = feedbackCommand.note ? `；备注：${feedbackCommand.note}` : "";
      recordGitHubFeedbackSignal({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        signal: `PR #${context.payload.issue.number} ${feedbackCommand.action}: ${signalCore}${noteText}`,
      });
      await context.octokit.issues.createComment({
        ...repoInfo,
        issue_number: context.payload.issue.number,
        body: `已记录反馈信号：\`${feedbackCommand.action}\`。后续评审会参考该偏好。`,
      });
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
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.askCommandEnabled) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/ask` 在当前仓库已被禁用（.mr-agent.yml -> review.askCommandEnabled=false）。",
        });
        return;
      }
      await runGitHubAsk({
        context,
        pullNumber: context.payload.issue.number,
        question: ask.question,
        trigger: "comment-command",
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
      });
      return;
    }

    const checksCommand = parseChecksCommand(body);
    if (checksCommand.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.checksCommandEnabled) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/checks` 在当前仓库已被禁用（.mr-agent.yml -> review.checksCommandEnabled=false）。",
        });
        return;
      }

      const checksQuestion = checksCommand.question
        ? `请结合当前 PR 的 CI 检查结果给出修复建议。额外问题：${checksCommand.question}`
        : "请结合当前 PR 的 CI 检查结果，分析失败原因并给出可执行修复步骤（优先级从高到低）。";
      await runGitHubAsk({
        context,
        pullNumber: context.payload.issue.number,
        question: checksQuestion,
        trigger: "comment-command",
        customRules: reviewBehavior.customRules,
        includeCiChecks: true,
      });
      return;
    }

    const generateTests = parseGenerateTestsCommand(body);
    if (generateTests.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.generateTestsCommandEnabled) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/generate_tests` 在当前仓库已被禁用（.mr-agent.yml -> review.generateTestsCommandEnabled=false）。",
        });
        return;
      }
      const generateTestsQuestion = generateTests.focus
        ? `请基于当前 PR 改动生成可执行测试方案和测试代码草案，重点覆盖：${generateTests.focus}。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。`
        : "请基于当前 PR 改动生成可执行测试方案和测试代码草案。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。";
      await runGitHubAsk({
        context,
        pullNumber: context.payload.issue.number,
        question: generateTestsQuestion,
        trigger: "comment-command",
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
        commentTitle: "AI Test Generator",
        displayQuestion: generateTests.focus
          ? `/generate_tests ${generateTests.focus}`
          : "/generate_tests",
      });
      return;
    }

    const changelogCommand = parseChangelogCommand(body);
    if (changelogCommand.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.changelogCommandEnabled) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/changelog` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogCommandEnabled=false）。",
        });
        return;
      }
      if (changelogCommand.apply && !reviewBehavior.changelogAllowApply) {
        await context.octokit.issues.createComment({
          ...context.repo(),
          issue_number: context.payload.issue.number,
          body: "`/changelog --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogAllowApply=false）。",
        });
        return;
      }
      await runGitHubChangelog({
        context,
        pullNumber: context.payload.issue.number,
        trigger: "comment-command",
        focus: changelogCommand.focus,
        apply: changelogCommand.apply && reviewBehavior.changelogAllowApply,
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
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
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
      enableSecretScan: reviewBehavior.secretScanEnabled,
      enableAutoLabel: reviewBehavior.autoLabelEnabled,
    });
  });
};
