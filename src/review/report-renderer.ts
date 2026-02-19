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
const CHECKS_COMMAND_RE = /^\/(?:checks|ai-review\s+checks)(?:\s+([\s\S]+))?\s*$/i;
const GENERATE_TESTS_COMMAND_RE =
  /^\/(?:generate[_-]?tests|ai-review\s+generate[_-]?tests)(?:\s+([\s\S]+))?\s*$/i;
const CHANGELOG_COMMAND_RE =
  /^\/(?:changelog|ai-review\s+changelog)(?:\s+--apply)?(?:\s+([\s\S]+))?\s*$/i;
const FEEDBACK_COMMAND_RE =
  /^\/(?:feedback|ai-review\s+feedback)\s+(resolved|dismissed|up|down)(?:\s+([\s\S]+))?\s*$/i;

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

export function parseChecksCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CHECKS_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }

  return {
    matched: true,
    question: matched[1]?.trim() ?? "",
  };
}

export function parseGenerateTestsCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(GENERATE_TESTS_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseChangelogCommand(rawBody: string): {
  matched: boolean;
  apply: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CHANGELOG_COMMAND_RE);
  if (!matched) {
    return { matched: false, apply: false, focus: "" };
  }

  const focus = (matched[1] ?? "")
    .replace(/\s*--apply(?:\s|$)/gi, " ")
    .trim();

  return {
    matched: true,
    apply: /\s--apply(?:\s|$)/i.test(body),
    focus,
  };
}

export function parseFeedbackCommand(rawBody: string): {
  matched: boolean;
  action: "resolved" | "dismissed" | "up" | "down";
  note: string;
} {
  const body = rawBody.trim();
  const matched = body.match(FEEDBACK_COMMAND_RE);
  if (!matched) {
    return { matched: false, action: "up", note: "" };
  }

  const actionRaw = (matched[1] ?? "").toLowerCase();
  const action: "resolved" | "dismissed" | "up" | "down" =
    actionRaw === "resolved" ||
    actionRaw === "dismissed" ||
    actionRaw === "down"
      ? actionRaw
      : "up";

  return {
    matched: true,
    action,
    note: matched[2]?.trim() ?? "",
  };
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

  const suggestion = buildSuggestionBlock(review, options?.platform);
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
  const changeGraph = buildChangedFilesMermaid(files);

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
    ...(changeGraph
      ? ["", "### 变更结构图（Mermaid）", "", changeGraph]
      : []),
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

function buildSuggestionBlock(
  review: ReviewIssue,
  platform: "github" | "gitlab" | undefined,
): string | undefined {
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

  if (platform === "gitlab") {
    return ["```", sanitized, "```"].join("\n");
  }

  return ["```suggestion", sanitized, "```"].join("\n");
}

function buildChangedFilesMermaid(files: DiffFileContext[]): string | undefined {
  const uniquePaths = Array.from(
    new Set(
      files
        .map((file) => file.newPath?.trim())
        .filter((path): path is string => Boolean(path)),
    ),
  ).slice(0, 24);
  if (uniquePaths.length === 0) {
    return undefined;
  }

  const lines: string[] = ["```mermaid", "flowchart TD", '  PR["PR"]'];
  const topNodeIds = new Map<string, string>();
  const rootEdges = new Set<string>();

  let index = 0;
  for (const path of uniquePaths) {
    const [firstSegment] = path.split("/", 1);
    const topLevel = firstSegment && firstSegment.length > 0 ? firstSegment : "(root)";
    let topNodeId = topNodeIds.get(topLevel);
    if (!topNodeId) {
      topNodeId = `T${topNodeIds.size + 1}`;
      topNodeIds.set(topLevel, topNodeId);
      lines.push(`  ${topNodeId}["${escapeMermaidLabel(topLevel)}"]`);
    }

    const rootEdge = `PR-->${topNodeId}`;
    if (!rootEdges.has(rootEdge)) {
      rootEdges.add(rootEdge);
      lines.push(`  PR --> ${topNodeId}`);
    }

    index += 1;
    const fileNodeId = `F${index}`;
    lines.push(`  ${fileNodeId}["${escapeMermaidLabel(path)}"]`);
    lines.push(`  ${topNodeId} --> ${fileNodeId}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
