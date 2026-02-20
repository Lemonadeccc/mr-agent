import {
  getFreshCacheValue,
  isDuplicateRequest,
  localizeText,
  pruneExpiredCache,
  readNumberEnv,
  resolveUiLocale,
  trimCache,
  type ExpiringCacheEntry,
  type UiLocale,
} from "#core";
import type { ReviewMode } from "#review";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { decodeGitHubFileContent } from "./github-content.js";
import type {
  GitHubCheckRunCreateParams,
  GitHubRepositoryContentFile,
  GitHubReviewContext,
} from "./github-review.js";

type PolicyMode = "remind" | "enforce";

interface PolicySectionConfig {
  enabled: boolean;
  minBodyLength: number;
  requiredSections: string[];
}

interface PullRequestPolicySectionConfig extends PolicySectionConfig {
  requireLinkedIssue: boolean;
}

interface ReviewPolicyConfig {
  enabled: boolean;
  mode: ReviewMode;
  onOpened: boolean;
  onEdited: boolean;
  onSynchronize: boolean;
  describeEnabled: boolean;
  describeAllowApply: boolean;
  checksCommandEnabled: boolean;
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  askCommandEnabled: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  feedbackCommandEnabled: boolean;
  customRules: string[];
}

interface RepoPolicyConfig {
  mode: PolicyMode;
  issue: PolicySectionConfig;
  pullRequest: PullRequestPolicySectionConfig;
  review: ReviewPolicyConfig;
}

interface RepoPolicyConfigCacheEntry extends ExpiringCacheEntry<RepoPolicyConfig> {}

interface MarkdownSection {
  heading: string;
  content: string;
}

const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_POLICY_COMMENT_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_POLICY_CHECK_NAME = "MR Agent Policy";

const CONFIG_PATH_CANDIDATES = [".mr-agent.yml", ".mr-agent.yaml"];

const ISSUE_TEMPLATE_PATH_CANDIDATES = [
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/ISSUE_TEMPLATE.md",
];

const PULL_REQUEST_TEMPLATE_PATH_CANDIDATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

const DEFAULT_ISSUE_TEMPLATE_MARKDOWN = [
  "## Summary",
  "",
  "<!-- Describe the issue and impact -->",
  "",
  "## Steps to Reproduce",
  "",
  "<!-- 1) ... 2) ... 3) ... -->",
  "",
  "## Expected Behavior",
  "",
  "<!-- What should happen -->",
].join("\n");

const DEFAULT_PULL_REQUEST_TEMPLATE_MARKDOWN = [
  "## Summary",
  "",
  "<!-- What changed and why -->",
  "",
  "## Test Plan",
  "",
  "<!-- How you verified this change -->",
  "",
  "## Related Issue",
  "",
  "<!-- e.g. Closes #123 -->",
].join("\n");

const DEFAULT_ISSUE_TEMPLATE_SECTIONS = extractTemplateSectionHeadings(
  DEFAULT_ISSUE_TEMPLATE_MARKDOWN,
);
const DEFAULT_PULL_REQUEST_TEMPLATE_SECTIONS = extractTemplateSectionHeadings(
  DEFAULT_PULL_REQUEST_TEMPLATE_MARKDOWN,
);

const policyConfigCache = new Map<string, RepoPolicyConfigCacheEntry>();

const repoPolicyIssueSchema = z
  .object({
    enabled: z.boolean().optional(),
    minBodyLength: z.number().int().optional(),
    requiredSections: z.array(z.string()).optional(),
  })
  .strict()
  .partial();

const repoPolicyPullRequestSchema = repoPolicyIssueSchema
  .extend({
    requireLinkedIssue: z.boolean().optional(),
  })
  .strict()
  .partial();

const repoPolicyReviewSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["comment", "report"]).optional(),
    onOpened: z.boolean().optional(),
    onEdited: z.boolean().optional(),
    onSynchronize: z.boolean().optional(),
    describeEnabled: z.boolean().optional(),
    describeAllowApply: z.boolean().optional(),
    checksCommandEnabled: z.boolean().optional(),
    includeCiChecks: z.boolean().optional(),
    secretScanEnabled: z.boolean().optional(),
    secretScanCustomPatterns: z.array(z.string()).optional(),
    autoLabelEnabled: z.boolean().optional(),
    askCommandEnabled: z.boolean().optional(),
    generateTestsCommandEnabled: z.boolean().optional(),
    changelogCommandEnabled: z.boolean().optional(),
    changelogAllowApply: z.boolean().optional(),
    feedbackCommandEnabled: z.boolean().optional(),
    customRules: z.array(z.string()).optional(),
  })
  .strict()
  .partial();

