import type { ColumnNode } from "@er-diagram/core";
import type { TextEdit } from "./types.js";

export interface OffsetSpan {
  startOffset: number;
  endOffset: number;
}

export interface ParsedSetting {
  key: string;
  raw: string;
  contentStart: number;
  contentEnd: number;
}

export interface ParsedSettingsBlock {
  startOffset: number;
  endOffset: number;
  entries: ParsedSetting[];
}

export interface ParsedColumnDeclaration {
  nameSpan: OffsetSpan;
  typeSpan: OffsetSpan;
  settings: ParsedSettingsBlock | null;
}

export interface ParsedTableHeader {
  openBraceOffset: number;
  settings: ParsedSettingsBlock | null;
}

export interface ExistingSettingMutation {
  create: string;
  update: (entry: ParsedSetting) => string | null;
}

export type SettingMutation = string | ExistingSettingMutation | null | undefined;

const MAX_DIFF_CELLS = 4_000_000;

export function parseColumnDeclaration(fragment: string): ParsedColumnDeclaration | null {
  let cursor = skipWhitespace(fragment, 0);
  const nameSpan = readIdentifier(fragment, cursor);
  if (!nameSpan) return null;
  cursor = skipWhitespace(fragment, nameSpan.endOffset);
  if (cursor >= fragment.length) return null;

  const typeStart = cursor;
  const bracketStart = findTopLevelCharacter(fragment, cursor, "[");
  const typeEnd = trimEndOffset(fragment, typeStart, bracketStart ?? fragment.length);
  if (typeEnd <= typeStart) return null;

  const settings = bracketStart === null ? null : parseSettingsBlock(fragment, bracketStart);
  if (bracketStart !== null && !settings) return null;

  return {
    nameSpan,
    typeSpan: { startOffset: typeStart, endOffset: typeEnd },
    settings,
  };
}

export function parseTableHeader(fragment: string): ParsedTableHeader | null {
  const keywordEnd = consumeKeyword(fragment, skipWhitespace(fragment, 0), "Table");
  if (keywordEnd === null) return null;
  const openBraceOffset = findTopLevelCharacter(fragment, keywordEnd, "{");
  if (openBraceOffset === null) return null;
  const bracketStart = findTopLevelCharacter(fragment.slice(0, openBraceOffset), keywordEnd, "[");
  const settings = bracketStart === null ? null : parseSettingsBlock(fragment, bracketStart);
  if (bracketStart !== null && !settings) return null;
  return { openBraceOffset, settings };
}

