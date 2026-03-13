type AdfMark = {
  attrs?: Record<string, unknown>;
  type: string;
};

export type AdfNode = {
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
  type: string;
};

export type AdfDocument = {
  content: AdfNode[];
  type: "doc";
  version: 1;
};

type MarkdownTarget = {
  href: string;
  isImage?: boolean;
  label?: string;
};

export type MarkdownMentionReference = {
  explicitIdentifier: boolean;
  identifier: string;
  label: string;
  raw: string;
};

type MentionTarget = {
  accountId: string;
  displayName?: string;
  userType?: string | undefined;
};

export interface AdfToMarkdownOptions {
  resolveLinkHref?: (href: string) => MarkdownTarget | undefined;
  resolveMention?: (node: {
    attrs?: Record<string, unknown>;
    type: string;
  }) => string | undefined;
  resolveMediaNode?: (node: {
    attrs?: Record<string, unknown>;
    marks?: AdfMark[];
    type: string;
  }) => MarkdownTarget | undefined;
}

export interface MarkdownToAdfOptions {
  resolveImageBlock?: (input: {
    href: string;
    label: string;
  }) => AdfNode | undefined;
  resolveLinkHref?: (input: {
    href: string;
    kind: "image" | "link";
    label: string;
  }) => string | undefined;
  resolveMention?: (reference: MarkdownMentionReference) => MentionTarget | undefined;
}

