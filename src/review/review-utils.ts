import type { DiffFileContext, ReviewIssue } from "./review-types.js";

export function findFileForReview(
  files: DiffFileContext[],
  review: ReviewIssue,
): DiffFileContext | undefined {
  return (
    files.find((file) => file.newPath === review.newPath) ??
    files.find((file) => file.oldPath === review.oldPath) ??
    files.find((file) => file.newPath === review.oldPath)
  );
}
