export type ReviewMode = "report" | "comment";

export type ReviewTrigger =
  | "merged"
  | "comment-command"
  | "describe-command"
  | "pr-opened"
  | "pr-edited"
  | "pr-synchronize"
  | "gitlab-webhook";

export type RiskLevel = "low" | "medium" | "high";

export type ReviewLineType = "old" | "new";

export interface ReviewIssue {
  severity: RiskLevel;
  newPath: string;
  oldPath: string;
  type: ReviewLineType;
  startLine: number;
  endLine: number;
  issueHeader: string;
  issueContent: string;
  suggestion?: string;
}

export interface PullRequestReviewResult {
  summary: string;
  riskLevel: RiskLevel;
  reviews: ReviewIssue[];
  positives: string[];
  actionItems: string[];
}

export interface ReviewFileForAI {
  newPath: string;
  oldPath: string;
  status: string;
  additions: number;
  deletions: number;
  extendedDiff: string;
}

export interface PullRequestReviewInput {
  platform: "github" | "gitlab";
  repository: string;
  number: number;
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  additions: number;
  deletions: number;
  changedFilesCount: number;
  changedFiles: ReviewFileForAI[];
  processGuidelines?: Array<{
    path: string;
    content: string;
  }>;
}

export interface DiffFileContext extends ReviewFileForAI {
  patch: string;
  oldLinesWithNumber: Map<number, string>;
  newLinesWithNumber: Map<number, string>;
}

export function normalizeRiskLevel(value: string): RiskLevel {
  if (value === "high") {
    return "high";
  }

  if (value === "medium") {
    return "medium";
  }

  return "low";
}
