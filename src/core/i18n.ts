export type UiLocale = "zh" | "en";

export function resolveUiLocale(rawLocale: string | undefined = process.env.MR_AGENT_LOCALE): UiLocale {
  const normalized = (rawLocale ?? "").trim().toLowerCase();
  if (
    normalized === "en" ||
    normalized === "en-us" ||
    normalized === "en_us" ||
    normalized === "en-gb" ||
    normalized === "english"
  ) {
    return "en";
  }

  return "zh";
}

export function localizeText(
  text: {
    zh: string;
    en: string;
  },
  locale: UiLocale = resolveUiLocale(),
): string {
  return locale === "en" ? text.en : text.zh;
}