const repoPolicyConfigSchema = z
  .object({
    mode: z.enum(["remind", "enforce"]).optional(),
    issue: repoPolicyIssueSchema.optional(),
    pullRequest: repoPolicyPullRequestSchema.optional(),
    review: repoPolicyReviewSchema.optional(),
  })
  .strict()
  .partial();

const defaultPolicyConfig: RepoPolicyConfig = {
  mode: "remind",
  issue: {
    enabled: true,
    minBodyLength: 20,
    requiredSections: [],
  },
  pullRequest: {
    enabled: true,
    minBodyLength: 20,
    requiredSections: [],
    requireLinkedIssue: false,
  },
  review: {
    enabled: true,
    mode: "comment",
    onOpened: true,
    onEdited: false,
    onSynchronize: true,
    describeEnabled: true,
    describeAllowApply: false,
    checksCommandEnabled: true,
    includeCiChecks: true,
    secretScanEnabled: true,
    secretScanCustomPatterns: [],
    autoLabelEnabled: true,
    askCommandEnabled: true,
    generateTestsCommandEnabled: true,
    changelogCommandEnabled: true,
    changelogAllowApply: false,
    feedbackCommandEnabled: true,
    customRules: [],
  },
};

export async function runGitHubIssuePolicyCheck(params: {
  context: GitHubReviewContext;
  issueNumber: number;
  title?: string;
  body?: string;
  ref?: string;
}): Promise<void> {
  const { context, issueNumber } = params;
  const { owner, repo } = context.repo();
  const ref = params.ref;
  const locale = resolveUiLocale();

  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref,
  });
  if (!config.issue.enabled) {
    return;
  }

  const requiredSections =
    config.issue.requiredSections.length > 0
      ? config.issue.requiredSections
      : await loadIssueTemplateSections({ context, owner, repo, ref });
  const result = validateIssueBody({
    title: params.title ?? "",
    body: params.body ?? "",
    minBodyLength: config.issue.minBodyLength,
    requiredSections,
    locale,
  });
  if (result.missing.length === 0) {
    return;
  }

  await publishPolicyReminderComment({
    context,
    owner,
    repo,
    issueNumber,
    kind: "issue",
    missing: result.missing,
    mode: config.mode,
    locale,
  });
}

export async function runGitHubPullRequestPolicyCheck(params: {
  context: GitHubReviewContext;
  pullNumber: number;
  title?: string;
  body?: string;
  headSha?: string;
  baseRef?: string;
  detailsUrl?: string;
}): Promise<void> {
  const { context, pullNumber } = params;
  const { owner, repo } = context.repo();
  const ref = params.baseRef;
  const locale = resolveUiLocale();

  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref,
  });
  if (!config.pullRequest.enabled) {
    return;
  }

  const requiredSections =
    config.pullRequest.requiredSections.length > 0
      ? config.pullRequest.requiredSections
      : await loadPullRequestTemplateSections({ context, owner, repo, ref });
  const result = validatePullRequestBody({
    title: params.title ?? "",
    body: params.body ?? "",
    minBodyLength: config.pullRequest.minBodyLength,
    requiredSections,
    requireLinkedIssue: config.pullRequest.requireLinkedIssue,
    locale,
  });

  if (result.missing.length > 0) {
    await publishPolicyReminderComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      kind: "pull_request",
      missing: result.missing,
      mode: config.mode,
      locale,
    });
  }

  if (config.mode === "enforce" && params.headSha) {
    await publishPolicyCheckRun({
      context,
      owner,
      repo,
      headSha: params.headSha,
      detailsUrl: params.detailsUrl,
      missing: result.missing,
      locale,
    });
  }
}