export function rewriteSettings(
  fragment: string,
  block: ParsedSettingsBlock | null,
  insertionOffset: number,
  mutations: Readonly<Record<string, SettingMutation>>,
): string | null {
  const normalizedMutations = new Map(
    Object.entries(mutations).filter(
      (entry): entry is [string, Exclude<SettingMutation, undefined>] => entry[1] !== undefined,
    ),
  );
  if (normalizedMutations.size === 0) return fragment;

  if (!block) {
    const additions = [...normalizedMutations.values()].flatMap((value) => {
      if (value === null) return [];
      return [typeof value === "object" ? value.create : value];
    });
    if (additions.length === 0) return fragment;
    const trimmedInsertionOffset = trimEndOffset(fragment, 0, insertionOffset);
    return `${fragment.slice(0, trimmedInsertionOffset)} [${additions.join(", ")}]${fragment.slice(trimmedInsertionOffset)}`;
  }

  const seen = new Set<string>();
  const existingKeys = new Set<string>();
  const rewrittenEntries: Array<{ originalIndex: number; raw: string }> = [];
  for (const [originalIndex, entry] of block.entries.entries()) {
    if (seen.has(entry.key)) return null;
    seen.add(entry.key);
    existingKeys.add(entry.key);
    const mutation = normalizedMutations.get(entry.key);
    if (mutation === null) continue;
    if (typeof mutation === "object") {
      const updated = mutation.update(entry);
      if (updated === null) return null;
      rewrittenEntries.push({ originalIndex, raw: updated });
    } else {
      rewrittenEntries.push({ originalIndex, raw: mutation ?? entry.raw });
    }
  }

  const additions: string[] = [];
  for (const [key, mutation] of normalizedMutations) {
    if (mutation === null || existingKeys.has(key)) continue;
    additions.push(typeof mutation === "object" ? mutation.create : mutation);
  }

  if (rewrittenEntries.length === 0 && additions.length === 0) {
    let removalStart = block.startOffset;
    while (removalStart > 0 && /[\t ]/u.test(fragment[removalStart - 1] ?? "")) removalStart -= 1;
    return `${fragment.slice(0, removalStart)}${fragment.slice(block.endOffset)}`;
  }

  const inner = fragment.slice(block.startOffset + 1, block.endOffset - 1);
  const leading = inner.match(/^\s*/u)?.[0] ?? "";
  const trailing = inner.match(/\s*$/u)?.[0] ?? "";
  const defaultSeparator = detectSettingSeparator(inner);
  const content: string[] = [];
  for (const [index, entry] of rewrittenEntries.entries()) {
    if (index > 0) {
      const previous = rewrittenEntries[index - 1];
      content.push(
        previous
          ? settingSeparatorAfter(fragment, block.entries, previous.originalIndex, defaultSeparator)
          : defaultSeparator,
      );
    }
    content.push(entry.raw);
  }
  if (additions.length > 0) {
    if (rewrittenEntries.length > 0) {
      const previous = rewrittenEntries.at(-1);
      content.push(
        previous
          ? settingSeparatorAfter(fragment, block.entries, previous.originalIndex, defaultSeparator)
          : defaultSeparator,
      );
    }
    content.push(additions.join(defaultSeparator));
  }
  const newInner = `${leading}${content.join("")}${trailing}`;
  return `${fragment.slice(0, block.startOffset + 1)}${newInner}${fragment.slice(block.endOffset - 1)}`;
}

export function renderIdentifier(name: string, preserveQuoted = false): string {
  return !preserveQuoted && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
}

export function isQuotedIdentifier(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"');
}

export function renderDbmlString(value: string): string {
  return JSON.stringify(value);
}

