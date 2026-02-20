export interface SimilarIssueCandidate {
  id: number | string;
  title: string;
  body?: string | null;
  url: string;
  state?: string | null;
}

export interface SimilarIssueMatch extends SimilarIssueCandidate {
  score: number;
  matchedTerms: string[];
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "when",
  "where",
  "what",
  "why",
  "how",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "fix",
  "feat",
  "chore",
  "refactor",
  "update",
  "issue",
  "pull",
  "request",
  "mr",
  "pr",
]);

export function findSimilarIssues(params: {
  query: string;
  candidates: SimilarIssueCandidate[];
  limit?: number;
}): SimilarIssueMatch[] {
  const normalizedQuery = params.query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = tokenize(normalizedQuery);
  const matches: SimilarIssueMatch[] = [];

  for (const candidate of params.candidates) {
    const scored = scoreCandidate(candidate, normalizedQuery, queryTokens);
    if (scored.score <= 0) {
      continue;
    }
    matches.push(scored);
  }

  const limit = Math.max(1, params.limit ?? 5);
  return matches
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, limit);
}

function scoreCandidate(
  candidate: SimilarIssueCandidate,
  query: string,
  tokens: string[],
): SimilarIssueMatch {
  const title = (candidate.title ?? "").toLowerCase();
  const body = (candidate.body ?? "").toLowerCase();
  const combined = `${title}\n${body}`;
  let score = 0;
  const matchedTerms: string[] = [];

  const normalizedQuery = query.toLowerCase();
  if (normalizedQuery.length >= 4 && title.includes(normalizedQuery)) {
    score += 8;
  } else if (normalizedQuery.length >= 4 && combined.includes(normalizedQuery)) {
    score += 5;
  }

  for (const token of tokens) {
    let tokenScore = 0;
    if (title.includes(token)) {
      tokenScore += 3;
    }
    if (body.includes(token)) {
      tokenScore += 1;
    }
    if (tokenScore > 0) {
      score += tokenScore;
      matchedTerms.push(token);
    }
  }

  if ((candidate.state ?? "").toLowerCase() === "opened") {
    score += 1;
  }
  if ((candidate.state ?? "").toLowerCase() === "open") {
    score += 1;
  }

  return {
    ...candidate,
    score,
    matchedTerms: Array.from(new Set(matchedTerms)).slice(0, 6),
  };
}

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 24);
}