export async function resolveGitHubPullRequestAutoReviewPolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
  action: "opened" | "edited" | "synchronize";
}): Promise<{
  enabled: boolean;
  mode: ReviewMode;
  customRules: string[];
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
}> {
  const { context } = params;
  const { owner, repo } = context.repo();
  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref: params.baseRef,
  });

  const review = config.review;
  if (!review.enabled) {
    return {
      enabled: false,
      mode: review.mode,
      customRules: review.customRules,
      includeCiChecks: review.includeCiChecks,
      secretScanEnabled: review.secretScanEnabled,
      secretScanCustomPatterns: review.secretScanCustomPatterns,
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  if (params.action === "opened") {
    return {
      enabled: review.onOpened,
      mode: review.mode,
      customRules: review.customRules,
      includeCiChecks: review.includeCiChecks,
      secretScanEnabled: review.secretScanEnabled,
      secretScanCustomPatterns: review.secretScanCustomPatterns,
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  if (params.action === "edited") {
    return {
      enabled: review.onEdited,
      mode: review.mode,
      customRules: review.customRules,
      includeCiChecks: review.includeCiChecks,
      secretScanEnabled: review.secretScanEnabled,
      secretScanCustomPatterns: review.secretScanCustomPatterns,
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  return {
    enabled: review.onSynchronize,
    mode: review.mode,
    customRules: review.customRules,
    includeCiChecks: review.includeCiChecks,
    secretScanEnabled: review.secretScanEnabled,
    secretScanCustomPatterns: review.secretScanCustomPatterns,
    autoLabelEnabled: review.autoLabelEnabled,
  };
}

export async function resolveGitHubDescribePolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
}): Promise<{ enabled: boolean; allowApply: boolean }> {
  const { context } = params;
  const { owner, repo } = context.repo();
  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref: params.baseRef,
  });

  return {
    enabled: config.review.describeEnabled,
    allowApply: config.review.describeAllowApply,
  };
}

export async function resolveGitHubReviewBehaviorPolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
}): Promise<{
  describeEnabled: boolean;
  describeAllowApply: boolean;
  customRules: string[];
  includeCiChecks: boolean;
  checksCommandEnabled: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  askCommandEnabled: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  feedbackCommandEnabled: boolean;
}> {
  const { context } = params;
  const { owner, repo } = context.repo();
  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref: params.baseRef,
  });

  return {
    describeEnabled: config.review.describeEnabled,
    describeAllowApply: config.review.describeAllowApply,
    customRules: config.review.customRules,
    includeCiChecks: config.review.includeCiChecks,
    checksCommandEnabled: config.review.checksCommandEnabled,
    secretScanEnabled: config.review.secretScanEnabled,
    secretScanCustomPatterns: config.review.secretScanCustomPatterns,
    autoLabelEnabled: config.review.autoLabelEnabled,
    askCommandEnabled: config.review.askCommandEnabled,
    generateTestsCommandEnabled: config.review.generateTestsCommandEnabled,
    changelogCommandEnabled: config.review.changelogCommandEnabled,
    changelogAllowApply: config.review.changelogAllowApply,
    feedbackCommandEnabled: config.review.feedbackCommandEnabled,
  };
}