const headingPattern = /^(#{1,6})\s+(.*)$/;
const taskPattern = /^[-*+]\s+\[( |x|X)\]\s*(.*)$/;
const unorderedPattern = /^[-*+]\s+(.*)$/;
const orderedPattern = /^\d+\.\s+(.*)$/;
const fencedPattern = /^```([\w-]+)?\s*$/;
const markdownMentionPattern = /@\[([^\]]+)\]\(([^)\s]+)\)|@\[([^\]]+)\]/g;
const markdownRulePattern = /^(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/;

type ListKind = "bulletList" | "orderedList" | "taskList";

type ListMatch = {
  checked?: boolean;
  indent: number;
  kind: ListKind;
  text: string;
};

type MarkdownLinkParseResult = {
  end: number;
  href: string;
  image: boolean;
  label: string;
};

type RenderedListItemBlock = {
  kind: "block" | "list";
  nodeType?: string;
  text: string;
};

type EmbeddedTaskMarker = {
  depth: number;
  text: string;
};

function readLeadingIndent(value: string): { characters: number; width: number } {
  let characters = 0;
  let width = 0;

  while (characters < value.length) {
    const character = value[characters] ?? "";

    if (character === " ") {
      width += 1;
      characters += 1;
      continue;
    }

    if (character === "\t") {
      width += 2;
      characters += 1;
      continue;
    }

    break;
  }

  return { characters, width };
}

function countLeadingSpaces(value: string): number {
  return readLeadingIndent(value).width;
}

function stripIndent(value: string, indent: number): string {
  const leadingIndent = readLeadingIndent(value);
  if (leadingIndent.width < indent) {
    return value.trimStart();
  }

  let characters = 0;
  let width = 0;

  while (characters < value.length && width < indent) {
    const character = value[characters] ?? "";

    if (character === " ") {
      width += 1;
      characters += 1;
      continue;
    }

    if (character === "\t") {
      width += 2;
      characters += 1;
      continue;
    }

    break;
  }

  return value.slice(characters);
}

function matchListLine(line: string): ListMatch | undefined {
  const leadingIndent = readLeadingIndent(line);
  const indent = leadingIndent.width;
  const trimmed = line.slice(leadingIndent.characters);

  const taskMatch = taskPattern.exec(trimmed);
  if (taskMatch) {
    return {
      checked: (taskMatch[1] ?? "").toUpperCase() === "X",
      indent,
      kind: "taskList",
      text: taskMatch[2] ?? ""
    };
  }

  const orderedMatch = orderedPattern.exec(trimmed);
  if (orderedMatch) {
    return {
      indent,
      kind: "orderedList",
      text: orderedMatch[1] ?? ""
    };
  }

  const unorderedMatch = unorderedPattern.exec(trimmed);
  if (unorderedMatch) {
    return {
      indent,
      kind: "bulletList",
      text: unorderedMatch[1] ?? ""
    };
  }

  return undefined;
}

function isTopLevelListLine(line: string): boolean {
  return matchListLine(line)?.indent === 0;
}

function isMarkdownRule(line: string): boolean {
  return markdownRulePattern.test(line.trim());
}

function createTextNode(text: string, marks?: AdfMark[]): AdfNode {
  return marks && marks.length > 0
    ? { type: "text", text, marks }
    : { type: "text", text };
}

function createParagraph(text: string, options: MarkdownToAdfOptions = {}): AdfNode {
  const trimmed = text.trim();
  return trimmed
    ? { type: "paragraph", content: parseInline(trimmed, options) }
    : { type: "paragraph", content: [] };
}

function normalizeMentionLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

function formatMentionText(value: string): string {
  const normalized = normalizeMentionLabel(value);
  return normalized ? `@${normalized}` : "@";
}

function looksLikeAccountId(value: string): boolean {
  return value.includes(":") || /^[a-f0-9-]{20,}$/iu.test(value.trim());
}

function formatMarkdownMention(label: string, identifier: string): string {
  return `@[${escapeMarkdownLabel(label)}](${identifier})`;
}

export function extractMarkdownMentions(markdown: string): MarkdownMentionReference[] {
  const matches: MarkdownMentionReference[] = [];

  for (const match of markdown.matchAll(markdownMentionPattern)) {
    if (match[1] && match[2]) {
      matches.push({
        explicitIdentifier: true,
        identifier: match[2].trim(),
        label: normalizeMentionLabel(match[1]),
        raw: match[0]
      });
      continue;
    }

    if (match[3]) {
      const label = normalizeMentionLabel(match[3]);
      matches.push({
        explicitIdentifier: false,
        identifier: label,
        label,
        raw: match[0]
      });
    }
  }

  return matches;
}

function createMentionNode(reference: MarkdownMentionReference, options: MarkdownToAdfOptions): AdfNode {
  const resolved = options.resolveMention?.(reference);

  if (resolved) {
    return {
      type: "mention",
      attrs: {
        id: resolved.accountId,
        text: formatMentionText(resolved.displayName ?? reference.label),
        ...(resolved.userType ? { userType: resolved.userType } : {})
      }
    };
  }

  if (reference.explicitIdentifier && looksLikeAccountId(reference.identifier)) {
    return {
      type: "mention",
      attrs: {
        id: reference.identifier,
        text: formatMentionText(reference.label)
      }
    };
  }

  return createTextNode(formatMentionText(reference.label));
}

function splitMarkdownTableRow(line: string): string[] {
  let working = line.trim();
  if (working.startsWith("|")) {
    working = working.slice(1);
  }
  if (working.endsWith("|")) {
    working = working.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of working) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (escaped) {
    current += "\\";
  }

  cells.push(current.trim());
  return cells;
}

function isMarkdownTableDelimiter(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableStart(lines: string[], startIndex: number): boolean {
  const headerLine = lines[startIndex] ?? "";
  const delimiterLine = lines[startIndex + 1] ?? "";

  if (!headerLine.includes("|") || !delimiterLine) {
    return false;
  }

  const headerCells = splitMarkdownTableRow(headerLine);
  const delimiterCells = splitMarkdownTableRow(delimiterLine);
  return (
    headerCells.length > 0 &&
    delimiterCells.length === headerCells.length &&
    isMarkdownTableDelimiter(delimiterLine)
  );
}

function normalizeTableCells(cells: string[], columnCount: number): string[] {
  if (cells.length === columnCount) {
    return cells;
  }

  if (cells.length > columnCount) {
    return cells.slice(0, columnCount);
  }

  return [...cells, ...Array.from({ length: columnCount - cells.length }, () => "")];
}

function createTableCellNode(
  type: "tableCell" | "tableHeader",
  value: string,
  options: MarkdownToAdfOptions = {}
): AdfNode {
  return {
    type,
    attrs: {},
    content: [createParagraph(value, options)]
  };
}

function inferLinkLabel(href: string): string {
  const normalized = href.split("?")[0]?.split("#")[0] ?? href;
  const segment = normalized.split("/").pop() ?? normalized;
  return segment || href;
}

function createMarkdownImageBlock(
  label: string,
  href: string,
  options: MarkdownToAdfOptions = {}
): AdfNode {
  const resolvedBlock = options.resolveImageBlock?.({ href, label });
  if (resolvedBlock) {
    return resolvedBlock;
  }

  const resolvedHref =
    options.resolveLinkHref?.({
      href,
      kind: "image",
      label
    }) ?? href;

  return {
    type: "paragraph",
    content: [
      createTextNode(label, [
        {
          type: "link",
          attrs: {
            href: resolvedHref
          }
        }
      ])
    ]
  };
}

function readBracketedValue(
  input: string,
  startIndex: number,
  openCharacter: string,
  closeCharacter: string
): { end: number; value: string } | undefined {
  if (input[startIndex] !== openCharacter) {
    return undefined;
  }

  let cursor = startIndex + 1;
  let depth = 0;
  let value = "";

  while (cursor < input.length) {
    const character = input[cursor] ?? "";

    if (character === "\\") {
      const escaped = input[cursor + 1];
      if (escaped !== undefined) {
        value += escaped;
        cursor += 2;
        continue;
      }

      value += character;
      cursor += 1;
      continue;
    }

    if (character === openCharacter) {
      depth += 1;
      value += character;
      cursor += 1;
      continue;
    }

    if (character === closeCharacter) {
      if (depth === 0) {
        return {
          end: cursor + 1,
          value
        };
      }

      depth -= 1;
      value += character;
      cursor += 1;
      continue;
    }

    value += character;
    cursor += 1;
  }

  return undefined;
}

function parseMentionAt(
  input: string,
  startIndex: number
): { end: number; reference: MarkdownMentionReference } | undefined {
  if (!input.startsWith("@[", startIndex)) {
    return undefined;
  }

  const labelResult = readBracketedValue(input, startIndex + 1, "[", "]");
  if (!labelResult) {
    return undefined;
  }

  const label = normalizeMentionLabel(labelResult.value);
  const identifierStart = labelResult.end;
  if (input[identifierStart] === "(") {
    const identifierEnd = input.indexOf(")", identifierStart + 1);
    if (identifierEnd !== -1) {
      const identifier = input.slice(identifierStart + 1, identifierEnd).trim();
      if (identifier && !/\s/u.test(identifier)) {
        return {
          end: identifierEnd + 1,
          reference: {
            explicitIdentifier: true,
            identifier,
            label,
            raw: input.slice(startIndex, identifierEnd + 1)
          }
        };
      }
    }
  }

  return {
    end: labelResult.end,
    reference: {
      explicitIdentifier: false,
      identifier: label,
      label,
      raw: input.slice(startIndex, labelResult.end)
    }
  };
}

function parseMarkdownDestination(
  input: string,
  startIndex: number
): { end: number; href: string } | undefined {
  if (input[startIndex] !== "(") {
    return undefined;
  }

  let cursor = startIndex + 1;

  if (input[cursor] === "<") {
    cursor += 1;
    let href = "";

    while (cursor < input.length) {
      const character = input[cursor] ?? "";

      if (character === "\\") {
        const escaped = input[cursor + 1];
        if (escaped !== undefined) {
          href += escaped;
          cursor += 2;
          continue;
        }
      }

      if (character === ">") {
        cursor += 1;
        while (cursor < input.length && /\s/u.test(input[cursor] ?? "")) {
          cursor += 1;
        }

        if (!href || input[cursor] !== ")") {
          return undefined;
        }

        return {
          end: cursor + 1,
          href
        };
      }

      href += character;
      cursor += 1;
    }

    return undefined;
  }

  let href = "";
  let depth = 0;

  while (cursor < input.length) {
    const character = input[cursor] ?? "";

    if (character === "\\") {
      const escaped = input[cursor + 1];
      if (escaped !== undefined) {
        href += escaped;
        cursor += 2;
        continue;
      }
    }

    if (character === "(") {
      depth += 1;
      href += character;
      cursor += 1;
      continue;
    }

    if (character === ")") {
      if (depth === 0) {
        return href && !/\s/u.test(href)
          ? {
              end: cursor + 1,
              href
            }
          : undefined;
      }

      depth -= 1;
      href += character;
      cursor += 1;
      continue;
    }

    if (/\s/u.test(character)) {
      return undefined;
    }

    href += character;
    cursor += 1;
  }

  return undefined;
}

function parseMarkdownLinkAt(
  input: string,
  startIndex: number
): MarkdownLinkParseResult | undefined {
  const image = input.startsWith("![", startIndex);
  const labelStart = image ? startIndex + 1 : startIndex;

  if (!image && input[startIndex] !== "[") {
    return undefined;
  }

  const labelResult = readBracketedValue(input, labelStart, "[", "]");
  if (!labelResult) {
    return undefined;
  }

  const destinationResult = parseMarkdownDestination(input, labelResult.end);
  if (!destinationResult) {
    return undefined;
  }

  return {
    end: destinationResult.end,
    href: destinationResult.href,
    image,
    label: labelResult.value
  };
}

function parseMarkdownCodeSpanAt(
  input: string,
  startIndex: number
): { end: number } | undefined {
  if (input[startIndex] !== "`") {
    return undefined;
  }

  let fenceLength = 0;
  while (input[startIndex + fenceLength] === "`") {
    fenceLength += 1;
  }

  const closingFence = "`".repeat(fenceLength);
  const closingIndex = input.indexOf(closingFence, startIndex + fenceLength);
  if (closingIndex === -1) {
    return undefined;
  }

  return {
    end: closingIndex + fenceLength
  };
}

