export function decodeGitHubFileContent(content: string, encoding: string | undefined): string {
  if ((encoding ?? "").toLowerCase() === "base64") {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  return content;
}
