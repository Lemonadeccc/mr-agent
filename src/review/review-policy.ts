import type { DiffFileContext, ReviewIssue } from "./review-types.js";

const DEFAULT_REVIEW_CODE_EXTENSIONS =
  "ts,tsx,js,jsx,vue,py,java,go,rs,php,rb,swift,kt,scala,c,cc,cpp,cs";

let cachedExtensionRaw = "";
let cachedExtensionSet = new Set<string>();

export type ReviewPlatform = "github" | "gitlab" | "any";

export const GITHUB_GUIDELINE_FILE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/codeowners",
  "CODEOWNERS",
  "CONTRIBUTING.md",
];

export const GITHUB_GUIDELINE_DIRECTORIES = [
  ".github/workflows",
  ".github/ISSUE_TEMPLATE",
  ".github/PULL_REQUEST_TEMPLATE",
];

export const GITLAB_GUIDELINE_FILE_PATHS = [
  ".gitlab-ci.yml",
  ".gitlab/CODEOWNERS",
  ".gitlab/codeowners",
  "CODEOWNERS",
  "CONTRIBUTING.md",
  ".github/codeowners",
];

export const GITLAB_GUIDELINE_DIRECTORIES = [
  ".gitlab/merge_request_templates",
  ".gitlab/issue_templates",
  ".gitlab/ci",
  ".github/ISSUE_TEMPLATE",
  ".github/PULL_REQUEST_TEMPLATE",
  ".github/workflows",
];

export function isReviewTargetFile(
  filePath: string,
  platform: Exclude<ReviewPlatform, "any">,
): boolean {
  return isCodeFile(filePath) || isProcessTemplateFile(filePath, platform);
}

export function isCodeFile(filePath: string): boolean {
  const fileName = filePath.trim().split(/[\\/]/).pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return false;
  }

  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  const allowList = getCodeExtensionAllowList();
  return allowList.has(extension);
}

export function isProcessTemplateFile(
  filePath: string,
  platform: ReviewPlatform = "any",
): boolean {
  const normalized = filePath.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    normalized === "codeowners" ||
    normalized === "contributing.md" ||
    normalized === ".github/codeowners" ||
    normalized === ".gitlab/codeowners" ||
    normalized === ".gitlab/merge_request_templates/default.md" ||
    normalized === ".gitlab-ci.yml"
  ) {
    return true;
  }

  if (platform === "github") {
    return isGitHubTemplatePath(normalized);
  }

  if (platform === "gitlab") {
    return isGitLabTemplatePath(normalized) || isGitHubTemplatePath(normalized);
  }

  return isGitHubTemplatePath(normalized) || isGitLabTemplatePath(normalized);
}

export function resolveReviewLineForIssue(
  file: DiffFileContext,
  review: ReviewIssue,
): number | undefined {
  const source =
    review.type === "new" ? file.newLinesWithNumber : file.oldLinesWithNumber;

  const [start, end] = normalizeLineRange(review.startLine, review.endLine);

  if (source.has(end)) {
    return end;
  }

  if (source.has(start)) {
    return start;
  }

  for (let line = end; line >= start; line -= 1) {
    if (source.has(line)) {
      return line;
    }
  }

  return undefined;
}

export function normalizeLineRange(
  startLine: number,
  endLine: number,
): [number, number] {
  const start = Math.max(1, Math.min(startLine, endLine));
  const end = Math.max(1, Math.max(startLine, endLine));
  return [start, end];
}

export function countPatchChanges(rawPatch: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const line of rawPatch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function getCodeExtensionAllowList(): Set<string> {
  const raw = (process.env.REVIEW_CODE_EXTENSIONS ?? DEFAULT_REVIEW_CODE_EXTENSIONS)
    .trim()
    .toLowerCase();

  if (raw === cachedExtensionRaw && cachedExtensionSet.size > 0) {
    return cachedExtensionSet;
  }

  cachedExtensionRaw = raw;
  cachedExtensionSet = new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return cachedExtensionSet;
}

function hasTemplateLikeExtension(path: string): boolean {
  return (
    path.endsWith(".md") ||
    path.endsWith(".yml") ||
    path.endsWith(".yaml") ||
    path.endsWith(".json") ||
    path.endsWith(".txt")
  );
}

function isGitHubTemplatePath(path: string): boolean {
  if (!path.startsWith(".github/")) {
    return false;
  }

  return (
    path.includes("template") ||
    path.includes("workflow") ||
    hasTemplateLikeExtension(path)
  );
}

function isGitLabTemplatePath(path: string): boolean {
  if (path === ".gitlab-ci.yml") {
    return true;
  }

  if (!path.startsWith(".gitlab/")) {
    return false;
  }

  return (
    path.includes("template") ||
    path.includes("workflow") ||
    path.includes("pipeline") ||
    path.includes("ci") ||
    hasTemplateLikeExtension(path)
  );
}