async function loadRepositoryPolicyConfig(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<RepoPolicyConfig> {
  const { context, owner, repo, ref } = params;
  const cacheKey = `${owner}/${repo}@${ref ?? "__default__"}`;
  const now = Date.now();
  pruneExpiredCache(policyConfigCache, now);
  const cached = getFreshCacheValue(policyConfigCache, cacheKey, now);
  if (cached) {
    return cached;
  }

  let configFromRepo: RepoPolicyConfig | undefined;
  for (const path of CONFIG_PATH_CANDIDATES) {
    const raw = await tryLoadRepositoryTextFile({
      context,
      owner,
      repo,
      path,
      ref,
    });
    if (!raw) {
      continue;
    }

    try {
      const parsed = parseRepoPolicyConfig(raw);
      configFromRepo = normalizeRepoPolicyConfig(parsed);
      break;
    } catch (error) {
      context.log.error(
        {
          owner,
          repo,
          path,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to parse .mr-agent.yml, using defaults",
      );
      break;
    }
  }

  const resolved = configFromRepo ?? defaultPolicyConfig;
  policyConfigCache.set(cacheKey, {
    expiresAt:
      now +
      readNumberEnv(
        "GITHUB_POLICY_CONFIG_CACHE_TTL_MS",
        DEFAULT_POLICY_CONFIG_CACHE_TTL_MS,
      ),
    value: resolved,
  });
  trimCache(policyConfigCache, 500);

  return resolved;
}

async function loadIssueTemplateSections(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<string[]> {
  const explicit = await loadFirstMatchedTemplate(
    params,
    ISSUE_TEMPLATE_PATH_CANDIDATES,
  );
  if (explicit) {
    return extractTemplateSectionHeadings(explicit);
  }

  const fromDirectory = await loadFirstMarkdownTemplateFromDirectory({
    ...params,
    directoryPath: ".github/ISSUE_TEMPLATE",
  });
  return fromDirectory
    ? extractTemplateSectionHeadings(fromDirectory)
    : DEFAULT_ISSUE_TEMPLATE_SECTIONS;
}

async function loadPullRequestTemplateSections(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<string[]> {
  const explicit = await loadFirstMatchedTemplate(
    params,
    PULL_REQUEST_TEMPLATE_PATH_CANDIDATES,
  );
  if (explicit) {
    return extractTemplateSectionHeadings(explicit);
  }

  const fromDirectory = await loadFirstMarkdownTemplateFromDirectory({
    ...params,
    directoryPath: ".github/PULL_REQUEST_TEMPLATE",
  });
  return fromDirectory
    ? extractTemplateSectionHeadings(fromDirectory)
    : DEFAULT_PULL_REQUEST_TEMPLATE_SECTIONS;
}

async function loadFirstMatchedTemplate(
  params: {
    context: GitHubReviewContext;
    owner: string;
    repo: string;
    ref?: string;
  },
  pathCandidates: string[],
): Promise<string | undefined> {
  for (const path of pathCandidates) {
    const content = await tryLoadRepositoryTextFile({
      ...params,
      path,
    });
    if (content) {
      return content;
    }
  }

  return undefined;
}

async function loadFirstMarkdownTemplateFromDirectory(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
  directoryPath: string;
}): Promise<string | undefined> {
  const response = await tryLoadRepositoryContent({
    context: params.context,
    owner: params.owner,
    repo: params.repo,
    path: params.directoryPath,
    ref: params.ref,
  });
  if (!response || !Array.isArray(response)) {
    return undefined;
  }

  const markdownCandidate = response.find((item) => {
    const path = (item.path ?? "").toLowerCase();
    return path.endsWith(".md");
  });
  if (!markdownCandidate?.path) {
    return undefined;
  }

  return tryLoadRepositoryTextFile({
    context: params.context,
    owner: params.owner,
    repo: params.repo,
    path: markdownCandidate.path,
    ref: params.ref,
  });
}

function validateIssueBody(params: {
  title: string;
  body: string;
  minBodyLength: number;
  requiredSections: string[];
  locale: UiLocale;
}): { missing: string[] } {
  const missing: string[] = [];
  if (!params.title.trim()) {
    missing.push(
      localizeText(
        { zh: "Issue 标题不能为空", en: "Issue title is required" },
        params.locale,
      ),
    );
  }

  const body = params.body.trim();
  if (!body) {
    missing.push(
      localizeText(
        { zh: "Issue 描述不能为空", en: "Issue body is required" },
        params.locale,
      ),
    );
    return { missing };
  }

  if (body.length < Math.max(1, params.minBodyLength)) {
    missing.push(
      localizeText(
        {
          zh: `Issue 描述至少 ${Math.max(1, params.minBodyLength)} 个字符`,
          en: `Issue body must be at least ${Math.max(1, params.minBodyLength)} characters`,
        },
        params.locale,
      ),
    );
  }

  missing.push(
    ...findMissingSections(body, params.requiredSections).map(
      (section) =>
        localizeText(
          {
            zh: `缺少或未填写模板段落: ${section}`,
            en: `Missing or empty template section: ${section}`,
          },
          params.locale,
        ),
    ),
  );

  return { missing };
}

function validatePullRequestBody(params: {
  title: string;
  body: string;
  minBodyLength: number;
  requiredSections: string[];
  requireLinkedIssue: boolean;
  locale: UiLocale;
}): { missing: string[] } {
  const missing: string[] = [];
  if (!params.title.trim()) {
    missing.push(
      localizeText(
        { zh: "PR 标题不能为空", en: "PR title is required" },
        params.locale,
      ),
    );
  }

  const body = params.body.trim();
  if (!body) {
    missing.push(
      localizeText(
        { zh: "PR 描述不能为空", en: "PR body is required" },
        params.locale,
      ),
    );
  } else {
    if (body.length < Math.max(1, params.minBodyLength)) {
      missing.push(
        localizeText(
          {
            zh: `PR 描述至少 ${Math.max(1, params.minBodyLength)} 个字符`,
            en: `PR body must be at least ${Math.max(1, params.minBodyLength)} characters`,
          },
          params.locale,
        ),
      );
    }
    if (params.requireLinkedIssue && !containsIssueReference(body)) {
      missing.push(
        localizeText(
          {
            zh: "PR 描述中需要关联 Issue（例如 #123）",
            en: "PR body must reference an issue (for example: #123)",
          },
          params.locale,
        ),
      );
    }
    missing.push(
      ...findMissingSections(body, params.requiredSections).map(
        (section) =>
          localizeText(
            {
              zh: `缺少或未填写模板段落: ${section}`,
              en: `Missing or empty template section: ${section}`,
            },
            params.locale,
          ),
      ),
    );
  }

  return { missing };
}

async function publishPolicyReminderComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  kind: "issue" | "pull_request";
  missing: string[];
  mode: PolicyMode;
  locale: UiLocale;
}): Promise<void> {
  const dedupeKey = [
    "github-policy-reminder",
    `${params.owner}/${params.repo}`,
    `${params.kind}#${params.issueNumber}`,
    params.mode,
    params.missing.join("|"),
  ].join(":");
  const dedupeTtl = readNumberEnv(
    "GITHUB_POLICY_COMMENT_DEDUPE_TTL_MS",
    DEFAULT_POLICY_COMMENT_DEDUPE_TTL_MS,
  );
  if (isDuplicateRequest(dedupeKey, dedupeTtl)) {
    return;
  }

  const title =
    params.kind === "issue"
      ? localizeText(
          { zh: "Issue 模板预检未通过", en: "Issue template pre-check failed" },
          params.locale,
        )
      : localizeText(
          { zh: "PR 流程预检未通过", en: "PR flow pre-check failed" },
          params.locale,
        );
  const modeHint =
    params.mode === "enforce"
      ? localizeText(
          {
            zh: "当前仓库模式：`enforce`（会写入失败检查）",
            en: "Repository mode: `enforce` (failed check run will be posted)",
          },
          params.locale,
        )
      : localizeText(
          {
            zh: "当前仓库模式：`remind`（仅提醒，不阻塞）",
            en: "Repository mode: `remind` (reminder only, non-blocking)",
          },
          params.locale,
        );
  const body = [
    localizeText(
      { zh: "## MR Agent 流程守卫", en: "## MR Agent Flow Guard" },
      params.locale,
    ),
    "",
    `**${title}**`,
    modeHint,
    "",
    localizeText(
      { zh: "请补充以下项：", en: "Please complete the following items:" },
      params.locale,
    ),
    ...params.missing.map((item) => `- [ ] ${item}`),
    "",
    localizeText(
      {
        zh: "可在仓库根目录 `.mr-agent.yml` 调整规则（`remind` / `enforce`）。",
        en: "You can tune these rules in `.mr-agent.yml` (`remind` / `enforce`).",
      },
      params.locale,
    ),
  ].join("\n");

  try {
    await params.context.octokit.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      body,
    });
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
        kind: params.kind,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to publish policy reminder comment",
    );
  }
}