function parseMarkdownFencedCodeBlockAt(
  input: string,
  startIndex: number
): { end: number } | undefined {
  const fenceCharacter = input[startIndex];
  if (fenceCharacter !== "`" && fenceCharacter !== "~") {
    return undefined;
  }

  const lineStart = input.lastIndexOf("\n", startIndex - 1) + 1;
  if (!/^[\t ]*$/u.test(input.slice(lineStart, startIndex))) {
    return undefined;
  }

  let fenceLength = 0;
  while (input[startIndex + fenceLength] === fenceCharacter) {
    fenceLength += 1;
  }
  if (fenceLength < 3) {
    return undefined;
  }

  const openingLineEnd = input.indexOf("\n", startIndex + fenceLength);
  if (openingLineEnd === -1) {
    return { end: input.length };
  }

  let cursor = openingLineEnd + 1;
  while (cursor < input.length) {
    const lineEnd = input.indexOf("\n", cursor);
    const segmentEnd = lineEnd === -1 ? input.length : lineEnd;
    let closingFenceStart = cursor;
    while (
      closingFenceStart < segmentEnd &&
      (input[closingFenceStart] === " " || input[closingFenceStart] === "\t")
    ) {
      closingFenceStart += 1;
    }

    let closingFenceLength = 0;
    while (input[closingFenceStart + closingFenceLength] === fenceCharacter) {
      closingFenceLength += 1;
    }

    if (
      closingFenceLength >= fenceLength &&
      /^[\t ]*$/u.test(input.slice(closingFenceStart + closingFenceLength, segmentEnd))
    ) {
      return {
        end: lineEnd === -1 ? input.length : lineEnd + 1
      };
    }

    if (lineEnd === -1) {
      return { end: input.length };
    }
    cursor = lineEnd + 1;
  }

  return { end: input.length };
}

export function rewriteMarkdownLinkHrefs(
  input: string,
  rewriteHref: (input: {
    href: string;
    kind: "image" | "link";
    label: string;
  }) => string | undefined
): string {
  let cursor = 0;
  let rewritten = "";

  while (cursor < input.length) {
    const fencedCodeBlock = parseMarkdownFencedCodeBlockAt(input, cursor);
    if (fencedCodeBlock) {
      rewritten += input.slice(cursor, fencedCodeBlock.end);
      cursor = fencedCodeBlock.end;
      continue;
    }

    const codeSpan = parseMarkdownCodeSpanAt(input, cursor);
    if (codeSpan) {
      rewritten += input.slice(cursor, codeSpan.end);
      cursor = codeSpan.end;
      continue;
    }

    const parsed = parseMarkdownLinkAt(input, cursor);
    if (!parsed) {
      rewritten += input[cursor] ?? "";
      cursor += 1;
      continue;
    }

    const nextHref = rewriteHref({
      href: parsed.href,
      kind: parsed.image ? "image" : "link",
      label: parsed.label
    });
    if (!nextHref || nextHref === parsed.href) {
      rewritten += input.slice(cursor, parsed.end);
      cursor = parsed.end;
      continue;
    }

    rewritten += parsed.image
      ? formatMarkdownImage(parsed.label, nextHref)
      : formatMarkdownTextLink(parsed.label, nextHref);
    cursor = parsed.end;
  }

  return rewritten;
}

function parseAutolinkAt(
  input: string,
  startIndex: number
): { end: number; href: string } | undefined {
  if (input[startIndex] !== "<") {
    return undefined;
  }

  const end = input.indexOf(">", startIndex + 1);
  if (end === -1) {
    return undefined;
  }

  const href = input.slice(startIndex + 1, end).trim();
  return /^https?:\/\/\S+$/iu.test(href)
    ? {
        end: end + 1,
        href
      }
    : undefined;
}

