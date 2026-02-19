import { fetchWithRetry, readNumberEnv } from "#core";

interface PublishNotificationParams {
  pushUrl?: string;
  author: string;
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  content: string;
  logger?: NotificationLoggerLike;
}

export async function publishNotification(
  params: PublishNotificationParams,
): Promise<void> {
  const pushUrl = params.pushUrl?.trim();
  if (!pushUrl) {
    return;
  }

  const markdown =
    `**${params.author}** 在项目 **${params.repository}** 发起了评审\n` +
    `源分支：**${params.sourceBranch}**\n` +
    `目标分支：**${params.targetBranch}**\n\n` +
    params.content;

  try {
    const response = await fetchWithRetry(
      pushUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            content: markdown,
          },
        }),
      },
      {
        timeoutMs: readNumberEnv("NOTIFY_HTTP_TIMEOUT_MS", 15_000),
        retries: readNumberEnv("NOTIFY_HTTP_RETRIES", 1),
        backoffMs: readNumberEnv("NOTIFY_HTTP_RETRY_BACKOFF_MS", 300),
      },
    );

    if (!response.ok) {
      params.logger?.error(
        { status: response.status, pushUrl },
        "Notification delivery failed",
      );
    }
  } catch (error) {
    params.logger?.error(
      {
        error: error instanceof Error ? error.message : String(error),
        pushUrl,
      },
      "Notification delivery failed",
    );
  }
}

interface NotificationLoggerLike {
  error(metadata: unknown, message: string): void;
}
