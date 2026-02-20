import OpenAI from "openai";
import { createHash } from "node:crypto";
import { z } from "zod";

import type {
  PullRequestReviewInput,
  PullRequestReviewResult,
} from "./review-types.js";
import { isProcessTemplateFile } from "./review-policy.js";
import type { AskConversationTurn, UiLocale } from "#core";
import {
  fetchWithRetry,
  getHttpShutdownSignal,
  readNumberEnv,
  resolveUiLocale,
} from "#core";

type AIProvider = "openai" | "openai-compatible" | "anthropic" | "gemini";

interface OpenAIClientCacheConfig {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
}

const openAIClientCache = new Map<string, OpenAI>();
const DEFAULT_MAX_OPENAI_CLIENT_CACHE_ENTRIES = 200;
const DEFAULT_AI_MAX_CONCURRENCY = 4;
const DEFAULT_AI_SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

let activeAiRequests = 0;
const aiConcurrencyWaitQueue: Array<() => void> = [];
let aiShutdownRequested = false;

const reviewIssueSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  newPath: z.string().min(1),
  oldPath: z.string().min(1),
  type: z.enum(["old", "new"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  issueHeader: z.string().min(1),
  issueContent: z.string().min(1),
  suggestion: z.string().trim().min(1).max(2000).optional(),
});

const reviewResultSchema = z.object({
  summary: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high"]),
  reviews: z.array(reviewIssueSchema).max(30),
  positives: z.array(z.string()).max(10),
  actionItems: z.array(z.string()).max(10),
});

const reviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "riskLevel", "reviews", "positives", "actionItems"],
  properties: {
    summary: { type: "string" },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    reviews: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "newPath",
          "oldPath",
          "type",
          "startLine",
          "endLine",
          "issueHeader",
          "issueContent",
        ],
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          newPath: { type: "string" },
          oldPath: { type: "string" },
          type: { type: "string", enum: ["old", "new"] },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          issueHeader: { type: "string" },
          issueContent: { type: "string" },
          suggestion: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
          },
        },
      },
    },
    positives: {
      type: "array",
      maxItems: 10,
      items: { type: "string" },
    },
    actionItems: {
      type: "array",
      maxItems: 10,
      items: { type: "string" },
    },
  },
} as const;

const askResultSchema = z.object({
  answer: z.string().trim().min(1).max(10_000),
});

const askResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string" },
  },
} as const;

const REVIEW_SYSTEM_PROMPT_ZH = [
  "你是资深代码评审工程师。",
  "你需要对 PR/MR 进行严格代码评审，输出可执行问题列表。",
  "重点关注：逻辑错误、异常处理、安全风险、并发与幂等、性能、可维护性、测试缺失。",
  "除代码问题外，你还要评估 PR/MR 流程质量：PR 描述完整性、模板遵循度、协作流程合理性。",
  "如果变更涉及 .github 模板、workflow、CODEOWNERS、CONTRIBUTING 等流程文件，必须给出针对流程的建议和评价。",
  "reviews 数组中的行号必须是证据充分的真实行号；不确定就不要输出该问题。",
  "issueHeader 简短（建议 <= 12 字），issueContent 要有明确修复建议。",
  "若有明确且可直接替换的修复代码，可提供 suggestion（仅代码本体，不含解释和 markdown 标记）。",
  "若输入提供了 Team custom review rules，必须严格按规则检查并在结论中体现。",
  "若输入提供了 feedback signals，请在建议中体现这些历史反馈偏好，降低重复误报。",
  "若输入提供了 CI checks，必须结合失败检查给出针对性修复建议。",
  "输出必须是 JSON 对象，不要 markdown 代码块。",
].join("\n");

const REVIEW_SYSTEM_PROMPT_EN = [
  "You are a senior code review engineer.",
  "You must perform strict PR/MR review and output actionable findings.",
  "Focus on: logic defects, error handling, security, concurrency/idempotency, performance, maintainability, and missing tests.",
  "Besides code, evaluate PR/MR process quality: description completeness, template compliance, and collaboration flow.",
  "When changes touch workflow/process files (.github templates, workflow, CODEOWNERS, CONTRIBUTING), provide process-focused feedback.",
  "Line numbers in reviews must map to real diff evidence; skip uncertain findings.",
  "Keep issueHeader concise (recommended <= 12 words), and issueContent must contain a concrete fix direction.",
  "Only provide suggestion when a direct replacement snippet is clear (code only, no markdown wrappers).",
  "If Team custom review rules are provided, enforce them and reflect results in the conclusion.",
  "If feedback signals are provided, adapt recommendations to historical preferences and reduce repeated low-value findings.",
  "If CI checks are provided, include targeted fix advice for failed checks.",
  "Output must be a JSON object; do not use markdown code fences.",
].join("\n");