function isJiraIssueBrowseUrl(href: string): boolean {
  try {
    const url = new URL(href);
    const pathSegments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    return (
      pathSegments.length === 2 &&
      pathSegments[0]?.toLowerCase() === "browse" &&
      /^[A-Z][A-Z0-9_]*-\d+$/iu.test(pathSegments[1] ?? "")
    );
  } catch {
    return false;
  }
}

function parseDelimitedTextAt(
  input: string,
  startIndex: number,
  delimiter: string
): { end: number; text: string } | undefined {
  if (!input.startsWith(delimiter, startIndex)) {
    return undefined;
  }

  const end = input.indexOf(delimiter, startIndex + delimiter.length);
  if (end === -1 || end === startIndex + delimiter.length) {
    return undefined;
  }

  return {
    end: end + delimiter.length,
    text: input.slice(startIndex + delimiter.length, end)
  };
}

function parseStandaloneImage(
  input: string
): { href: string; label: string } | undefined {
  const parsed = parseMarkdownLinkAt(input.trim(), 0);
  if (!parsed || !parsed.image || parsed.end !== input.trim().length) {
    return undefined;
  }

  return {
    href: parsed.href,
    label: parsed.label.trim() || inferLinkLabel(parsed.href)
  };
}

function parseInline(input: string, options: MarkdownToAdfOptions = {}): AdfNode[] {
  const nodes: AdfNode[] = [];
  let cursor = 0;
  let plainStart = 0;

  while (cursor < input.length) {
    const mention = parseMentionAt(input, cursor);
    if (mention) {
      if (cursor > plainStart) {
        nodes.push(createTextNode(input.slice(plainStart, cursor)));
      }
      nodes.push(createMentionNode(mention.reference, options));
      cursor = mention.end;
      plainStart = cursor;
      continue;
    }

    const markdownLink = parseMarkdownLinkAt(input, cursor);
    if (markdownLink) {
      if (cursor > plainStart) {
        nodes.push(createTextNode(input.slice(plainStart, cursor)));
      }

      const label = markdownLink.label.trim() || inferLinkLabel(markdownLink.href);
      const href =
        options.resolveLinkHref?.({
          href: markdownLink.href,
          kind: markdownLink.image ? "image" : "link",
          label
        }) ?? markdownLink.href;

      nodes.push(
        createTextNode(label, [
          { type: "link", attrs: { href } }
        ])
      );

      cursor = markdownLink.end;
      plainStart = cursor;
      continue;
    }

    const autolink = parseAutolinkAt(input, cursor);
    if (autolink) {
      if (cursor > plainStart) {
        nodes.push(createTextNode(input.slice(plainStart, cursor)));
      }
      if (isJiraIssueBrowseUrl(autolink.href)) {
        nodes.push({
          type: "inlineCard",
          attrs: {
            url: autolink.href
          }
        });
      } else {
        nodes.push(
          createTextNode(autolink.href, [
            { type: "link", attrs: { href: autolink.href } }
          ])
        );
      }
      cursor = autolink.end;
      plainStart = cursor;
      continue;
    }

    const code = parseDelimitedTextAt(input, cursor, "`");
    if (code) {
      if (cursor > plainStart) {
        nodes.push(createTextNode(input.slice(plainStart, cursor)));
      }
      nodes.push(createTextNode(code.text, [{ type: "code" }]));
      cursor = code.end;
      plainStart = cursor;
      continue;
    }

    const strong = parseDelimitedTextAt(input, cursor, "**");
    if (strong) {
      if (cursor > plainStart) {
        nodes.push(createTextNode(input.slice(plainStart, cursor)));
      }
      nodes.push(createTextNode(strong.text, [{ type: "strong" }]));
      cursor = strong.end;
      plainStart = cursor;
      continue;
    }

    const emphasis = parseDelimitedTextAt(input, cursor, "*");
    if (emphasis) {
      if (cursor > plainStart) {
        nodes.push(createTextNode(input.slice(plainStart, cursor)));
      }
      nodes.push(createTextNode(emphasis.text, [{ type: "em" }]));
      cursor = emphasis.end;
      plainStart = cursor;
      continue;
    }

    cursor += 1;
  }

  if (plainStart < input.length) {
    nodes.push(createTextNode(input.slice(plainStart)));
  }

  if (nodes.length === 1 && nodes[0]?.type === "inlineCard") {
    return [nodes[0], createTextNode(" ")];
  }

  return nodes.length > 0 ? nodes : [createTextNode(input)];
}

function collectUntilBlank(
  lines: string[],
  startIndex: number,
  stopWhen?: (line: string, index: number) => boolean
): [string[], number] {
  const block: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const current = lines[index] ?? "";
    if (current.trim() === "") {
      break;
    }

    if (stopWhen && stopWhen(current, index)) {
      break;
    }

    block.push(current);
    index += 1;
  }

  return [block, index];
}

function findNextNonBlankLine(lines: string[], startIndex: number): number {
  let index = startIndex;

  while (index < lines.length) {
    if ((lines[index] ?? "").trim() !== "") {
      return index;
    }
    index += 1;
  }

  return -1;
}

function collectListItemContinuationText(input: {
  initialText: string;
  lines: string[];
  listIndent: number;
  startIndex: number;
}): { nextIndex: number; paragraphText?: string | undefined } {
  const parts = input.initialText.trim() ? [input.initialText.trim()] : [];
  let index = input.startIndex;

  while (index < input.lines.length) {
    const line = input.lines[index] ?? "";

    if (line.trim() === "") {
      break;
    }

    const indent = countLeadingSpaces(line);
    if (indent <= input.listIndent || matchListLine(line) || isMarkdownRule(line)) {
      break;
    }

    parts.push(stripIndent(line, input.listIndent + 2).trim());
    index += 1;
  }

  return {
    nextIndex: index,
    ...(parts.length > 0 ? { paragraphText: parts.join(" ") } : {})
  };
}

