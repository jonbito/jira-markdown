import { isAbsolute, normalize, resolve, sep } from "node:path";

function normalizeProjectKeySegment(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (!trimmed || !/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
    return undefined;
  }

  return trimmed.toUpperCase();
}

function splitPathSegments(filePath: string): {
  absolute: boolean;
  segments: string[];
} {
  const normalized = normalize(filePath);
  return {
    absolute: normalized.startsWith(sep),
    segments: normalized.split(sep).filter(Boolean)
  };
}

function buildPathFromSegments(segments: string[], absolute: boolean): string {
  return absolute ? `${sep}${segments.join(sep)}` : segments.join(sep);
}

function findSegmentSequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || haystack.length < needle.length) {
    return -1;
  }

  for (let index = haystack.length - needle.length; index >= 0; index -= 1) {
    const matches = needle.every((segment, offset) => haystack[index + offset] === segment);
    if (matches) {
      return index;
    }
  }

  return -1;
}

function resolveConfiguredDirMatch(filePath: string, dir = "issues"): {
  absolute: boolean;
  dirSegments: string[];
  fileSegments: string[];
  startIndex: number;
} | undefined {
  const absoluteFilePath = resolve(filePath);
  const fileParts = splitPathSegments(absoluteFilePath);

  if (isAbsolute(dir)) {
    const dirParts = splitPathSegments(normalize(dir));
    const matches = dirParts.segments.every(
      (segment, index) => fileParts.segments[index] === segment
    );
    if (!matches) {
      return undefined;
    }

    return {
      absolute: true,
      dirSegments: dirParts.segments,
      fileSegments: fileParts.segments,
      startIndex: 0
    };
  }

  const dirParts = splitPathSegments(normalize(dir));
  const startIndex = findSegmentSequence(fileParts.segments, dirParts.segments);
  if (startIndex === -1) {
    return undefined;
  }

  return {
    absolute: fileParts.absolute,
    dirSegments: dirParts.segments,
    fileSegments: fileParts.segments,
    startIndex
  };
}

export function inferProjectKeyFromFilePath(
  filePath: string,
  dir = "issues"
): string | undefined {
  const match = resolveConfiguredDirMatch(filePath, dir);
  if (!match) {
    return undefined;
  }

  const candidate = match.fileSegments[match.startIndex + match.dirSegments.length];
  if (!candidate) {
    return undefined;
  }

  return normalizeProjectKeySegment(candidate);
}

export function inferProjectRootPath(
  filePath: string,
  dir = "issues"
): string | undefined {
  const match = resolveConfiguredDirMatch(filePath, dir);
  const projectSegment = match?.fileSegments[match.startIndex + match.dirSegments.length];
  if (!match || !projectSegment) {
    return undefined;
  }

  return buildPathFromSegments(
    match.fileSegments.slice(0, match.startIndex + match.dirSegments.length + 1),
    match.absolute
  );
}

export function inferWorkspaceRootPath(
  filePath: string,
  dir = "issues"
): string | undefined {
  const match = resolveConfiguredDirMatch(filePath, dir);
  if (!match) {
    return undefined;
  }

  return buildPathFromSegments(
    match.fileSegments.slice(0, match.startIndex),
    match.absolute
  );
}