const ASK_SYSTEM_PROMPT_ZH = [
  "你是资深代码评审助手。",
  "用户会基于同一个 PR/MR 的 diff 提问，请给出准确、可执行、可验证的回答。",
  "回答要先给结论，再给证据（文件/行号/代码片段线索）。",
  "若输入提供了 feedback signals，请优先遵循这些历史反馈偏好。",
  "若信息不足以得出结论，请明确说不确定并指出还缺什么。",
  "输出必须是 JSON 对象，格式为 {\"answer\":\"...\"}，不要 markdown 代码块。",
].join("\n");

const ASK_SYSTEM_PROMPT_EN = [
  "You are a senior code review assistant.",
  "The user asks questions based on one PR/MR diff. Provide precise, actionable, and verifiable answers.",
  "Answer with conclusion first, then evidence (file/line/snippet clues).",
  "If feedback signals are provided, prioritize those historical preferences.",
  "If evidence is insufficient, clearly state uncertainty and what is missing.",
  "Output must be a JSON object in format {\"answer\":\"...\"} with no markdown code fences.",
].join("\n");

export function resolveReviewSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): string {
  return locale === "en" ? REVIEW_SYSTEM_PROMPT_EN : REVIEW_SYSTEM_PROMPT_ZH;
}

export function resolveAskSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): string {
  return locale === "en" ? ASK_SYSTEM_PROMPT_EN : ASK_SYSTEM_PROMPT_ZH;
}

export function openAIClientCacheKey(params: OpenAIClientCacheConfig): string {
  return [
    hashApiKey(params.apiKey),
    params.baseURL ?? "",
    `${params.timeout}`,
    `${params.maxRetries}`,
  ].join("|");
}

export function getOpenAIClientFromCache(params: OpenAIClientCacheConfig): OpenAI {
  const key = openAIClientCacheKey(params);
  const cached = openAIClientCache.get(key);
  if (cached) {
    openAIClientCache.delete(key);
    openAIClientCache.set(key, cached);
    trimOpenAIClientCache();
    return cached;
  }

  const created = new OpenAI(
    params.baseURL
      ? {
          apiKey: params.apiKey,
          baseURL: params.baseURL,
          timeout: params.timeout,
          maxRetries: params.maxRetries,
        }
      : {
          apiKey: params.apiKey,
          timeout: params.timeout,
          maxRetries: params.maxRetries,
        },
  );
  openAIClientCache.set(key, created);
  trimOpenAIClientCache();
  return created;
}

export function __clearOpenAIClientCacheForTests(): void {
  openAIClientCache.clear();
}

export function __resetAiConcurrencyForTests(): void {
  activeAiRequests = 0;
  aiConcurrencyWaitQueue.length = 0;
  aiShutdownRequested = false;
}

export function getAiConcurrencyStats(): {
  activeRequests: number;
  queuedRequests: number;
  shutdownRequested: boolean;
} {
  return {
    activeRequests: activeAiRequests,
    queuedRequests: aiConcurrencyWaitQueue.length,
    shutdownRequested: aiShutdownRequested,
  };
}

export function __withAiConcurrencyLimitForTests<T>(
  task: () => Promise<T>,
): Promise<T> {
  return withAiConcurrencyLimit(task);
}

function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function trimOpenAIClientCache(): void {
  const maxEntries = Math.max(
    1,
    readNumberEnv(
      "MAX_OPENAI_CLIENT_CACHE_ENTRIES",
      DEFAULT_MAX_OPENAI_CLIENT_CACHE_ENTRIES,
    ),
  );
  while (openAIClientCache.size > maxEntries) {
    const oldest = openAIClientCache.keys().next();
    if (oldest.done) {
      break;
    }
    openAIClientCache.delete(oldest.value);
  }
}

function resolveAiMaxConcurrency(): number {
  return Math.max(1, readNumberEnv("AI_MAX_CONCURRENCY", DEFAULT_AI_MAX_CONCURRENCY));
}

async function acquireAiConcurrencySlot(): Promise<void> {
  if (aiShutdownRequested) {
    throw new Error("AI reviewer is shutting down");
  }

  const limit = resolveAiMaxConcurrency();
  while (activeAiRequests >= limit) {
    await new Promise<void>((resolve) => {
      aiConcurrencyWaitQueue.push(resolve);
    });
    if (aiShutdownRequested) {
      throw new Error("AI reviewer is shutting down");
    }
  }

  activeAiRequests += 1;
}

function releaseAiConcurrencySlot(): void {
  activeAiRequests = Math.max(0, activeAiRequests - 1);
  const next = aiConcurrencyWaitQueue.shift();
  if (next) {
    next();
  }
}

async function withAiConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
  await acquireAiConcurrencySlot();
  try {
    return await task();
  } finally {
    releaseAiConcurrencySlot();
  }
}

