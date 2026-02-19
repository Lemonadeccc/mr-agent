import {
  isDuplicateRequest,
  pruneExpiredCache,
  readNumberEnv,
  trimCache,
  type ExpiringCacheEntry,
} from "#core";
import type { ReviewMode } from "#review";
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
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  return {
    enabled: review.onSynchronize,
    mode: review.mode,
    customRules: review.customRules,
    includeCiChecks: review.includeCiChecks,
    secretScanEnabled: review.secretScanEnabled,
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
  customRules: string[];
  includeCiChecks: boolean;
  checksCommandEnabled: boolean;
  secretScanEnabled: boolean;
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
    customRules: config.review.customRules,
    includeCiChecks: config.review.includeCiChecks,
    checksCommandEnabled: config.review.checksCommandEnabled,
    secretScanEnabled: config.review.secretScanEnabled,
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
  const cached = policyConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
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
}): { missing: string[] } {
  const missing: string[] = [];
  if (!params.title.trim()) {
    missing.push("Issue 标题不能为空");
  }

  const body = params.body.trim();
  if (!body) {
    missing.push("Issue 描述不能为空");
    return { missing };
  }

  if (body.length < Math.max(1, params.minBodyLength)) {
    missing.push(`Issue 描述至少 ${Math.max(1, params.minBodyLength)} 个字符`);
  }

  missing.push(
    ...findMissingSections(body, params.requiredSections).map(
      (section) => `缺少或未填写模板段落: ${section}`,
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
}): { missing: string[] } {
  const missing: string[] = [];
  if (!params.title.trim()) {
    missing.push("PR 标题不能为空");
  }

  const body = params.body.trim();
  if (!body) {
    missing.push("PR 描述不能为空");
  } else {
    if (body.length < Math.max(1, params.minBodyLength)) {
      missing.push(`PR 描述至少 ${Math.max(1, params.minBodyLength)} 个字符`);
    }
    if (params.requireLinkedIssue && !containsIssueReference(body)) {
      missing.push("PR 描述中需要关联 Issue（例如 #123）");
    }
    missing.push(
      ...findMissingSections(body, params.requiredSections).map(
        (section) => `缺少或未填写模板段落: ${section}`,
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
    params.kind === "issue" ? "Issue 模板预检未通过" : "PR 流程预检未通过";
  const modeHint =
    params.mode === "enforce"
      ? "当前仓库模式：`enforce`（会写入失败检查）"
      : "当前仓库模式：`remind`（仅提醒，不阻塞）";
  const body = [
    "## MR Agent 流程守卫",
    "",
    `**${title}**`,
    modeHint,
    "",
    "请补充以下项：",
    ...params.missing.map((item) => `- [ ] ${item}`),
    "",
    "可在仓库根目录 `.mr-agent.yml` 调整规则（`remind` / `enforce`）。",
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
    title: passed ? "GitHub Flow pre-check passed" : "GitHub Flow pre-check failed",
    summary: passed
      ? "所有必填流程项已满足。"
      : ["以下项未通过：", ...params.missing.map((item) => `- ${item}`)].join("\n"),
  };
  if (params.detailsUrl) {
    output.text = `详情: ${params.detailsUrl}`;
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

function decodeGitHubFileContent(content: string, encoding: string | undefined): string {
  if ((encoding ?? "").toLowerCase() === "base64") {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  return content;
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

function parseRepoPolicyConfig(raw: string): Partial<RepoPolicyConfig> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Partial<RepoPolicyConfig>;
  }

  return parseSimpleYamlPolicyConfig(trimmed);
}

function parseSimpleYamlPolicyConfig(yamlText: string): Partial<RepoPolicyConfig> {
  const result: Partial<RepoPolicyConfig> = {};
  const issue: Partial<PolicySectionConfig> = {};
  const pullRequest: Partial<PullRequestPolicySectionConfig> = {};
  const review: Partial<ReviewPolicyConfig> = {};
  let currentSection: "root" | "issue" | "pullRequest" | "review" = "root";
  let listTarget:
    | "issueRequiredSections"
    | "pullRequestRequiredSections"
    | "reviewCustomRules"
    | undefined;

  for (const rawLine of yamlText.split("\n")) {
    const line = stripYamlComment(rawLine);
    if (!line.trim()) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const text = line.trim();

    if (text.startsWith("- ")) {
      const item = text.slice(2).trim();
      if (!item || !listTarget) {
        continue;
      }

      if (listTarget === "issueRequiredSections") {
        issue.requiredSections = [...(issue.requiredSections ?? []), stripYamlQuotes(item)];
      } else if (listTarget === "reviewCustomRules") {
        review.customRules = [...(review.customRules ?? []), stripYamlQuotes(item)];
      } else {
        pullRequest.requiredSections = [
          ...(pullRequest.requiredSections ?? []),
          stripYamlQuotes(item),
        ];
      }
      continue;
    }

    const separatorIndex = text.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const key = text.slice(0, separatorIndex).trim();
    const valueRaw = text.slice(separatorIndex + 1).trim();
    if (indent === 0) {
      listTarget = undefined;
      if (key === "issue" && valueRaw === "") {
        currentSection = "issue";
        continue;
      }
      if (
        (key === "pullRequest" || key === "pull_request") &&
        valueRaw === ""
      ) {
        currentSection = "pullRequest";
        continue;
      }
      if (key === "review" && valueRaw === "") {
        currentSection = "review";
        continue;
      }
      currentSection = "root";

      if (key === "mode") {
        result.mode = parsePolicyMode(valueRaw);
      }
      continue;
    }

    if (currentSection === "issue") {
      if (key === "requiredSections" && valueRaw === "") {
        listTarget = "issueRequiredSections";
        issue.requiredSections = issue.requiredSections ?? [];
        continue;
      }
      listTarget = undefined;
      applySectionConfigKey(issue, key, valueRaw);
      continue;
    }

    if (currentSection === "pullRequest") {
      if (key === "requiredSections" && valueRaw === "") {
        listTarget = "pullRequestRequiredSections";
        pullRequest.requiredSections = pullRequest.requiredSections ?? [];
        continue;
      }
      listTarget = undefined;
      if (key === "requireLinkedIssue") {
        pullRequest.requireLinkedIssue = parseYamlBoolean(valueRaw);
        continue;
      }
      applySectionConfigKey(pullRequest, key, valueRaw);
      continue;
    }

    if (currentSection === "review") {
      listTarget = undefined;
      if (key === "customRules" && valueRaw === "") {
        listTarget = "reviewCustomRules";
        review.customRules = review.customRules ?? [];
        continue;
      }
      applyReviewConfigKey(review, key, valueRaw);
    }
  }

  if (Object.keys(issue).length > 0) {
    result.issue = issue as PolicySectionConfig;
  }
  if (Object.keys(pullRequest).length > 0) {
    result.pullRequest = pullRequest as PullRequestPolicySectionConfig;
  }
  if (Object.keys(review).length > 0) {
    result.review = review as ReviewPolicyConfig;
  }

  return result;
}

function applyReviewConfigKey(
  target: Partial<ReviewPolicyConfig>,
  key: string,
  valueRaw: string,
): void {
  if (key === "enabled") {
    target.enabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "mode") {
    target.mode = parseReviewMode(valueRaw);
    return;
  }

  if (key === "onOpened" || key === "on_opened") {
    target.onOpened = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "onEdited" || key === "on_edited") {
    target.onEdited = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "onSynchronize" || key === "on_synchronize") {
    target.onSynchronize = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "describeEnabled" || key === "describe_enabled") {
    target.describeEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "describeAllowApply" || key === "describe_allow_apply") {
    target.describeAllowApply = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "checksCommandEnabled" || key === "checks_command_enabled") {
    target.checksCommandEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "includeCiChecks" || key === "include_ci_checks") {
    target.includeCiChecks = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "secretScanEnabled" || key === "secret_scan_enabled") {
    target.secretScanEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "autoLabelEnabled" || key === "auto_label_enabled") {
    target.autoLabelEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "askCommandEnabled" || key === "ask_command_enabled") {
    target.askCommandEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (
    key === "generateTestsCommandEnabled" ||
    key === "generate_tests_command_enabled"
  ) {
    target.generateTestsCommandEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "changelogCommandEnabled" || key === "changelog_command_enabled") {
    target.changelogCommandEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "changelogAllowApply" || key === "changelog_allow_apply") {
    target.changelogAllowApply = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "feedbackCommandEnabled" || key === "feedback_command_enabled") {
    target.feedbackCommandEnabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "customRules" && valueRaw.startsWith("[")) {
    target.customRules = valueRaw
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((item) => stripYamlQuotes(item.trim()))
      .filter(Boolean);
  }
}

function applySectionConfigKey(
  target: Partial<PolicySectionConfig>,
  key: string,
  valueRaw: string,
): void {
  if (key === "enabled") {
    target.enabled = parseYamlBoolean(valueRaw);
    return;
  }

  if (key === "minBodyLength" || key === "min_body_length") {
    target.minBodyLength = parseYamlNumber(valueRaw);
    return;
  }

  if (key === "requiredSections" && valueRaw.startsWith("[")) {
    target.requiredSections = valueRaw
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((item) => stripYamlQuotes(item.trim()))
      .filter(Boolean);
  }
}

function stripYamlComment(line: string): string {
  const commentIndex = line.indexOf("#");
  if (commentIndex < 0) {
    return line;
  }

  return line.slice(0, commentIndex);
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

function parseYamlBoolean(value: string): boolean {
  return stripYamlQuotes(value).toLowerCase() === "true";
}

function parseYamlNumber(value: string): number {
  const parsed = Number(stripYamlQuotes(value));
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
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