function parseIndentedParagraph(
  lines: string[],
  startIndex: number,
  listIndent: number,
  options: MarkdownToAdfOptions = {}
): [AdfNode | undefined, number] {
  const parts: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      break;
    }

    const indent = countLeadingSpaces(line);
    if (indent <= listIndent || (parts.length > 0 && matchListLine(line)) || isMarkdownRule(line)) {
      break;
    }

    parts.push(stripIndent(line, listIndent + 2).trim());
    index += 1;
  }

  return [
    parts.length > 0 ? createParagraph(parts.join(" "), options) : undefined,
    index
  ];
}

function parseRegularListItemChildren(
  lines: string[],
  startIndex: number,
  listIndent: number,
  options: MarkdownToAdfOptions = {}
): [AdfNode[], number] {
  const blocks: AdfNode[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const indent = countLeadingSpaces(line);
    if (indent <= listIndent) {
      break;
    }

    if (matchListLine(line)) {
      const [listNode, nextIndex] = parseList(lines, index, options);
      blocks.push(listNode);
      index = nextIndex;
      continue;
    }

    if (isMarkdownRule(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const [paragraph, nextIndex] = parseIndentedParagraph(lines, index, listIndent, options);
    if (!paragraph || nextIndex === index) {
      break;
    }

    blocks.push(paragraph);
    index = nextIndex;
  }

  return [blocks, index];
}

function parseTaskListItemChildren(
  lines: string[],
  startIndex: number,
  listIndent: number,
  options: MarkdownToAdfOptions = {}
): [AdfNode[], number] {
  const blocks: AdfNode[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      const nextNonBlank = findNextNonBlankLine(lines, index + 1);
      if (nextNonBlank === -1) {
        break;
      }

      const nextMatch = matchListLine(lines[nextNonBlank] ?? "");
      if (nextMatch && nextMatch.indent > listIndent && nextMatch.kind === "taskList") {
        index = nextNonBlank;
        continue;
      }

      break;
    }

    const match = matchListLine(line);
    if (!match || match.indent <= listIndent || match.kind !== "taskList") {
      break;
    }

    const [listNode, nextIndex] = parseList(lines, index, options);
    blocks.push(listNode);
    index = nextIndex;
  }

  return [blocks, index];
}

function parseList(
  lines: string[],
  startIndex: number,
  options: MarkdownToAdfOptions = {}
): [AdfNode, number] {
  const firstLine = lines[startIndex] ?? "";
  const firstMatch = matchListLine(firstLine);
  if (!firstMatch) {
    return [{ type: "bulletList", content: [] }, startIndex];
  }

  const listIndent = firstMatch.indent;
  const listKind = firstMatch.kind;
  const items: AdfNode[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      const nextNonBlank = findNextNonBlankLine(lines, index + 1);
      if (nextNonBlank === -1) {
        break;
      }

      const nextMatch = matchListLine(lines[nextNonBlank] ?? "");
      if (nextMatch?.indent === listIndent && nextMatch.kind === listKind) {
        index = nextNonBlank;
        continue;
      }

      break;
    }

    const match = matchListLine(line);
    if (!match || match.indent !== listIndent || match.kind !== listKind) {
      break;
    }

    index += 1;

    if (listKind === "taskList") {
      items.push({
        type: "taskItem",
        attrs: {
          // Jira expects task items to carry their own localId.
          localId: crypto.randomUUID(),
          state: match.checked ? "DONE" : "TODO"
        },
        content: parseInline(match.text, options)
      });

      const [nestedItems, nextIndex] = parseTaskListItemChildren(
        lines,
        index,
        listIndent,
        options
      );
      items.push(...nestedItems);
      index = nextIndex;
      continue;
    }

    const itemContent: AdfNode[] = [];
    const continuation = collectListItemContinuationText({
      initialText: match.text,
      lines,
      listIndent,
      startIndex: index
    });
    if (continuation.paragraphText !== undefined) {
      itemContent.push(createParagraph(continuation.paragraphText, options));
    }

    const [childBlocks, nextIndex] = parseRegularListItemChildren(
      lines,
      continuation.nextIndex,
      listIndent,
      options
    );
    itemContent.push(...childBlocks);

    items.push({
      type: "listItem",
      content: itemContent.length > 0 ? itemContent : [createParagraph("", options)]
    });
    index = nextIndex;
  }

  return [
    {
      ...(listKind === "taskList"
        ? {
            attrs: {
              // Jira task lists also carry a list-level localId.
              localId: crypto.randomUUID()
            }
          }
        : {}),
      type: listKind,
      content: items
    },
    index
  ];
}

function parseTable(
  lines: string[],
  startIndex: number,
  options: MarkdownToAdfOptions = {}
): [AdfNode, number] {
  const headerCells = splitMarkdownTableRow(lines[startIndex] ?? "");
  const columnCount = headerCells.length;
  const rows: AdfNode[] = [
    {
      type: "tableRow",
      content: normalizeTableCells(headerCells, columnCount).map((cell) =>
        createTableCellNode("tableHeader", cell, options)
      )
    }
  ];

  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || !line.includes("|")) {
      break;
    }

    const cells = splitMarkdownTableRow(line);
    if (cells.length === 0) {
      break;
    }

    rows.push({
      type: "tableRow",
      content: normalizeTableCells(cells, columnCount).map((cell) =>
        createTableCellNode("tableCell", cell, options)
      )
    });
    index += 1;
  }

  return [
    {
      type: "table",
      attrs: {
        isNumberColumnEnabled: false
      },
      content: rows
    },
    index
  ];
}

function parseBlockquote(
  lines: string[],
  startIndex: number,
  options: MarkdownToAdfOptions = {}
): [AdfNode, number] {
  const paragraphs: AdfNode[] = [];
  let index = startIndex;
  const quoteLines: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith(">")) {
      break;
    }
    quoteLines.push(line.replace(/^>\s?/, ""));
    index += 1;
  }

  const chunks = quoteLines.join("\n").split(/\n\s*\n/);
  for (const chunk of chunks) {
    paragraphs.push(createParagraph(chunk.replace(/\n+/g, " ").trim(), options));
  }

  return [{ type: "blockquote", content: paragraphs }, index];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\[\]])/g, "\\$1");
}