async function publishPolicyCheckRun(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  headSha: string;
  detailsUrl?: string;
  missing: string[];
  locale: UiLocale;
}): Promise<void> {
  if (!params.context.octokit.checks?.create) {
    params.context.log.error(
      { owner: params.owner, repo: params.repo },
      "Policy mode is enforce but checks API is unavailable",
    );
    return;
  }

  const passed = params.missing.length === 0;
  const checkName = process.env.GITHUB_POLICY_CHECK_NAME?.trim() || DEFAULT_POLICY_CHECK_NAME;
  const output: NonNullable<GitHubCheckRunCreateParams["output"]> = {
    title: passed
      ? localizeText(
          { zh: "GitHub 流程预检通过", en: "GitHub Flow pre-check passed" },
          params.locale,
        )
      : localizeText(
          { zh: "GitHub 流程预检失败", en: "GitHub Flow pre-check failed" },
          params.locale,
        ),
    summary: passed
      ? localizeText(
          { zh: "所有必填流程项已满足。", en: "All required flow items are satisfied." },
          params.locale,
        )
      : [
          localizeText(
            { zh: "以下项未通过：", en: "The following items failed:" },
            params.locale,
          ),
          ...params.missing.map((item) => `- ${item}`),
        ].join("\n"),
  };
  if (params.detailsUrl) {
    output.text = localizeText(
      { zh: `详情: ${params.detailsUrl}`, en: `Details: ${params.detailsUrl}` },
      params.locale,
    );
  }

  const request: GitHubCheckRunCreateParams = {
    owner: params.owner,
    repo: params.repo,
    name: checkName,
    head_sha: params.headSha,
    details_url: params.detailsUrl,
    status: "completed",
    conclusion: passed ? "success" : "failure",
    completed_at: new Date().toISOString(),
    output,
  };

  try {
    await params.context.octokit.checks.create(request);
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        headSha: params.headSha,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to publish policy check run",
    );
  }
}

