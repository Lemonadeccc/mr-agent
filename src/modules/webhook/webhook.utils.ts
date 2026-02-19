export function normalizeHeaderRecord(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  return normalized;
}

export function formatLogMessage(message: string, metadata: unknown): string {
  if (!metadata) {
    return message;
  }

  try {
    return `${message} ${JSON.stringify(metadata)}`;
  } catch {
    return message;
  }
}
