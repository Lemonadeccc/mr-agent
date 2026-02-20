const MAX_CUSTOM_SECRET_PATTERNS = 20;
const MAX_CUSTOM_SECRET_PATTERN_LENGTH = 240;

export function compileCustomSecretPatterns(rawPatterns: string[]): RegExp[] {
  return rawPatterns
    .map((raw) => raw.trim())
    .filter(Boolean)
    .slice(0, MAX_CUSTOM_SECRET_PATTERNS)
    .flatMap((raw) => {
      const normalized = raw.slice(0, MAX_CUSTOM_SECRET_PATTERN_LENGTH);
      const regex = parseCustomRegex(normalized);
      return regex ? [regex] : [];
    });
}

function parseCustomRegex(raw: string): RegExp | undefined {
  const slashForm = raw.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
  if (slashForm) {
    const pattern = slashForm[1];
    const flags = slashForm[2] ?? "";
    if (!pattern) {
      return undefined;
    }
    try {
      return new RegExp(pattern, flags);
    } catch {
      return undefined;
    }
  }

  try {
    return new RegExp(raw);
  } catch {
    return undefined;
  }
}