export function beginAiShutdown(): void {
  aiShutdownRequested = true;
  while (aiConcurrencyWaitQueue.length > 0) {
    const waiter = aiConcurrencyWaitQueue.shift();
    waiter?.();
  }
}

export async function drainAiRequests(
  timeoutMs = readNumberEnv(
    "AI_SHUTDOWN_DRAIN_TIMEOUT_MS",
    DEFAULT_AI_SHUTDOWN_DRAIN_TIMEOUT_MS,
  ),
): Promise<boolean> {
  beginAiShutdown();
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (activeAiRequests > 0 && Date.now() < deadline) {
    await sleep(50);
  }
  return activeAiRequests === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function analyzePullRequest(
  pullRequest: PullRequestReviewInput,
): Promise<PullRequestReviewResult> {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const prompt = buildUserPrompt(pullRequest);

  const parsed = await withAiConcurrencyLimit(async () => {
    if (provider === "openai" || provider === "openai-compatible") {
      return analyzeWithOpenAI({ provider, model, prompt });
    }
    if (provider === "anthropic") {
      return analyzeWithAnthropic({ model, prompt });
    }
    return analyzeWithGemini({ model, prompt });
  });

  const result = reviewResultSchema.parse(
    normalizeReviewResultForSchema(parsed),
  );
  return {
    ...result,
    reviews: result.reviews.map((item) => {
      const startLine = Math.min(item.startLine, item.endLine);
      const endLine = Math.max(item.startLine, item.endLine);
      const suggestion = item.suggestion?.trim();
      return {
        ...item,
        startLine,
        endLine,
        suggestion: suggestion || undefined,
      };
    }),
  };
}

export async function answerPullRequestQuestion(
  pullRequest: PullRequestReviewInput,
  question: string,
  options?: {
    conversation?: AskConversationTurn[];
  },
): Promise<string> {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const prompt = buildAskPrompt(
    pullRequest,
    question,
    options?.conversation ?? [],
  );

  const parsed = await withAiConcurrencyLimit(async () => {
    if (provider === "openai" || provider === "openai-compatible") {
      return askWithOpenAI({ provider, model, prompt });
    }
    if (provider === "anthropic") {
      return askWithAnthropic({ model, prompt });
    }
    return askWithGemini({ model, prompt });
  });

  const result = askResultSchema.parse(normalizeAskResultForSchema(parsed));
  return result.answer.trim();
}

export function normalizeReviewResultForSchema(parsed: unknown): {
  summary: string;
  riskLevel: "low" | "medium" | "high";
  reviews: Array<{
    severity: "low" | "medium" | "high";
    newPath: string;
    oldPath: string;
    type: "old" | "new";
    startLine: number;
    endLine: number;
    issueHeader: string;
    issueContent: string;
    suggestion?: string;
  }>;
  positives: string[];
  actionItems: string[];
} {
  const root = asRecord(parsed) ?? {};
  const reviews = normalizeReviewIssues(root.reviews).slice(0, 30);
  const riskLevel =
    normalizeRiskLevel(root.riskLevel) ?? inferRiskLevelFromReviews(reviews);
  const summary =
    readNonEmptyString(root.summary) ??
    (reviews.length > 0
      ? `Detected ${reviews.length} potential issue(s) in changed lines.`
      : "No significant issues detected in changed lines.");

  return {
    summary,
    riskLevel,
    reviews,
    positives: normalizeStringArray(root.positives).slice(0, 10),
    actionItems: normalizeStringArray(root.actionItems).slice(0, 10),
  };
}

export function normalizeAskResultForSchema(parsed: unknown): {
  answer: string;
} {
  if (typeof parsed === "string") {
    const direct = parsed.trim();
    if (direct) {
      return { answer: direct };
    }
  }

  const root = asRecord(parsed) ?? {};
  const answer =
    readNonEmptyString(root.answer) ??
    readNonEmptyString(root.summary) ??
    "Model did not return a structured answer. Please try again.";

  return { answer };
}

function buildReviewFallbackFromNonJsonText(text: string): {
  summary: string;
  riskLevel: "low";
  reviews: [];
  positives: [];
  actionItems: [string];
} {
  const normalized = text.replace(/\s+/g, " ").trim();
  const snippet = normalized.slice(0, 240);
  const summary = snippet
    ? `Model returned non-JSON output. Preview: ${snippet}`
    : "Model returned non-JSON output.";

  return {
    summary,
    riskLevel: "low",
    reviews: [],
    positives: [],
    actionItems: [
      "Model output was not structured JSON; consider using a model with stronger structured-output support.",
    ],
  };
}

function normalizeReviewIssues(value: unknown): Array<{
  severity: "low" | "medium" | "high";
  newPath: string;
  oldPath: string;
  type: "old" | "new";
  startLine: number;
  endLine: number;
  issueHeader: string;
  issueContent: string;
  suggestion?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: Array<{
    severity: "low" | "medium" | "high";
    newPath: string;
    oldPath: string;
    type: "old" | "new";
    startLine: number;
    endLine: number;
    issueHeader: string;
    issueContent: string;
    suggestion?: string;
  }> = [];

  for (const item of value) {
    const normalized = normalizeReviewIssue(item);
    if (normalized) {
      result.push(normalized);
    }
  }

  return result;
}

function normalizeReviewIssue(value: unknown):
  | {
      severity: "low" | "medium" | "high";
      newPath: string;
      oldPath: string;
      type: "old" | "new";
      startLine: number;
      endLine: number;
      issueHeader: string;
      issueContent: string;
      suggestion?: string;
    }
  | undefined {
  const item = asRecord(value);
  if (!item) {
    return undefined;
  }

  const newPath =
    readNonEmptyString(item.newPath) ??
    readNonEmptyString(item.oldPath) ??
    "unknown";
  const oldPath =
    readNonEmptyString(item.oldPath) ??
    readNonEmptyString(item.newPath) ??
    newPath;
  const type = item.type === "old" || item.type === "new" ? item.type : "new";
  const startLine = normalizePositiveInt(item.startLine) ?? 1;
  const endLine = normalizePositiveInt(item.endLine) ?? startLine;
  const severity = normalizeSeverity(item.severity) ?? "medium";
  const issueHeader = readNonEmptyString(item.issueHeader) ?? "Potential issue";
  const issueContent =
    readNonEmptyString(item.issueContent) ??
    "Please review this change for potential issues.";
  const suggestion = readNonEmptyString(item.suggestion);

  return {
    severity,
    newPath,
    oldPath,
    type,
    startLine,
    endLine,
    issueHeader,
    issueContent,
    suggestion: suggestion ? suggestion.slice(0, 2000) : undefined,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) {
      result.push(trimmed);
    }
  }
  return result;
}