function containsIssueReference(body: string): boolean {
  return (
    /(^|\s)#\d+\b/.test(body) ||
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/i.test(body)
  );
}

function findMissingSections(body: string, requiredSections: string[]): string[] {
  if (requiredSections.length === 0) {
    return [];
  }

  const sections = parseMarkdownSections(body);
  const normalizedSectionMap = sections.map((section) => ({
    ...section,
    normalizedHeading: normalizeToken(section.heading),
  }));

  const missing: string[] = [];
  for (const sectionName of requiredSections) {
    const normalizedTarget = normalizeToken(sectionName);
    if (!normalizedTarget) {
      continue;
    }

    const matched = normalizedSectionMap.find((section) => {
      if (!section.normalizedHeading) {
        return false;
      }

      return (
        section.normalizedHeading === normalizedTarget ||
        section.normalizedHeading.includes(normalizedTarget) ||
        normalizedTarget.includes(section.normalizedHeading)
      );
    });
    if (!matched || !hasMeaningfulContent(matched.content)) {
      missing.push(sectionName);
    }
  }

  return missing;
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];

  let currentHeading = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const heading = parseMarkdownHeading(line);
    if (!heading) {
      if (currentHeading) {
        currentContent.push(line);
      }
      continue;
    }

    if (currentHeading) {
      sections.push({
        heading: currentHeading,
        content: currentContent.join("\n"),
      });
    }
    currentHeading = heading;
    currentContent = [];
  }

  if (currentHeading) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join("\n"),
    });
  }

  return sections;
}

function parseMarkdownHeading(line: string): string | undefined {
  const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
  return match?.[1]?.trim();
}

