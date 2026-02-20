export type UiLocale = "zh" | "en";

export function resolveUiLocale(rawLocale: string | undefined = process.env.MR_AGENT_LOCALE): UiLocale {
  const normalized = (rawLocale ?? "").trim().toLowerCase();
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh_cn" ||
    normalized === "zh-hans" ||
    normalized === "chinese"
  ) {
    return "zh";
  }

  if (
    normalized === "en" ||
    normalized === "en-us" ||
    normalized === "en_us" ||
    normalized === "en-gb" ||
    normalized === "english"
  ) {
    return "en";
  }

  return "en";
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