export function renderDbmlStringWithStyle(value: string, existingSource: string): string {
  const trimmed = existingSource.trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''") && !value.includes("'''")) {
    return `'''${value}'''`;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return `'${value
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replaceAll("\t", "\\t")}'`;
  }
  return renderDbmlString(value);
}

export function replaceSettingValue(entry: ParsedSetting, newValue: string): string | null {
  const colon = findTopLevelCharacter(entry.raw, 0, ":");
  if (colon === null) return null;
  const valueStart = skipHorizontalWhitespace(entry.raw, colon + 1);
  const valueEnd = trimEndOffset(entry.raw, valueStart, entry.raw.length);
  if (valueStart >= valueEnd) return null;
  return `${entry.raw.slice(0, valueStart)}${newValue}${entry.raw.slice(valueEnd)}`;
}

export function settingValueSource(entry: ParsedSetting): string | null {
  const colon = findTopLevelCharacter(entry.raw, 0, ":");
  if (colon === null) return null;
  const valueStart = skipHorizontalWhitespace(entry.raw, colon + 1);
  const valueEnd = trimEndOffset(entry.raw, valueStart, entry.raw.length);
  return valueStart < valueEnd ? entry.raw.slice(valueStart, valueEnd) : null;
}

export function parseColumnTypeFragment(value: string): ColumnNode["type"] | null {
  const fragment = value.trim();
  const argumentStart = trailingArgumentStart(fragment);
  const nameFragment = argumentStart === null ? fragment : fragment.slice(0, argumentStart).trim();
  const segments = splitQualifiedTypeName(nameFragment);
  if (!segments || segments.length < 1 || segments.length > 2) return null;

  const decoded = segments.map(decodeTypeIdentifier);
  if (decoded.some((segment) => segment === null)) return null;
  const names = decoded as string[];
  const schemaName = names.length === 2 ? names[0] : null;
  const name = names.at(-1);
  if (!name) return null;
  const argumentsValue =
    argumentStart === null ? null : normalizeTypeArguments(fragment.slice(argumentStart + 1, -1));
  if (argumentsValue === undefined) return null;

  const type = {
    schemaName: schemaName ?? null,
    name,
    arguments: argumentsValue,
    display: "",
  } satisfies ColumnNode["type"];
  return { ...type, display: renderColumnType(type) };
}

export function sameColumnType(left: ColumnNode["type"], right: ColumnNode["type"]): boolean {
  return (
    left.schemaName === right.schemaName &&
    left.name === right.name &&
    left.arguments === right.arguments
  );
}

export function lineStartOffset(source: string, offset: number): number {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

export function lineEndOffset(source: string, offset: number, includeLineEnding = true): number {
  const newline = source.indexOf("\n", offset);
  if (newline === -1) return source.length;
  return includeLineEnding
    ? newline + 1
    : newline > 0 && source[newline - 1] === "\r"
      ? newline - 1
      : newline;
}

export function lineSpanForRange(source: string, range: OffsetSpan): OffsetSpan {
  return {
    startOffset: lineStartOffset(source, range.startOffset),
    endOffset: lineEndOffset(source, Math.max(range.startOffset, range.endOffset), true),
  };
}

export function lineIndentAt(source: string, offset: number): string | null {
  const start = lineStartOffset(source, offset);
  const prefix = source.slice(start, offset);
  return /^[\t ]*$/u.test(prefix) ? prefix : null;
}

export function detectNewline(source: string, startOffset = 0, endOffset = source.length): string {
  return source.slice(startOffset, endOffset).includes("\r\n") ? "\r\n" : "\n";
}

export function deriveMinimalTextEdits(
  before: string,
  after: string,
  baseOffset = 0,
): TextEdit[] | null {
  if (before === after) return [];
  const cellCount = (before.length + 1) * (after.length + 1);
  if (cellCount > MAX_DIFF_CELLS) return null;

  const width = after.length + 1;
  const matrix = new Uint32Array(cellCount);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      matrix[index] =
        before.charCodeAt(left) === after.charCodeAt(right)
          ? (matrix[(left + 1) * width + right + 1] ?? 0) + 1
          : Math.max(
              matrix[(left + 1) * width + right] ?? 0,
              matrix[left * width + right + 1] ?? 0,
            );
    }
  }

  const edits: TextEdit[] = [];
  let left = 0;
  let right = 0;
  let changeStart: number | null = null;
  let newText = "";
  const flush = () => {
    if (changeStart === null) return;
    edits.push({
      startOffset: baseOffset + changeStart,
      endOffset: baseOffset + left,
      newText,
    });
    changeStart = null;
    newText = "";
  };

  while (left < before.length || right < after.length) {
    if (
      left < before.length &&
      right < after.length &&
      before.charCodeAt(left) === after.charCodeAt(right)
    ) {
      flush();
      left += 1;
      right += 1;
      continue;
    }
    if (changeStart === null) changeStart = left;
    const insertScore = right < after.length ? (matrix[left * width + right + 1] ?? 0) : -1;
    const deleteScore = left < before.length ? (matrix[(left + 1) * width + right] ?? 0) : -1;
    if (right < after.length && (left >= before.length || insertScore >= deleteScore)) {
      newText += after[right] ?? "";
      right += 1;
    } else {
      left += 1;
    }
  }
  flush();
  return edits;
}

export function deriveLinePreservingTextEdits(before: string, after: string): TextEdit[] | null {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length !== afterLines.length) return null;
  const edits: TextEdit[] = [];
  let offset = 0;
  for (let index = 0; index < beforeLines.length; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === undefined || afterLine === undefined) return null;
    if (lineEnding(beforeLine) !== lineEnding(afterLine)) return null;
    const lineEdits = deriveMinimalTextEdits(beforeLine, afterLine, offset);
    if (!lineEdits) return null;
    edits.push(...lineEdits);
    offset += beforeLine.length;
  }
  return edits;
}

export function identifierTokens(
  source: string,
  range: OffsetSpan,
): Array<OffsetSpan & { value: string }> {
  const tokens: Array<OffsetSpan & { value: string }> = [];
  let cursor = range.startOffset;
  while (cursor < range.endOffset) {
    const character = source[cursor] ?? "";
    if (character === '"') {
      const token = readQuoted(source, cursor, '"');
      if (!token || token.endOffset > range.endOffset) break;
      tokens.push({
        ...token,
        value: decodeQuoted(source.slice(token.startOffset, token.endOffset)),
      });
      cursor = token.endOffset;
      continue;
    }
    if (isIdentifierCharacter(character)) {
      const startOffset = cursor;
      cursor += 1;
      while (cursor < range.endOffset && isIdentifierCharacter(source[cursor] ?? "")) cursor += 1;
      tokens.push({
        startOffset,
        endOffset: cursor,
        value: source.slice(startOffset, cursor),
      });
      continue;
    }
    cursor += 1;
  }
  return tokens;
}

export function containsOpaqueIdentifierPath(
  expression: string,
  candidates: readonly string[][],
): boolean {
  const paths = expressionIdentifierPaths(expression);
  return paths.some((path) =>
    candidates.some(
      (candidate) =>
        candidate.length <= path.length &&
        candidate.every(
          (segment, index) => segment === path[path.length - candidate.length + index],
        ),
    ),
  );
}

export function containsOpaqueIdentifierQualifier(
  expression: string,
  candidates: readonly string[][],
): boolean {
  const paths = expressionIdentifierPaths(expression);
  return paths.some((path) =>
    candidates.some((candidate) => {
      if (candidate.length > path.length) return false;
      for (let start = 0; start <= path.length - candidate.length; start += 1) {
        const matches = candidate.every((segment, index) => segment === path[start + index]);
        if (!matches) continue;
        if (candidate.length > 1 || start + candidate.length < path.length) return true;
      }
      return false;
    }),
  );
}

function parseSettingsBlock(fragment: string, startOffset: number): ParsedSettingsBlock | null {
  const endOffset = findMatchingDelimiter(fragment, startOffset, "[", "]");
  if (endOffset === null) return null;
  const entries: ParsedSetting[] = [];
  for (const span of splitTopLevel(fragment, startOffset + 1, endOffset - 1, ",")) {
    const contentStart = trimStartOffset(fragment, span.startOffset, span.endOffset);
    const contentEnd = trimEndOffset(fragment, contentStart, span.endOffset);
    if (contentStart === contentEnd) continue;
    const raw = fragment.slice(contentStart, contentEnd);
    const colon = findTopLevelCharacter(raw, 0, ":");
    const rawKey = (colon === null ? raw : raw.slice(0, colon)).trim().toLowerCase();
    entries.push({
      key: normalizeSettingKey(rawKey),
      raw,
      contentStart,
      contentEnd,
    });
  }
  return { startOffset, endOffset, entries };
}

function normalizeSettingKey(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ");
  if (collapsed === "primary key") return "pk";
  return collapsed;
}

function detectSettingSeparator(inner: string): string {
  const comma = findTopLevelCharacter(inner, 0, ",");
  if (comma === null) return ", ";
  let end = comma + 1;
  while (end < inner.length && /[\t ]/u.test(inner[end] ?? "")) end += 1;
  return inner.slice(comma, end) || ", ";
}

function settingSeparatorAfter(
  fragment: string,
  entries: readonly ParsedSetting[],
  entryIndex: number,
  fallback: string,
): string {
  const entry = entries[entryIndex];
  const next = entries[entryIndex + 1];
  if (!entry || !next) return fallback;
  const separator = fragment.slice(entry.contentEnd, next.contentStart);
  return separator.includes(",") ? separator : fallback;
}

function splitTopLevel(
  source: string,
  startOffset: number,
  endOffset: number,
  delimiter: string,
): OffsetSpan[] {
  const spans: OffsetSpan[] = [];
  let start = startOffset;
  let cursor = startOffset;
  const stack: string[] = [];
  while (cursor < endOffset) {
    const skipped = skipQuotedOrComment(source, cursor, endOffset);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const character = source[cursor] ?? "";
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") stack.pop();
    else if (character === delimiter && stack.length === 0) {
      spans.push({ startOffset: start, endOffset: cursor });
      start = cursor + 1;
    }
    cursor += 1;
  }
  spans.push({ startOffset: start, endOffset });
  return spans;
}

function findTopLevelCharacter(source: string, startOffset: number, target: string): number | null {
  let cursor = startOffset;
  const stack: string[] = [];
  while (cursor < source.length) {
    const skipped = skipQuotedOrComment(source, cursor, source.length);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const character = source[cursor] ?? "";
    if (character === target && stack.length === 0) return cursor;
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") stack.pop();
    cursor += 1;
  }
  return null;
}

function findMatchingDelimiter(
  source: string,
  startOffset: number,
  opening: string,
  closing: string,
): number | null {
  let cursor = startOffset;
  let depth = 0;
  while (cursor < source.length) {
    const skipped = skipQuotedOrComment(source, cursor, source.length);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const character = source[cursor] ?? "";
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return null;
}

function skipQuotedOrComment(source: string, cursor: number, endOffset: number): number | null {
  if (source.startsWith("'''", cursor)) {
    const end = source.indexOf("'''", cursor + 3);
    return end === -1 || end + 3 > endOffset ? endOffset : end + 3;
  }
  const character = source[cursor] ?? "";
  if (character === "'" || character === '"' || character === "`") {
    return readQuoted(source, cursor, character)?.endOffset ?? endOffset;
  }
  if (source.startsWith("//", cursor) || source.startsWith("--", cursor)) {
    const end = source.indexOf("\n", cursor + 2);
    return end === -1 || end > endOffset ? endOffset : end;
  }
  if (source.startsWith("/*", cursor)) {
    const end = source.indexOf("*/", cursor + 2);
    return end === -1 || end + 2 > endOffset ? endOffset : end + 2;
  }
  return null;
}

