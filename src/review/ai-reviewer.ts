import OpenAI from "openai";
import { z } from "zod";

import type {
  PullRequestReviewInput,
  PullRequestReviewResult,
} from "./review-types.js";
import { isProcessTemplateFile } from "./review-policy.js";
import { fetchWithRetry, readNumberEnv } from "#core";

type AIProvider = "openai" | "openai-compatible" | "anthropic" | "gemini";

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

const SYSTEM_PROMPT = [
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

const ASK_SYSTEM_PROMPT = [
  "你是资深代码评审助手。",
  "用户会基于同一个 PR/MR 的 diff 提问，请给出准确、可执行、可验证的回答。",
  "回答要先给结论，再给证据（文件/行号/代码片段线索）。",
  "若输入提供了 feedback signals，请优先遵循这些历史反馈偏好。",
  "若信息不足以得出结论，请明确说不确定并指出还缺什么。",
  "输出必须是 JSON 对象，格式为 {\"answer\":\"...\"}，不要 markdown 代码块。",
].join("\n");

export async function analyzePullRequest(
  pullRequest: PullRequestReviewInput,
): Promise<PullRequestReviewResult> {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const prompt = buildUserPrompt(pullRequest);

  let parsed: unknown;
  if (provider === "openai" || provider === "openai-compatible") {
    parsed = await analyzeWithOpenAI({ provider, model, prompt });
  } else if (provider === "anthropic") {
    parsed = await analyzeWithAnthropic({ model, prompt });
  } else {
    parsed = await analyzeWithGemini({ model, prompt });
  }

  const result = reviewResultSchema.parse(parsed);
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
): Promise<string> {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const prompt = buildAskPrompt(pullRequest, question);

  let parsed: unknown;
  if (provider === "openai" || provider === "openai-compatible") {
    parsed = await askWithOpenAI({ provider, model, prompt });
  } else if (provider === "anthropic") {
    parsed = await askWithAnthropic({ model, prompt });
  } else {
    parsed = await askWithGemini({ model, prompt });
  }

  const result = askResultSchema.parse(parsed);
  return result.answer.trim();
}

function buildUserPrompt(pullRequest: PullRequestReviewInput): string {
  const processFiles = pullRequest.changedFiles.filter(
    (file) =>
      isProcessTemplateFile(file.newPath, pullRequest.platform) ||
      isProcessTemplateFile(file.oldPath, pullRequest.platform),
  );

  const processFilesText =
    processFiles.length === 0
      ? "(none)"
      : processFiles
          .map((file) => `- ${file.newPath} (status=${file.status})`)
          .join("\n");

  const filesText = pullRequest.changedFiles
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

  const guidelinesText =
    pullRequest.processGuidelines && pullRequest.processGuidelines.length > 0
      ? pullRequest.processGuidelines
          .map((item, index) => {
            return [
              `### Guideline ${index + 1}`,
              `path=${item.path}`,
              "```text",
              item.content.slice(0, 2_000),
              "```",
            ].join("\n");
          })
          .join("\n\n")
      : "(none)";

  const customRulesText =
    pullRequest.customRules && pullRequest.customRules.length > 0
      ? pullRequest.customRules.map((rule) => `- ${rule}`).join("\n")
      : "(none)";

  const feedbackSignalsText =
    pullRequest.feedbackSignals && pullRequest.feedbackSignals.length > 0
      ? pullRequest.feedbackSignals.map((signal) => `- ${signal}`).join("\n")
      : "(none)";

  const ciChecksText =
    pullRequest.ciChecks && pullRequest.ciChecks.length > 0
      ? pullRequest.ciChecks
          .slice(0, 30)
          .map((item) => {
            const url = item.detailsUrl ? `, url=${item.detailsUrl}` : "";
            const summary = item.summary ? `\n  summary=${item.summary}` : "";
            return `- ${item.name} (status=${item.status}, conclusion=${item.conclusion}${url})${summary}`;
          })
          .join("\n")
      : "(none)";

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
    "Process/template files in this change:",
    processFilesText,
    "",
    "Repository process guidelines (.github templates/workflows/etc):",
    guidelinesText,
    "",
    "Team custom review rules:",
    customRulesText,
    "",
    "Feedback signals from developers:",
    feedbackSignalsText,
    "",
    "CI checks on current head:",
    ciChecksText,
    "",
    "Diff with line mapping:",
    filesText || "(no textual patch available)",
    "",
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

function buildAskPrompt(
  pullRequest: PullRequestReviewInput,
  question: string,
): string {
  const filesText = pullRequest.changedFiles
    .slice(0, 40)
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

  const guidelinesText =
    pullRequest.processGuidelines && pullRequest.processGuidelines.length > 0
      ? pullRequest.processGuidelines
          .map((item, index) => {
            return [
              `### Guideline ${index + 1}`,
              `path=${item.path}`,
              "```text",
              item.content.slice(0, 2_000),
              "```",
            ].join("\n");
          })
          .join("\n\n")
      : "(none)";

  const customRulesText =
    pullRequest.customRules && pullRequest.customRules.length > 0
      ? pullRequest.customRules.map((rule) => `- ${rule}`).join("\n")
      : "(none)";

  const feedbackSignalsText =
    pullRequest.feedbackSignals && pullRequest.feedbackSignals.length > 0
      ? pullRequest.feedbackSignals.map((signal) => `- ${signal}`).join("\n")
      : "(none)";

  const ciChecksText =
    pullRequest.ciChecks && pullRequest.ciChecks.length > 0
      ? pullRequest.ciChecks
          .slice(0, 30)
          .map((item) => {
            const url = item.detailsUrl ? `, url=${item.detailsUrl}` : "";
            const summary = item.summary ? `\n  summary=${item.summary}` : "";
            return `- ${item.name} (status=${item.status}, conclusion=${item.conclusion}${url})${summary}`;
          })
          .join("\n")
      : "(none)";

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
    "Repository process guidelines (.github templates/workflows/etc):",
    guidelinesText,
    "",
    "Team custom review rules:",
    customRulesText,
    "",
    "Feedback signals from developers:",
    feedbackSignalsText,
    "",
    "CI checks on current head:",
    ciChecksText,
    "",
    "Diff with line mapping:",
    filesText || "(no textual patch available)",
    "",
    "用户问题：",
    question.trim(),
    "",
    "输出要求：仅返回 JSON 对象 {\"answer\":\"...\"}。",
  ].join("\n");
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
  const client = new OpenAI(
    baseURL
      ? { apiKey, baseURL, timeout, maxRetries }
      : { apiKey, timeout, maxRetries },
  );

  try {
    const completion = await client.chat.completions.create({
      model: params.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
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
    });

    return parseJsonFromModelText(
      extractText(completion.choices[0]?.message.content),
    );
  } catch (error) {
    if (params.provider !== "openai-compatible") {
      throw error;
    }

    const completion = await client.chat.completions.create({
      model: params.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `${params.prompt}\n\n请直接返回 JSON。`,
        },
      ],
      response_format: {
        type: "json_object",
      },
    });

    return parseJsonFromModelText(
      extractText(completion.choices[0]?.message.content),
    );
  }
}