function needsAngleBracketDestination(value: string): boolean {
  return /\s/u.test(value);
}

function canUseMarkdownAutolink(value: string): boolean {
  return /^https?:\/\/\S+$/iu.test(value);
}

function formatMarkdownDestination(value: string): string {
  return needsAngleBracketDestination(value) ? `<${value}>` : value;
}

function formatMarkdownTextLink(label: string, href: string): string {
  if (label === href && canUseMarkdownAutolink(href)) {
    return `<${href}>`;
  }

  return `[${escapeMarkdownLabel(label)}](${formatMarkdownDestination(href)})`;
}

function formatMarkdownImage(label: string, href: string): string {
  return `![${escapeMarkdownLabel(label)}](${formatMarkdownDestination(href)})`;
}

function findLinkMarkHref(marks: AdfMark[] | undefined): string | undefined {
  const linkMark = (marks ?? []).find((mark) => mark.type === "link");
  return asString(linkMark?.attrs?.href);
}

function fallbackMediaLabel(node: AdfNode): string {
  return (
    asString(node.attrs?.alt) ??
    asString(node.attrs?.text) ??
    asString(node.attrs?.title) ??
    "Attachment"
  );
}

function renderInlineNodes(
  nodes: AdfNode[] | undefined,
  options: AdfToMarkdownOptions = {}
): string {
  return (nodes ?? []).map((node) => renderInlineNode(node, options)).join("");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function applyMarks(
  text: string,
  marks: AdfMark[] | undefined,
  options: AdfToMarkdownOptions = {}
): string {
  return (marks ?? []).reduce((current, mark) => {
    switch (mark.type) {
      case "code":
        return `\`${current}\``;
      case "em":
        return `*${current}*`;
      case "link": {
        const href = asString(mark.attrs?.href);
        const resolved = href ? options.resolveLinkHref?.(href) : undefined;
        return href ? formatMarkdownTextLink(current, resolved?.href ?? href) : current;
      }
      case "strong":
        return `**${current}**`;
      default:
        return current;
    }
  }, text);
}

function renderInlineNode(node: AdfNode, options: AdfToMarkdownOptions = {}): string {
  if (node.type === "hardBreak") {
    return "\n";
  }

  if (node.type === "text") {
    return applyMarks(node.text ?? "", node.marks, options);
  }

  if (node.type === "emoji") {
    return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
  }

  if (node.type === "mention") {
    const resolvedMention = options.resolveMention?.(node);
    if (resolvedMention) {
      return resolvedMention;
    }

    const identifier = asString(node.attrs?.id);
    const label = normalizeMentionLabel(String(node.attrs?.text ?? identifier ?? ""));
    return identifier ? formatMarkdownMention(label || identifier, identifier) : formatMentionText(label);
  }

  if (node.type === "inlineCard") {
    const href = asString(node.attrs?.url);
    if (!href) {
      return renderInlineNodes(node.content, options);
    }

    const resolved = options.resolveLinkHref?.(href);
    return formatMarkdownTextLink(
      resolved?.label ?? href,
      resolved?.href ?? href
    );
  }

  if (node.type === "media") {
    const resolved = resolveMediaTarget(node, options);
    const label = resolved?.label ?? fallbackMediaLabel(node);

    if (resolved?.href) {
      return resolved.isImage
        ? formatMarkdownImage(label, resolved.href)
        : formatMarkdownTextLink(label, resolved.href);
    }

    return `[Attachment: ${label}]`;
  }

  return renderInlineNodes(node.content, options);
}

function resolveMediaTarget(
  node: AdfNode,
  options: AdfToMarkdownOptions = {}
): MarkdownTarget | undefined {
  return (
    options.resolveMediaNode?.(node) ??
    (asString(node.attrs?.url)
      ? {
          href: asString(node.attrs?.url) as string,
          isImage: true,
          label: fallbackMediaLabel(node)
        }
      : undefined) ??
    (findLinkMarkHref(node.marks)
      ? options.resolveLinkHref?.(findLinkMarkHref(node.marks) as string)
      : undefined)
  );
}

export function collectMediaBlocks(
  value: unknown,
  options: AdfToMarkdownOptions = {}
): Array<{ block: AdfNode; href: string; isImage?: boolean; label?: string }> {
  if (!value || typeof value !== "object") {
    return [];
  }

  const document = value as Partial<AdfDocument>;
  if (document.type !== "doc") {
    return [];
  }

  const blocks: Array<{ block: AdfNode; href: string; isImage?: boolean; label?: string }> = [];

  for (const node of document.content ?? []) {
    if (node?.type !== "mediaSingle") {
      continue;
    }

    const mediaNode = node.content?.find((child) => child.type === "media");
    if (!mediaNode) {
      continue;
    }

    const resolved = resolveMediaTarget(mediaNode, options);
    if (!resolved?.href) {
      continue;
    }

    blocks.push({
      block: node,
      href: resolved.href,
      ...(resolved.isImage ? { isImage: true } : {}),
      ...(resolved.label ? { label: resolved.label } : {})
    });
  }

  return blocks;
}

function renderBlockNode(
  node: AdfNode,
  indentPrefix = "",
  options: AdfToMarkdownOptions = {}
): string {
  switch (node.type) {
    case "blockquote": {
      const body = renderBlockNodes(node.content, indentPrefix, options).split("\n");
      return body.map((line) => (line ? `> ${line}` : ">")).join("\n");
    }
    case "bulletList":
      return (node.content ?? [])
        .map((item) => renderListEntry(item, indentPrefix, "- ", options))
        .join("\n");
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `\`\`\`${language}\n${renderInlineNodes(node.content, options)}\n\`\`\``;
    }
    case "heading": {
      const level = Number(node.attrs?.level) || 1;
      return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${renderInlineNodes(node.content, options).trim()}`;
    }
    case "orderedList":
      return (node.content ?? [])
        .map(
          (item, index) => renderListEntry(item, indentPrefix, `${index + 1}. `, options)
        )
        .join("\n");
    case "table":
      return renderTable(node, options);
    case "taskItem":
      return renderTaskItem(node, indentPrefix, options);
    case "taskList":
      return renderTaskList(node, indentPrefix, options);
    case "mediaGroup":
    case "mediaSingle":
      return (node.content ?? [])
        .map((child) => renderInlineNode(child, options).trim())
        .filter(Boolean)
        .join("\n\n");
    case "panel":
      return renderBlockNodes(node.content, indentPrefix, options);
    case "paragraph":
      return renderInlineNodes(node.content, options).trim();
    case "rule":
      return "---";
    default:
      return renderBlockNodes(node.content, indentPrefix, options);
  }
}

function renderListItemBlock(
  node: AdfNode,
  options: AdfToMarkdownOptions = {}
): RenderedListItemBlock | undefined {
  if (node.type === "paragraph") {
    const text = renderInlineNodes(node.content, options).trim();
    return text ? { kind: "block", text } : undefined;
  }

  if (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList") {
    const text = renderBlockNode(node, "", options).trim();
    return text ? { kind: "list", nodeType: node.type, text } : undefined;
  }

  if (
    node.type === "text" ||
    node.type === "emoji" ||
    node.type === "mention" ||
    node.type === "inlineCard" ||
    node.type === "media"
  ) {
    const text = renderInlineNode(node, options).trim();
    return text ? { kind: "block", text } : undefined;
  }

  const text = renderBlockNode(node, "", options).trim();
  return text ? { kind: "block", text } : undefined;
}

function collectRenderedListItemBlocks(
  node: AdfNode,
  options: AdfToMarkdownOptions = {}
): RenderedListItemBlock[] {
  return (node.content ?? [])
    .map((child) => renderListItemBlock(child, options))
    .filter((block): block is RenderedListItemBlock => Boolean(block));
}

function extractEmbeddedTaskMarker(text: string): EmbeddedTaskMarker | undefined {
  let remaining = text.trimStart();
  let depth = 0;

  while (true) {
    const match = taskPattern.exec(remaining);
    if (!match) {
      break;
    }

    depth += 1;
    remaining = (match[2] ?? "").trimStart();
  }

  return depth > 0 && remaining
    ? {
        depth,
        text: remaining
      }
    : undefined;
}

function renderListEntryFromBlocks(
  blocks: RenderedListItemBlock[],
  indentPrefix: string,
  marker: string,
  resolveChildIndent: (block: RenderedListItemBlock, baseIndent: string) => string
): string {
  if (blocks.length === 0) {
    return `${indentPrefix}${marker}`.trimEnd();
  }

  const baseChildIndent = `${indentPrefix}  `;
  const lines: string[] = [];
  const firstBlock = blocks[0] as RenderedListItemBlock;
  const restBlocks = blocks.slice(1);
  const firstLines = firstBlock.text.split("\n");

  lines.push(`${indentPrefix}${marker}${firstLines[0] ?? ""}`);
  lines.push(
    ...indentRenderedLines(
      firstLines.slice(1).join("\n"),
      resolveChildIndent(firstBlock, baseChildIndent)
    ).filter(Boolean)
  );

  for (const block of restBlocks) {
    if (block.kind !== "list") {
      lines.push("");
    }

    lines.push(
      ...indentRenderedLines(block.text, resolveChildIndent(block, baseChildIndent))
    );
  }

  return lines.join("\n");
}

function indentRenderedLines(value: string, indent: string): string[] {
  if (!value) {
    return [];
  }

  return value.split("\n").map((line) => `${indent}${line}`);
}

function renderListEntry(
  node: AdfNode,
  indentPrefix: string,
  marker: string,
  options: AdfToMarkdownOptions = {},
  resolveChildIndent: (block: RenderedListItemBlock, baseIndent: string) => string = (
    _block,
    baseIndent
  ) => baseIndent
): string {
  return renderListEntryFromBlocks(
    collectRenderedListItemBlocks(node, options),
    indentPrefix,
    marker,
    resolveChildIndent
  );
}

function renderTaskList(
  node: AdfNode,
  indentPrefix: string,
  options: AdfToMarkdownOptions = {}
): string {
  const renderedEntries: string[] = [];
  const content = node.content ?? [];
  let index = 0;

  while (index < content.length) {
    const current = content[index];

    if (!current) {
      index += 1;
      continue;
    }

    if (current.type === "taskItem" || current.type === "blockTaskItem") {
      const nestedBlocks: RenderedListItemBlock[] = [];
      let nestedIndex = index + 1;

      while ((content[nestedIndex] ?? {}).type === "taskList") {
        const nestedTaskList = content[nestedIndex] as AdfNode;
        const text = renderTaskList(nestedTaskList, "", options).trim();
        if (text) {
          nestedBlocks.push({
            kind: "list",
            nodeType: "taskList",
            text
          });
        }
        nestedIndex += 1;
      }

      renderedEntries.push(renderTaskItem(current, indentPrefix, options, nestedBlocks));
      index = nestedIndex;
      continue;
    }

    if (current.type === "taskList") {
      const text = renderTaskList(current, indentPrefix, options).trim();
      if (text) {
        renderedEntries.push(text);
      }
      index += 1;
      continue;
    }

    const text = renderBlockNode(current, indentPrefix, options).trim();
    if (text) {
      renderedEntries.push(text);
    }
    index += 1;
  }

  return renderedEntries.join("\n");
}

function renderTaskItem(
  node: AdfNode,
  indentPrefix: string,
  options: AdfToMarkdownOptions = {},
  extraBlocks: RenderedListItemBlock[] = []
): string {
  const marker = String(node.attrs?.state ?? "").toUpperCase() === "DONE" ? "x" : " ";
  const blocks = [...collectRenderedListItemBlocks(node, options), ...extraBlocks];
  const embeddedTaskMarker =
    blocks[0]?.kind === "block" ? extractEmbeddedTaskMarker(blocks[0].text) : undefined;
  const normalizedBlocks =
    embeddedTaskMarker && blocks[0]
      ? [
          { ...blocks[0], text: embeddedTaskMarker.text },
          ...blocks.slice(1)
        ]
      : blocks;
  const normalizedIndentPrefix = embeddedTaskMarker
    ? `${indentPrefix}${"\t".repeat(embeddedTaskMarker.depth)}`
    : indentPrefix;

  return renderListEntryFromBlocks(
    normalizedBlocks,
    normalizedIndentPrefix,
    `- [${marker}] `,
    (block, baseIndent) =>
      block.kind === "list" && block.nodeType === "taskList"
        ? `${normalizedIndentPrefix}\t`
        : baseIndent
  );
}

function renderTableCell(node: AdfNode, options: AdfToMarkdownOptions = {}): string {
  const blocks = (node.content ?? [])
    .map((child) => {
      if (child.type === "paragraph") {
        return renderInlineNodes(child.content, options).trim();
      }

      return renderBlockNode(child, "", options).replace(/\n+/g, "<br>").trim();
    })
    .filter(Boolean);

  return escapeTableCell(blocks.join("<br>"));
}

function formatMarkdownTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function renderTable(node: AdfNode, options: AdfToMarkdownOptions = {}): string {
  const rows = (node.content ?? []).filter((child) => child.type === "tableRow");
  if (rows.length === 0) {
    return "";
  }

  const renderedRows = rows.map((row) =>
    (row.content ?? []).map((cell) => renderTableCell(cell, options))
  );
  const columnCount = Math.max(...renderedRows.map((row) => row.length), 1);
  const normalizedRows = renderedRows.map((row) => normalizeTableCells(row, columnCount));
  const headerRow = normalizedRows[0] ?? Array.from({ length: columnCount }, () => "");
  const bodyRows = normalizedRows.slice(1);
  const delimiterRow = Array.from({ length: columnCount }, () => "---");

  return [
    formatMarkdownTableRow(headerRow),
    formatMarkdownTableRow(delimiterRow),
    ...bodyRows.map((row) => formatMarkdownTableRow(row))
  ].join("\n");
}

function renderBlockNodes(
  nodes: AdfNode[] | undefined,
  indentPrefix = "",
  options: AdfToMarkdownOptions = {}
): string {
  return (nodes ?? [])
    .map((node) => renderBlockNode(node, indentPrefix, options).trimEnd())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function markdownToAdf(
  markdown: string,
  options: MarkdownToAdfOptions = {}
): AdfDocument {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return { type: "doc", version: 1, content: [createParagraph("", options)] };
  }

  const lines = normalized.split("\n");
  const content: AdfNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    const headingMatch = countLeadingSpaces(line) === 0 ? headingPattern.exec(line) : null;
    if (headingMatch) {
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1]?.length ?? 1 },
        content: parseInline(headingMatch[2] ?? "", options)
      });
      index += 1;
      continue;
    }

    const fenceMatch = countLeadingSpaces(line) === 0 ? fencedPattern.exec(line) : null;
    if (fenceMatch) {
      const language = fenceMatch[1];
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !fencedPattern.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      const codeBlock: AdfNode = {
        type: "codeBlock",
        content: [createTextNode(codeLines.join("\n"))]
      };
      if (language) {
        codeBlock.attrs = { language };
      }
      content.push(codeBlock);
      continue;
    }

    const standaloneImage = countLeadingSpaces(line) === 0 ? parseStandaloneImage(trimmed) : undefined;
    if (standaloneImage) {
      content.push(createMarkdownImageBlock(standaloneImage.label, standaloneImage.href, options));
      index += 1;
      continue;
    }

    if (countLeadingSpaces(line) === 0 && isMarkdownRule(line)) {
      content.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const [tableNode, nextIndex] = parseTable(lines, index, options);
      content.push(tableNode);
      index = nextIndex;
      continue;
    }

    if (isTopLevelListLine(line)) {
      const [listNode, nextIndex] = parseList(lines, index, options);
      content.push(listNode);
      index = nextIndex;
      continue;
    }

    if (countLeadingSpaces(line) === 0 && line.startsWith(">")) {
      const [quoteNode, nextIndex] = parseBlockquote(lines, index, options);
      content.push(quoteNode);
      index = nextIndex;
      continue;
    }

    const [paragraphLines, nextIndex] = collectUntilBlank(lines, index, (candidate, candidateIndex) => {
      return (
        (countLeadingSpaces(candidate) === 0 && headingPattern.test(candidate)) ||
        (countLeadingSpaces(candidate) === 0 && fencedPattern.test(candidate)) ||
        (countLeadingSpaces(candidate) === 0 && Boolean(parseStandaloneImage(candidate.trim()))) ||
        (countLeadingSpaces(candidate) === 0 && isMarkdownRule(candidate)) ||
        isMarkdownTableStart(lines, candidateIndex) ||
        isTopLevelListLine(candidate) ||
        (countLeadingSpaces(candidate) === 0 && candidate.startsWith(">"))
      );
    });

    content.push(
      createParagraph(
        paragraphLines.map((entry) => entry.trim()).join(" ").trim(),
        options
      )
    );
    index = nextIndex;
  }

  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [createParagraph("", options)]
  };
}

export function adfToMarkdown(value: unknown, options: AdfToMarkdownOptions = {}): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const document = value as Partial<AdfDocument>;
  if (document.type !== "doc") {
    return "";
  }

  return renderBlockNodes(document.content, "", options);
}