function readIdentifier(source: string, startOffset: number): OffsetSpan | null {
  if (source[startOffset] === '"') return readQuoted(source, startOffset, '"');
  if (!isIdentifierCharacter(source[startOffset] ?? "")) return null;
  let endOffset = startOffset + 1;
  while (endOffset < source.length && isIdentifierCharacter(source[endOffset] ?? ""))
    endOffset += 1;
  return { startOffset, endOffset };
}

function readQuoted(source: string, startOffset: number, quote: string): OffsetSpan | null {
  let cursor = startOffset + 1;
  let escaped = false;
  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return { startOffset, endOffset: cursor + 1 };
    cursor += 1;
  }
  return null;
}

function decodeQuoted(value: string): string {
  try {
    const decoded = JSON.parse(value) as unknown;
    return typeof decoded === "string" ? decoded : value.slice(1, -1);
  } catch {
    return value.slice(1, -1).replace(/\\([\\"])/gu, "$1");
  }
}

function renderColumnType(type: ColumnNode["type"]): string {
  const qualifiedName = type.schemaName ? `${type.schemaName}.${type.name}` : type.name;
  return type.arguments === null ? qualifiedName : `${qualifiedName}(${type.arguments})`;
}

function trailingArgumentStart(value: string): number | null {
  if (!value.endsWith(")")) return null;
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let start: number | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "(") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && index !== value.length - 1)) return null;
    }
  }

  return !quoted && depth === 0 ? start : null;
}

