export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
}

function encodePathSegment(segment: string): string {
  if (!segment) {
    return segment;
  }

  try {
    // Keep already-encoded segments stable while still normalizing unsafe chars.
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}
