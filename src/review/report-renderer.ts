import { getDiffSnippet } from "./patch.js";
import { findFileForReview } from "./review-utils.js";
import { encodePath } from "#core";
import type {
  DiffFileContext,
  PullRequestReviewResult,
  ReviewIssue,
  ReviewMode,
  RiskLevel,
} from "./review-types.js";

export interface GitHubReportContext {
  platform: "github";
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
}

export interface GitLabReportContext {
  platform: "gitlab";
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
}

export type ReportContext = GitHubReportContext | GitLabReportContext;

const REVIEW_COMMAND_RE =
  /^\/ai-review(?:\s+(report|comment))?(?:\s+--mode=(report|comment))?\s*$/i;
const DESCRIBE_COMMAND_RE = /^\/(?:describe|ai-review\s+describe)(?:\s+--apply)?\s*$/i;
const ASK_COMMAND_RE = /^\/(?:ask|ai-review\s+ask)\s+([\s\S]+)$/i;

export function parseReviewCommand(rawBody: string): {
  matched: boolean;
  mode: ReviewMode;
} {
  const body = rawBody.trim();
  const matched = body.match(REVIEW_COMMAND_RE);
  if (!matched) {
    return { matched: false, mode: "report" };
  }

  const fromPositional = matched[1]?.toLowerCase();
  const fromFlag = matched[2]?.toLowerCase();
  const modeRaw = fromFlag ?? fromPositional ?? "report";

  return {
    matched: true,
    mode: modeRaw === "comment" ? "comment" : "report",
  };
}

export function parseDescribeCommand(rawBody: string): {
  matched: boolean;
  apply: boolean;
} {
  const body = rawBody.trim();
  if (!DESCRIBE_COMMAND_RE.test(body)) {
    return { matched: false, apply: false };
  }

  return {
    matched: true,
    apply: /\s--apply(?:\s|$)/i.test(body),
  };
}

export function parseAskCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(ASK_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }

  const question = matched[1]?.trim() ?? "";
  if (!question) {
    return { matched: false, question: "" };
  }

  return { matched: true, question };
}

export function buildIssueCommentMarkdown(
  review: ReviewIssue,
  options?: { platform?: "github" | "gitlab" },
): string {
  const content = [
    "<table>",
    "<thead><tr><td><strong>问题</strong></td><td><strong>描述</strong></td></tr></thead>",
    "<tbody>",
    `<tr><td>[${riskLabel(review.severity)}] ${review.issueHeader}</td><td>${review.issueContent}</td></tr>`,
    "</tbody>",
    "</table>",
  ];

  const suggestion =
    options?.platform === "github" || !options?.platform
      ? buildSuggestionBlock(review)
      : undefined;
  if (suggestion) {
    content.push("", suggestion);
  }

  return content.join("\n");
}

export function buildReportCommentMarkdown(
  result: PullRequestReviewResult,
  files: DiffFileContext[],
  context: ReportContext,
): string {
  const positives =
    result.positives.length === 0
      ? "- 无"
      : result.positives.map((item) => `- ${item}`).join("\n");

  const actionItems =
    result.actionItems.length === 0
      ? "- 无"
      : result.actionItems.map((item) => `- ${item}`).join("\n");

  const issuesTable = renderIssuesTable(result, files, context);

  return [
    "## AI 代码评审报告",
    "",
    `风险等级: **${riskLabel(result.riskLevel)}**`,
    "",
    "### 总结",
    result.summary,
    "",
    issuesTable,
    "",
    "### 正向反馈",
    positives,
    "",
    "### 建议后续动作",
    actionItems,
  ].join("\n");
}

function renderIssuesTable(
  result: PullRequestReviewResult,
  files: DiffFileContext[],
  context: ReportContext,
): string {
  if (result.reviews.length === 0) {
    return "### 问题清单\n- 未发现明确问题。";
  }

  let rows = "";
  for (const review of result.reviews) {
    const file = findFileForReview(files, review);
    const location = renderIssueLocation(review, file, context);

    rows += [
      "<tr>",
      `  <td>[${riskLabel(review.severity)}] ${review.issueHeader}</td>`,
      `  <td>${location}</td>`,
      `  <td>${review.issueContent}</td>`,
      "</tr>",
      "",
    ].join("\n");
  }

  return [
    "### 问题清单",
    "<table>",
    "<thead><tr><td><strong>问题</strong></td><td><strong>代码位置</strong></td><td><strong>描述</strong></td></tr></thead>",
    "<tbody>",
    rows.trim(),
    "</tbody>",
    "</table>",
  ].join("\n");
}

function renderIssueLocation(
  review: ReviewIssue,
  file: DiffFileContext | undefined,
  context: ReportContext,
): string {
  const path = review.type === "new" ? review.newPath : review.oldPath;
  const lineLabel = `第${review.startLine}到${review.endLine}行`;
  const link = buildCodeLink(review, context);
  const snippet = file
    ? getDiffSnippet(file, review.type, review.startLine, review.endLine)
    : "(no diff snippet available)";

  return [
    `[${path} ${lineLabel}](${link})`,
    "",
    "<details><summary>diff</summary>",
    "",
    "```diff",
    snippet,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function buildCodeLink(review: ReviewIssue, context: ReportContext): string {
  if (context.platform === "github") {
    const path = review.type === "new" ? review.newPath : review.oldPath;
    const sha = review.type === "new" ? context.headSha : context.baseSha;
    const encodedPath = encodePath(path);

    return `https://github.com/${context.owner}/${context.repo}/blob/${sha}/${encodedPath}#L${review.startLine}-L${review.endLine}`;
  }

  if (review.type === "new") {
    return `${context.webUrl}/-/blob/${context.sourceBranch}/${encodePath(review.newPath)}?ref_type=heads#L${review.startLine}-${review.endLine}`;
  }

  return `${context.webUrl}/-/blob/${context.targetBranch}/${encodePath(review.oldPath)}?ref_type=heads#L${review.startLine}-${review.endLine}`;
}

function riskLabel(level: RiskLevel): string {
  if (level === "high") {
    return "高";
  }

  if (level === "medium") {
    return "中";
  }

  return "低";
}

function buildSuggestionBlock(review: ReviewIssue): string | undefined {
  if (review.type !== "new") {
    return undefined;
  }

  const suggestion = review.suggestion?.trim();
  if (!suggestion) {
    return undefined;
  }

  const sanitized = suggestion.replace(/```/g, "'''" ).trim();
  if (!sanitized) {
    return undefined;
  }

  return ["```suggestion", sanitized, "```"].join("\n");
}