function splitQualifiedTypeName(value: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== ".") continue;
    segments.push(value.slice(start, index).trim());
    start = index + 1;
  }
  if (quoted || escaped) return null;
  segments.push(value.slice(start).trim());
  return segments;
}

function decodeTypeIdentifier(value: string): string | null {
  if (value.length === 0) return null;
  if (!value.startsWith('"')) return /["\s]/u.test(value) ? null : value;
  if (!value.endsWith('"')) return null;
  try {
    const decoded = JSON.parse(value) as unknown;
    return typeof decoded === "string" && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeTypeArguments(value: string): string | undefined {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < value.length; end += 1) {
        const candidate = value[end];
        if (escaped) escaped = false;
        else if (candidate === "\\") escaped = true;
        else if (candidate === '"') break;
      }
      if (end >= value.length) return undefined;
      const decoded = decodeTypeIdentifier(value.slice(index, end + 1));
      if (decoded === null) return undefined;
      result += decoded;
      index = end;
      continue;
    }
    if (!/\s/u.test(character ?? "")) result += character;
  }
  return result;
}

function expressionIdentifierPaths(expression: string): string[][] {
  const paths: string[][] = [];
  let current: string[] = [];
  let cursor = 0;
  let expectingSegment = true;
  const flush = () => {
    if (current.length > 0) paths.push(current);
    current = [];
    expectingSegment = true;
  };

  while (cursor < expression.length) {
    if (expression.startsWith("--", cursor) || expression.startsWith("//", cursor)) {
      const end = expression.indexOf("\n", cursor + 2);
      cursor = end === -1 ? expression.length : end;
      flush();
      continue;
    }
    if (expression.startsWith("/*", cursor)) {
      const end = expression.indexOf("*/", cursor + 2);
      cursor = end === -1 ? expression.length : end + 2;
      flush();
      continue;
    }
    const character = expression[cursor] ?? "";
    if (character === "'") {
      cursor = readQuoted(expression, cursor, "'")?.endOffset ?? expression.length;
      flush();
      continue;
    }
    if (character === '"' || character === "`") {
      const token = readQuoted(expression, cursor, character);
      if (!token) break;
      if (!expectingSegment) flush();
      const raw = expression.slice(token.startOffset, token.endOffset);
      current.push(character === '"' ? decodeQuoted(raw) : raw.slice(1, -1));
      expectingSegment = false;
      cursor = token.endOffset;
      continue;
    }
    if (isIdentifierCharacter(character)) {
      if (!expectingSegment) flush();
      const start = cursor;
      cursor += 1;
      while (cursor < expression.length && isIdentifierCharacter(expression[cursor] ?? "")) {
        cursor += 1;
      }
      current.push(expression.slice(start, cursor));
      expectingSegment = false;
      continue;
    }
    if (character === "." && current.length > 0 && !expectingSegment) {
      expectingSegment = true;
      cursor += 1;
      continue;
    }
    flush();
    cursor += 1;
  }
  flush();
  return paths;
}

function isIdentifierCharacter(character: string): boolean {
  return character.length > 0 && /[\p{L}\p{N}_$]/u.test(character);
}

function consumeKeyword(source: string, offset: number, keyword: string): number | null {
  return source.slice(offset, offset + keyword.length).toLowerCase() === keyword.toLowerCase()
    ? offset + keyword.length
    : null;
}

function skipWhitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /\s/u.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function skipHorizontalWhitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /[\t ]/u.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function trimStartOffset(source: string, startOffset: number, endOffset: number): number {
  let cursor = startOffset;
  while (cursor < endOffset && /\s/u.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function trimEndOffset(source: string, startOffset: number, endOffset: number): number {
  let cursor = endOffset;
  while (cursor > startOffset && /\s/u.test(source[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}

function splitLines(source: string): string[] {
  if (source.length === 0) return [""];
  return source.match(/.*(?:\r\n|\n|$)/gu)?.filter((line) => line.length > 0) ?? [source];
}

function lineEnding(line: string): string {
  if (line.endsWith("\r\n")) return "\r\n";
  if (line.endsWith("\n")) return "\n";
  return "";
}