function hasMeaningfulContent(content: string): boolean {
  const normalized = content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[-*]\s+\[[ xX]\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized !== "_no response_" && normalized !== "no response";
}

function extractTemplateSectionHeadings(template: string): string[] {
  const headings = template
    .split("\n")
    .map((line) => parseMarkdownHeading(line))
    .filter((heading): heading is string => Boolean(heading))
    .map((heading) => heading.trim())
    .filter((heading) => heading.length > 0)
    .slice(0, 12);

  return [...new Set(headings)];
}

async function tryLoadRepositoryTextFile(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<string | undefined> {
  const response = await tryLoadRepositoryContent(params);
  if (!response || Array.isArray(response)) {
    return undefined;
  }

  if (response.type !== "file" || !response.content) {
    return undefined;
  }

  const text = decodeGitHubFileContent(response.content, response.encoding).trim();
  return text || undefined;
}

async function tryLoadRepositoryContent(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<GitHubRepositoryContentFile | GitHubRepositoryContentFile[] | undefined> {
  try {
    const response = await params.context.octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      ref: params.ref,
    });
    return response.data;
  } catch {
    return undefined;
  }
}

function normalizeRepoPolicyConfig(raw: Partial<RepoPolicyConfig>): RepoPolicyConfig {
  const mode = raw.mode === "enforce" ? "enforce" : "remind";
  const issue = raw.issue ?? defaultPolicyConfig.issue;
  const pullRequest = raw.pullRequest ?? defaultPolicyConfig.pullRequest;
  const review = raw.review ?? defaultPolicyConfig.review;

  return {
    mode,
    issue: {
      enabled: issue.enabled !== false,
      minBodyLength: Math.max(1, issue.minBodyLength ?? defaultPolicyConfig.issue.minBodyLength),
      requiredSections: normalizeStringList(issue.requiredSections),
    },
    pullRequest: {
      enabled: pullRequest.enabled !== false,
      minBodyLength: Math.max(
        1,
        pullRequest.minBodyLength ?? defaultPolicyConfig.pullRequest.minBodyLength,
      ),
      requiredSections: normalizeStringList(pullRequest.requiredSections),
      requireLinkedIssue: Boolean(pullRequest.requireLinkedIssue),
    },
    review: {
      enabled: review.enabled !== false,
      mode: review.mode === "report" ? "report" : "comment",
      onOpened: review.onOpened !== false,
      onEdited: Boolean(review.onEdited),
      onSynchronize: review.onSynchronize !== false,
      describeEnabled: review.describeEnabled !== false,
      describeAllowApply: Boolean(review.describeAllowApply),
      checksCommandEnabled: review.checksCommandEnabled !== false,
      includeCiChecks: review.includeCiChecks !== false,
      secretScanEnabled: review.secretScanEnabled !== false,
      secretScanCustomPatterns: normalizeStringList(review.secretScanCustomPatterns).slice(0, 20),
      autoLabelEnabled: review.autoLabelEnabled !== false,
      askCommandEnabled: review.askCommandEnabled !== false,
      generateTestsCommandEnabled: review.generateTestsCommandEnabled !== false,
      changelogCommandEnabled: review.changelogCommandEnabled !== false,
      changelogAllowApply: Boolean(review.changelogAllowApply),
      feedbackCommandEnabled: review.feedbackCommandEnabled !== false,
      customRules: normalizeStringList(review.customRules).slice(0, 30),
    },
  };
}

export function parseRepoPolicyConfig(raw: string): Partial<RepoPolicyConfig> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    const parsedJson = JSON.parse(trimmed) as unknown;
    const validated = repoPolicyConfigSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new Error(
        `Invalid JSON policy config: ${validated.error.issues[0]?.message ?? "schema validation failed"}`,
      );
    }
    return validated.data as Partial<RepoPolicyConfig>;
  }

  return parseSimpleYamlPolicyConfig(trimmed);
}