function normalizeRiskLevel(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function normalizeSeverity(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function inferRiskLevelFromReviews(
  reviews: Array<{ severity: "low" | "medium" | "high" }>,
): "low" | "medium" | "high" {
  if (reviews.some((item) => item.severity === "high")) {
    return "high";
  }
  if (reviews.some((item) => item.severity === "medium")) {
    return "medium";
  }
  return "low";
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const normalized = Math.floor(parsed);
      return normalized > 0 ? normalized : undefined;
    }
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function buildPromptHeaderAndDescription(
  pullRequest: PullRequestReviewInput,
): string[] {
  return [
    `Platform: ${pullRequest.platform}`,
    `Repository: ${pullRequest.repository}`,
    `Number: #${pullRequest.number}`,
    `Title: ${pullRequest.title}`,
    `Author: ${pullRequest.author}`,
    `Base -> Head: ${pullRequest.baseBranch} -> ${pullRequest.headBranch}`,
    `Additions: ${pullRequest.additions}, Deletions: ${pullRequest.deletions}, Changed files: ${pullRequest.changedFilesCount}`,
    "",
    "Description:",
    pullRequest.body || "(empty)",
    "",
  ];
}

function formatDiffFilesForPrompt(
  files: PullRequestReviewInput["changedFiles"],
  maxFiles: number | undefined,
): string {
  const selectedFiles = maxFiles ? files.slice(0, maxFiles) : files;
  return selectedFiles
    .map((file, index) => {
      return [
        `### File ${index + 1}`,
        `new_path=${file.newPath}`,
        `old_path=${file.oldPath}`,
        `status=${file.status}, additions=${file.additions}, deletions=${file.deletions}`,
        "```diff",
        file.extendedDiff,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function formatGuidelinesForPrompt(
  processGuidelines: PullRequestReviewInput["processGuidelines"],
): string {
  if (!processGuidelines || processGuidelines.length === 0) {
    return "(none)";
  }

  return processGuidelines
    .map((item, index) => {
      return [
        `### Guideline ${index + 1}`,
        `path=${item.path}`,
        "```text",
        item.content.slice(0, 2_000),
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function formatStringListForPrompt(items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return "(none)";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function formatCiChecksForPrompt(
  ciChecks: PullRequestReviewInput["ciChecks"],
): string {
  if (!ciChecks || ciChecks.length === 0) {
    return "(none)";
  }

  return ciChecks
    .slice(0, 30)
    .map((item) => {
      const url = item.detailsUrl ? `, url=${item.detailsUrl}` : "";
      const summary = item.summary ? `\n  summary=${item.summary}` : "";
      return `- ${item.name} (status=${item.status}, conclusion=${item.conclusion}${url})${summary}`;
    })
    .join("\n");
}

function formatProcessFilesForPrompt(pullRequest: PullRequestReviewInput): string {
  const processFiles = pullRequest.changedFiles.filter(
    (file) =>
      isProcessTemplateFile(file.newPath, pullRequest.platform) ||
      isProcessTemplateFile(file.oldPath, pullRequest.platform),
  );
  if (processFiles.length === 0) {
    return "(none)";
  }

  return processFiles
    .map((file) => `- ${file.newPath} (status=${file.status})`)
    .join("\n");
}

function buildPromptSharedSections(params: {
  pullRequest: PullRequestReviewInput;
  maxDiffFiles?: number;
  includeProcessFiles: boolean;
}): string[] {
  const { pullRequest, maxDiffFiles, includeProcessFiles } = params;
  const sections: string[] = [...buildPromptHeaderAndDescription(pullRequest)];

  if (includeProcessFiles) {
    const processFilesText = formatProcessFilesForPrompt(pullRequest);
    sections.push("Process/template files in this change:");
    sections.push(processFilesText);
    sections.push("");
  }

  const guidelinesText = formatGuidelinesForPrompt(pullRequest.processGuidelines);
  const customRulesText = formatStringListForPrompt(pullRequest.customRules);
  const feedbackSignalsText = formatStringListForPrompt(
    pullRequest.feedbackSignals,
  );
  const ciChecksText = formatCiChecksForPrompt(pullRequest.ciChecks);
  const filesText = formatDiffFilesForPrompt(pullRequest.changedFiles, maxDiffFiles);

  sections.push("Repository process guidelines (.github templates/workflows/etc):");
  sections.push(guidelinesText);
  sections.push("");
  sections.push("Team custom review rules:");
  sections.push(customRulesText);
  sections.push("");
  sections.push("Feedback signals from developers:");
  sections.push(feedbackSignalsText);
  sections.push("");
  sections.push("CI checks on current head:");
  sections.push(ciChecksText);
  sections.push("");
  sections.push("Diff with line mapping:");
  sections.push(filesText || "(no textual patch available)");
  sections.push("");
  return sections;
}

export function buildUserPrompt(pullRequest: PullRequestReviewInput): string {
  return [
    ...buildPromptSharedSections({
      pullRequest,
      maxDiffFiles: undefined,
      includeProcessFiles: true,
    }),
    "输出要求:",
    "1) 仅输出 JSON 对象；",
    "2) reviews 每项都要填 newPath/oldPath/type/startLine/endLine；",
    "3) line 必须来自上面 diff 的真实行号；",
    "4) 若没有明确问题，reviews 为空数组；",
    "5) 若存在流程/模板改动，actionItems 至少包含 1 条流程改进建议。",
    "6) 仅当能给出可直接替换的修复代码时，才填写 suggestion 字段。",
    "7) 若 Team custom review rules 非空，必须覆盖这些规则的检查结果。",
    "8) 若存在失败 CI checks，actionItems 至少包含 1 条与失败检查直接相关的修复建议。",
    "9) 若 Feedback signals 非空，尽量避免重复历史上被判定为低价值的建议形态。",
  ].join("\n");
}

export function buildAskPrompt(
  pullRequest: PullRequestReviewInput,
  question: string,
  conversation: AskConversationTurn[] = [],
): string {
  const conversationText = formatAskConversationForPrompt(conversation);
  return [
    ...buildPromptSharedSections({
      pullRequest,
      maxDiffFiles: 40,
      includeProcessFiles: false,
    }),
    "Previous Q&A context:",
    conversationText,
    "",
    "用户问题：",
    question.trim(),
    "",
    "输出要求：仅返回 JSON 对象 {\"answer\":\"...\"}。",
  ].join("\n");
}

function formatAskConversationForPrompt(conversation: AskConversationTurn[]): string {
  if (!conversation || conversation.length === 0) {
    return "(none)";
  }

  return conversation
    .slice(-6)
    .map((turn, index) => {
      const question = turn.question.trim();
      const answer = turn.answer.trim();
      return [
        `### Turn ${index + 1}`,
        `Q: ${question || "(empty)"}`,
        `A: ${answer || "(empty)"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function resolveProvider(): AIProvider {
  const raw = (process.env.AI_PROVIDER ?? "openai").trim().toLowerCase();

  if (raw === "openai") {
    return "openai";
  }

  if (
    raw === "openai-compatible" ||
    raw === "openai_compatible" ||
    raw === "compatible"
  ) {
    return "openai-compatible";
  }

  if (raw === "anthropic" || raw === "claude") {
    return "anthropic";
  }

  if (raw === "gemini" || raw === "google") {
    return "gemini";
  }

  throw new Error(`Unsupported AI_PROVIDER: ${raw}`);
}

function resolveModel(provider: AIProvider): string {
  const genericModel = process.env.AI_MODEL?.trim();
  if (genericModel) {
    return genericModel;
  }

  if (provider === "openai") {
    return process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  }

  if (provider === "openai-compatible") {
    return process.env.OPENAI_COMPATIBLE_MODEL ?? "gpt-4o-mini";
  }

  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";
  }

  return process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
}

async function analyzeWithOpenAI(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
}): Promise<unknown> {
  const systemPrompt = resolveReviewSystemPrompt();
  const apiKey =
    params.provider === "openai-compatible"
      ? (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY)
      : process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      params.provider === "openai-compatible"
        ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
        : "Missing OPENAI_API_KEY",
    );
  }

  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  if (params.provider === "openai-compatible" && !baseURL) {
    throw new Error(
      "Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible",
    );
  }

  const timeout = readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000);
  const maxRetries = readNumberEnv("AI_HTTP_RETRIES", 2);
  const client = getOpenAIClientFromCache({
    apiKey,
    baseURL,
    timeout,
    maxRetries,
  });

  try {
    const completion = await client.chat.completions.create(
      {
        model: params.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: params.prompt,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pr_review",
            strict: true,
            schema: reviewResultJsonSchema,
          },
        },
      },
      {
        signal: getHttpShutdownSignal(),
      },
    );

    return parseJsonFromModelText(
      extractText(completion.choices[0]?.message.content),
    );
  } catch (error) {
    if (
      params.provider !== "openai-compatible" ||
      !shouldTryOpenAICompatibleFallback(error)
    ) {
      throw error;
    }

    try {
      const completion = await client.chat.completions.create(
        {
          model: params.model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: `${params.prompt}\n\n请直接返回 JSON。`,
            },
          ],
          response_format: {
            type: "json_object",
          },
        },
        {
          signal: getHttpShutdownSignal(),
        },
      );

      return parseJsonFromModelText(
        extractText(completion.choices[0]?.message.content),
      );
    } catch (fallbackError) {
      if (!shouldTryOpenAICompatibleFallback(fallbackError)) {
        throw fallbackError;
      }

      const completion = await client.chat.completions.create(
        {
          model: params.model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: `${params.prompt}\n\n请直接返回 JSON。`,
            },
          ],
        },
        {
          signal: getHttpShutdownSignal(),
        },
      );

      const text = extractText(completion.choices[0]?.message.content);
      try {
        return parseJsonFromModelText(text);
      } catch (parseError) {
        if (!isModelResponseNotJsonError(parseError)) {
          throw parseError;
        }
        return buildReviewFallbackFromNonJsonText(text);
      }
    }
  }
}

async function analyzeWithAnthropic(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  return callAnthropicJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveReviewSystemPrompt(),
    responseSchema: reviewResultJsonSchema,
  });
}

async function analyzeWithGemini(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  return callGeminiJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveReviewSystemPrompt(),
    responseSchema: reviewResultJsonSchema,
  });
}

async function askWithOpenAI(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
}): Promise<unknown> {
  const systemPrompt = resolveAskSystemPrompt();
  const apiKey =
    params.provider === "openai-compatible"
      ? (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY)
      : process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      params.provider === "openai-compatible"
        ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
        : "Missing OPENAI_API_KEY",
    );
  }

  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  if (params.provider === "openai-compatible" && !baseURL) {
    throw new Error(
      "Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible",
    );
  }

  const timeout = readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000);
  const maxRetries = readNumberEnv("AI_HTTP_RETRIES", 2);
  const client = getOpenAIClientFromCache({
    apiKey,
    baseURL,
    timeout,
    maxRetries,
  });

  try {
    const completion = await client.chat.completions.create(
      {
        model: params.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: params.prompt,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pr_ask",
            strict: true,
            schema: askResultJsonSchema,
          },
        },
      },
      {
        signal: getHttpShutdownSignal(),
      },
    );

    return parseJsonFromModelText(
      extractText(completion.choices[0]?.message.content),
    );
  } catch (error) {
    if (
      params.provider !== "openai-compatible" ||
      !shouldTryOpenAICompatibleFallback(error)
    ) {
      throw error;
    }

    try {
      const completion = await client.chat.completions.create(
        {
          model: params.model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: `${params.prompt}\n\n请直接返回 JSON。`,
            },
          ],
          response_format: {
            type: "json_object",
          },
        },
        {
          signal: getHttpShutdownSignal(),
        },
      );

      return parseJsonFromModelText(
        extractText(completion.choices[0]?.message.content),
      );
    } catch (fallbackError) {
      if (!shouldTryOpenAICompatibleFallback(fallbackError)) {
        throw fallbackError;
      }

      const completion = await client.chat.completions.create(
        {
          model: params.model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: `${params.prompt}\n\n请直接返回 JSON。`,
            },
          ],
        },
        {
          signal: getHttpShutdownSignal(),
        },
      );

      const text = extractText(completion.choices[0]?.message.content);
      try {
        return parseJsonFromModelText(text);
      } catch (parseError) {
        if (!isModelResponseNotJsonError(parseError)) {
          throw parseError;
        }
        return { answer: text.trim() || "Model returned empty answer." };
      }
    }
  }
}

function shouldTryOpenAICompatibleFallback(error: unknown): boolean {
  return shouldFallbackToJsonObject(error) || isModelResponseNotJsonError(error);
}

export function isModelResponseNotJsonError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("model response is not valid json") ||
    message.includes("model returned empty text") ||
    message.includes("model returned empty content")
  );
}

export function shouldFallbackToJsonObject(error: unknown): boolean {
  if (readErrorStatus(error) !== 400) {
    return false;
  }

  const message = collectErrorText(error).toLowerCase();
  if (!message) {
    return false;
  }

  const mentionsResponseFormat = message.includes("response_format");
  const mentionsJsonSchema =
    message.includes("json_schema") || message.includes("json schema");
  if (!mentionsResponseFormat && !mentionsJsonSchema) {
    return false;
  }

  return (
    message.includes("unsupported") ||
    message.includes("not support") ||
    message.includes("not implemented") ||
    message.includes("invalid") ||
    message.includes("illegal") ||
    message.includes("not valid") ||
    message.includes("not allowed") ||
    message.includes("不合法") ||
    message.includes("非法") ||
    message.includes("无效")
  );
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = (error as { status?: unknown }).status;
  return typeof candidate === "number" ? candidate : undefined;
}

function collectErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (!error || typeof error !== "object") {
    return "";
  }

  const bucket: string[] = [];
  const root = error as {
    message?: unknown;
    error?: { message?: unknown };
    response?: { data?: { error?: { message?: unknown } } };
  };

  if (typeof root.message === "string") {
    bucket.push(root.message);
  }
  if (typeof root.error?.message === "string") {
    bucket.push(root.error.message);
  }
  if (typeof root.response?.data?.error?.message === "string") {
    bucket.push(root.response.data.error.message);
  }

  return bucket.join(" ");
}

async function askWithAnthropic(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  return callAnthropicJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveAskSystemPrompt(),
    responseSchema: askResultJsonSchema,
  });
}

async function askWithGemini(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  return callGeminiJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveAskSystemPrompt(),
    responseSchema: askResultJsonSchema,
  });
}

export interface AiProviderProbeResult {
  ok: boolean;
  provider: AIProvider;
  model: string;
  status: number;
  latencyMs: number;
  error?: string;
}

export async function probeAiProviderConnectivity(params?: {
  timeoutMs?: number;
}): Promise<AiProviderProbeResult> {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const startedAt = Date.now();
  const timeoutMs = Math.max(
    500,
    params?.timeoutMs ?? readNumberEnv("HEALTHCHECK_AI_TIMEOUT_MS", 5_000),
  );

  try {
    const status = await probeProviderRequest(provider, model, timeoutMs);
    return {
      ok: status >= 200 && status < 300,
      provider,
      model,
      status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      provider,
      model,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeProviderRequest(
  provider: AIProvider,
  model: string,
  timeoutMs: number,
): Promise<number> {
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey =
      provider === "openai-compatible"
        ? (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY)
        : process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        provider === "openai-compatible"
          ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
          : "Missing OPENAI_API_KEY",
      );
    }
    const baseUrl =
      provider === "openai-compatible"
        ? (process.env.OPENAI_BASE_URL?.trim() ?? "")
        : "https://api.openai.com/v1";
    if (!baseUrl) {
      throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
    }
    const response = await fetchWithRetry(
      `${baseUrl.replace(/\/$/, "")}/models`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      },
      {
        timeoutMs,
        retries: 0,
        backoffMs: 0,
      },
    );
    return response.status;
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY");
    }
    const response = await fetchWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "health-check" }],
        }),
      },
      {
        timeoutMs,
        retries: 0,
        backoffMs: 0,
      },
    );
    return response.status;
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }
  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`,
    {
      method: "GET",
    },
    {
      timeoutMs,
      retries: 0,
      backoffMs: 0,
    },
  );
  return response.status;
}

async function callAnthropicJson(params: {
  model: string;
  prompt: string;
  systemPrompt: string;
  responseSchema?: Record<string, unknown>;
}): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const requestOptions = {
    timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
    retries: readNumberEnv("AI_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
  } as const;

  const sendRequest = async (useTools: boolean): Promise<Response> =>
    fetchWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          buildAnthropicRequestBody({
            model: params.model,
            systemPrompt: params.systemPrompt,
            prompt: params.prompt,
            responseSchema: useTools ? params.responseSchema : undefined,
          }),
        ),
      },
      requestOptions,
    );

  let response = await sendRequest(Boolean(params.responseSchema));
  if (!response.ok) {
    const body = await response.text();
    if (
      params.responseSchema &&
      shouldRetryAnthropicWithoutTools(response.status, body)
    ) {
      response = await sendRequest(false);
    } else {
      throw new Error(
        `Anthropic API error (${response.status}): ${body.slice(0, 300)}`,
      );
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as AnthropicResponsePayload;
  return parseAnthropicJsonPayload(payload);
}

function buildAnthropicRequestBody(params: {
  model: string;
  systemPrompt: string;
  prompt: string;
  responseSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: Math.max(1, readNumberEnv("ANTHROPIC_MAX_TOKENS", 8_192)),
    temperature: 0.2,
    system: params.systemPrompt,
    messages: [{ role: "user", content: params.prompt }],
  };
  if (!params.responseSchema) {
    return body;
  }

  body.tools = [
    {
      name: "emit_json",
      description: "Emit a structured JSON payload matching the required schema.",
      input_schema: params.responseSchema,
    },
  ];
  body.tool_choice = { type: "tool", name: "emit_json" };
  return body;
}

async function callGeminiJson(params: {
  model: string;
  prompt: string;
  systemPrompt: string;
  responseSchema?: Record<string, unknown>;
}): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    params.model,
  )}:generateContent`;

  const requestOptions = {
    timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
    retries: readNumberEnv("AI_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
  } as const;

  const sendRequest = async (includeSchema: boolean): Promise<Response> =>
    fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: params.systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: params.prompt }],
            },
          ],
          generationConfig: buildGeminiGenerationConfig(
            includeSchema ? params.responseSchema : undefined,
          ),
        }),
      },
      requestOptions,
    );

  let response = await sendRequest(Boolean(params.responseSchema));
  if (!response.ok) {
    const body = await response.text();
    if (
      params.responseSchema &&
      shouldRetryGeminiWithoutSchema(response.status, body)
    ) {
      response = await sendRequest(false);
    } else {
      throw new Error(
        `Gemini API error (${response.status}): ${body.slice(0, 300)}`,
      );
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gemini API error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim() ?? "";

  if (!text) {
    throw new Error("Gemini response has no text content");
  }

  return parseJsonFromModelText(text);
}

export function buildGeminiGenerationConfig(
  responseSchema?: Record<string, unknown>,
): {
  temperature: number;
  responseMimeType: string;
  responseSchema?: Record<string, unknown>;
} {
  if (responseSchema) {
    return {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema,
    };
  }

  return {
    temperature: 0.2,
    responseMimeType: "application/json",
  };
}

export function shouldRetryGeminiWithoutSchema(
  status: number,
  errorText: string,
): boolean {
  if (status !== 400) {
    return false;
  }

  const normalized = errorText.toLowerCase();
  if (!normalized) {
    return false;
  }

  const mentionsSchema =
    normalized.includes("responseschema") ||
    normalized.includes("response_schema");
  if (!mentionsSchema) {
    return false;
  }

  return (
    normalized.includes("unknown name") ||
    normalized.includes("unsupported") ||
    normalized.includes("not support") ||
    normalized.includes("not implemented")
  );
}

export function shouldRetryAnthropicWithoutTools(
  status: number,
  errorText: string,
): boolean {
  if (status !== 400) {
    return false;
  }

  const normalized = errorText.toLowerCase();
  if (!normalized) {
    return false;
  }

  const mentionsTooling =
    normalized.includes("tool_choice") ||
    normalized.includes("tool use") ||
    normalized.includes("tool_use") ||
    normalized.includes("tools") ||
    normalized.includes("input_schema");
  if (!mentionsTooling) {
    return false;
  }

  return (
    normalized.includes("unknown") ||
    normalized.includes("unsupported") ||
    normalized.includes("not support") ||
    normalized.includes("not implemented") ||
    normalized.includes("invalid_request_error")
  );
}

type AnthropicResponsePayload = {
  content?: Array<{ type?: string; text?: string; input?: unknown }>;
};

export function parseAnthropicJsonPayload(payload: AnthropicResponsePayload): unknown {
  const toolInput = payload.content?.find((item) => item.type === "tool_use")?.input;
  if (toolInput !== undefined) {
    return toolInput;
  }

  const text =
    payload.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n")
      .trim() ?? "";

  if (!text) {
    throw new Error("Anthropic response has no text or tool_use content");
  }

  return parseJsonFromModelText(text);
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          "text" in part &&
          (part as { type?: string }).type === "text"
        ) {
          return (part as { text?: string }).text ?? "";
        }

        return "";
      })
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  throw new Error("Model returned empty content");
}

function parseJsonFromModelText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model returned empty text");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // fall through
      }
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through
      }
    }

    throw new Error("Model response is not valid JSON");
  }
}