async function analyzeWithAnthropic(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
        model: params.model,
        max_tokens: Math.max(1, readNumberEnv("ANTHROPIC_MAX_TOKENS", 4_096)),
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: params.prompt }],
      }),
    },
    {
      timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("AI_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text =
    payload.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n")
      .trim() ?? "";

  if (!text) {
    throw new Error("Anthropic response has no text content");
  }

  return parseJsonFromModelText(text);
}

async function analyzeWithGemini(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    params.model,
  )}:generateContent`;

  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: params.prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
    {
      timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("AI_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

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

async function askWithOpenAI(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
}): Promise<unknown> {
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
  const client = new OpenAI(
    baseURL
      ? { apiKey, baseURL, timeout, maxRetries }
      : { apiKey, timeout, maxRetries },
  );

  try {
    const completion = await client.chat.completions.create({
      model: params.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: ASK_SYSTEM_PROMPT,
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
    });

    return parseJsonFromModelText(
      extractText(completion.choices[0]?.message.content),
    );
  } catch (error) {
    if (params.provider !== "openai-compatible") {
      throw error;
    }

    const completion = await client.chat.completions.create({
      model: params.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: ASK_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `${params.prompt}\n\n请直接返回 JSON。`,
        },
      ],
      response_format: {
        type: "json_object",
      },
    });

    return parseJsonFromModelText(
      extractText(completion.choices[0]?.message.content),
    );
  }
}

async function askWithAnthropic(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
        model: params.model,
        max_tokens: Math.max(1, readNumberEnv("ANTHROPIC_MAX_TOKENS", 4_096)),
        temperature: 0.2,
        system: ASK_SYSTEM_PROMPT,
        messages: [{ role: "user", content: params.prompt }],
      }),
    },
    {
      timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("AI_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text =
    payload.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n")
      .trim() ?? "";

  if (!text) {
    throw new Error("Anthropic response has no text content");
  }

  return parseJsonFromModelText(text);
}

async function askWithGemini(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    params.model,
  )}:generateContent`;

  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: ASK_SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: params.prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
    {
      timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("AI_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

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