function parseSimpleYamlPolicyConfig(yamlText: string): Partial<RepoPolicyConfig> {
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText, { json: true });
  } catch (error) {
    throw new Error(
      `Invalid YAML policy config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("Invalid YAML policy config: root must be a mapping object");
  }

  const normalized = normalizeYamlPolicyRoot(root);
  const validated = repoPolicyConfigSchema.safeParse(normalized);
  if (!validated.success) {
    throw new Error(
      `Invalid YAML policy config: ${validated.error.issues[0]?.message ?? "schema validation failed"}`,
    );
  }
  return validated.data as Partial<RepoPolicyConfig>;
}

function normalizeYamlPolicyRoot(
  root: Record<string, unknown>,
): Partial<RepoPolicyConfig> {
  const result: Partial<RepoPolicyConfig> = {};

  const mode = parsePolicyModeFromUnknown(root.mode);
  if (mode) {
    result.mode = mode;
  }

  const issue = asRecord(root.issue);
  if (issue) {
    const normalizedIssue = normalizeYamlSectionConfig(issue);
    if (Object.keys(normalizedIssue).length > 0) {
      result.issue = normalizedIssue as PolicySectionConfig;
    }
  }

  const pullRequest = asRecord(root.pullRequest) ?? asRecord(root.pull_request);
  if (pullRequest) {
    const normalizedPullRequest = normalizeYamlPullRequestSection(pullRequest);
    if (Object.keys(normalizedPullRequest).length > 0) {
      result.pullRequest = normalizedPullRequest as PullRequestPolicySectionConfig;
    }
  }

  const review = asRecord(root.review);
  if (review) {
    const normalizedReview = normalizeYamlReviewConfig(review);
    if (Object.keys(normalizedReview).length > 0) {
      result.review = normalizedReview as ReviewPolicyConfig;
    }
  }

  return result;
}

function normalizeYamlSectionConfig(
  raw: Record<string, unknown>,
): Partial<PolicySectionConfig> {
  const target: Partial<PolicySectionConfig> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeYamlConfigKey(rawKey);
    if (key === "enabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.enabled = bool;
      }
      continue;
    }
    if (key === "minbodylength") {
      const number = coerceNumber(rawValue);
      if (number !== undefined) {
        target.minBodyLength = number;
      }
      continue;
    }
    if (key === "requiredsections") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.requiredSections = list;
      }
    }
  }
  return target;
}

function normalizeYamlPullRequestSection(
  raw: Record<string, unknown>,
): Partial<PullRequestPolicySectionConfig> {
  const target = normalizeYamlSectionConfig(raw) as Partial<PullRequestPolicySectionConfig>;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeYamlConfigKey(rawKey);
    if (key === "requirelinkedissue") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.requireLinkedIssue = bool;
      }
    }
  }
  return target;
}

function normalizeYamlReviewConfig(
  raw: Record<string, unknown>,
): Partial<ReviewPolicyConfig> {
  const target: Partial<ReviewPolicyConfig> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeYamlConfigKey(rawKey);
    if (key === "enabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.enabled = bool;
      }
      continue;
    }
    if (key === "mode") {
      const mode = parseReviewModeFromUnknown(rawValue);
      if (mode) {
        target.mode = mode;
      }
      continue;
    }
    if (key === "onopened") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.onOpened = bool;
      }
      continue;
    }
    if (key === "onedited") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.onEdited = bool;
      }
      continue;
    }
    if (key === "onsynchronize") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.onSynchronize = bool;
      }
      continue;
    }
    if (key === "describeenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.describeEnabled = bool;
      }
      continue;
    }
    if (key === "describeallowapply") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.describeAllowApply = bool;
      }
      continue;
    }
    if (key === "checkscommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.checksCommandEnabled = bool;
      }
      continue;
    }
    if (key === "includecichecks") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.includeCiChecks = bool;
      }
      continue;
    }
    if (key === "secretscanenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.secretScanEnabled = bool;
      }
      continue;
    }
    if (key === "secretscancustompatterns") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.secretScanCustomPatterns = list;
      }
      continue;
    }
    if (key === "autolabelenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.autoLabelEnabled = bool;
      }
      continue;
    }
    if (key === "askcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.askCommandEnabled = bool;
      }
      continue;
    }
    if (key === "generatetestscommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.generateTestsCommandEnabled = bool;
      }
      continue;
    }
    if (key === "changelogcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.changelogCommandEnabled = bool;
      }
      continue;
    }
    if (key === "changelogallowapply") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.changelogAllowApply = bool;
      }
      continue;
    }
    if (key === "feedbackcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.feedbackCommandEnabled = bool;
      }
      continue;
    }
    if (key === "customrules") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.customRules = list;
      }
    }
  }

  return target;
}

function normalizeYamlConfigKey(rawKey: string): string {
  return rawKey.trim().toLowerCase().replace(/[_-]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }
  if (typeof value === "string") {
    return parseYamlBooleanMaybe(value);
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(stripYamlQuotes(value));
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function coerceStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof value === "string") {
    const trimmed = stripYamlQuotes(value).trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const parsed = trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => stripYamlQuotes(item).trim())
        .filter(Boolean);
      return parsed.length > 0 ? parsed : undefined;
    }
    return [trimmed];
  }
  return undefined;
}

function parsePolicyModeFromUnknown(value: unknown): PolicyMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parsePolicyMode(value);
}

function parseReviewModeFromUnknown(value: unknown): ReviewMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parseReviewMode(value);
}

function parseYamlBooleanMaybe(value: string): boolean | undefined {
  const normalized = stripYamlQuotes(value).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseYamlBoolean(value: string): boolean {
  return parseYamlBooleanMaybe(value) ?? false;
}

function parsePolicyMode(value: string): PolicyMode {
  return stripYamlQuotes(value).toLowerCase() === "enforce" ? "enforce" : "remind";
}

function parseReviewMode(value: string): ReviewMode {
  return stripYamlQuotes(value).toLowerCase() === "report" ? "report" : "comment";
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[`*_~>#:[\]()/\\\-.,，。!?！？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
