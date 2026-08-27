import {
  Compiler,
  Filepath,
  MemoryProjectLayout,
  SyntaxNodeKind,
  SyntaxTokenKind,
  type AttributeNode,
  type ElementDeclarationNode,
  type SyntaxNode,
  type SyntaxToken,
} from "@dbml/parse";
import type { SourceRange, TextNote } from "./schema-graph.js";

export interface SourceTextIndex {
  noteByOwner: ReadonlyMap<string, TextNote>;
  stickyContentByOwner: ReadonlyMap<string, TextNote>;
}

export function buildSingleFileSourceTextIndex(source: string, filepath: string): SourceTextIndex {
  const path = Filepath.from(filepath);
  const layout = new MemoryProjectLayout();
  layout.setSource(path, source);
  return buildSourceTextIndex(new Compiler(layout), [{ path, publicFilepath: filepath }]);
}

export function buildProjectSourceTextIndex(
  compiler: Compiler,
  filepaths: readonly string[],
): SourceTextIndex {
  return buildSourceTextIndex(
    compiler,
    filepaths.map((filepath) => ({
      path: Filepath.from(filepath),
      publicFilepath: filepath,
    })),
  );
}

export function sourceOwnerKey(filepath: string, startOffset: number, endOffset: number): string {
  return JSON.stringify([filepath, startOffset, endOffset]);
}

function buildSourceTextIndex(
  compiler: Compiler,
  files: ReadonlyArray<{ path: Filepath; publicFilepath: string }>,
): SourceTextIndex {
  const noteByOwner = new Map<string, TextNote>();
  const stickyContentByOwner = new Map<string, TextNote>();

  for (const file of files) {
    const ast = compiler.parse.ast(file.path);
    const tokens = compiler.parse.tokens(file.path);
    visitNode(ast, [], (node, ancestors) => {
      if (node.kind === SyntaxNodeKind.ELEMENT_DECLARATION) {
        const declaration = node as ElementDeclarationNode;
        if (declaration.type?.value.toLowerCase() !== "note") return;

        const valueToken = findTextToken(declaration.body, tokens);
        if (!valueToken) return;
        const value = textNote(valueToken, file.publicFilepath);
        const owner = findOwnerDeclaration(ancestors);

        if (owner) {
          register(noteByOwner, sourceOwnerKey(file.publicFilepath, owner.start, owner.end), value);
        } else {
          register(
            stickyContentByOwner,
            sourceOwnerKey(file.publicFilepath, declaration.start, declaration.end),
            value,
          );
        }
        return;
      }

      if (node.kind !== SyntaxNodeKind.ATTRIBUTE) return;
      const attribute = node as AttributeNode;
      if (attributeName(attribute, tokens) !== "note") return;

      const owner = findAttributeOwner(ancestors);
      const valueToken = findTextToken(attribute.value, tokens);
      if (!owner || !valueToken) return;
      register(
        noteByOwner,
        sourceOwnerKey(file.publicFilepath, owner.start, owner.end),
        textNote(valueToken, file.publicFilepath),
      );
    });
  }

  return { noteByOwner, stickyContentByOwner };
}

function visitNode(
  node: SyntaxNode,
  ancestors: readonly SyntaxNode[],
  visitor: (node: SyntaxNode, ancestors: readonly SyntaxNode[]) => void,
): void {
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [property, value] of Object.entries(node)) {
    if (property === "parentNode" || property === "filepath") continue;
    if (isSyntaxNode(value)) {
      visitNode(value, nextAncestors, visitor);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (isSyntaxNode(item)) visitNode(item, nextAncestors, visitor);
    }
  }
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

function findOwnerDeclaration(ancestors: readonly SyntaxNode[]): ElementDeclarationNode | null {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index];
    if (candidate?.kind === SyntaxNodeKind.ELEMENT_DECLARATION) {
      return candidate as ElementDeclarationNode;
    }
  }
  return null;
}

function findAttributeOwner(ancestors: readonly SyntaxNode[]): SyntaxNode | null {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index];
    if (
      candidate?.kind === SyntaxNodeKind.FUNCTION_APPLICATION ||
      candidate?.kind === SyntaxNodeKind.ELEMENT_DECLARATION
    ) {
      return candidate;
    }
  }
  return null;
}

function attributeName(attribute: AttributeNode, tokens: readonly SyntaxToken[]): string | null {
  const name = attribute.name;
  if (!name) return null;
  const token = tokens.find(
    (candidate) => candidate.start >= name.start && candidate.end <= name.end,
  );
  return token?.value.toLowerCase() ?? null;
}

function findTextToken(
  node: SyntaxNode | undefined,
  tokens: readonly SyntaxToken[],
): SyntaxToken | null {
  if (!node) return null;
  return (
    tokens.find(
      (token) =>
        token.start >= node.start &&
        token.end <= node.end &&
        (token.kind === SyntaxTokenKind.QUOTED_STRING ||
          token.kind === SyntaxTokenKind.STRING_LITERAL),
    ) ?? null
  );
}

function textNote(token: SyntaxToken, filepath: string): TextNote {
  return {
    value: token.value,
    range: sourceRange(token, filepath),
  };
}

function sourceRange(token: SyntaxToken, filepath: string): SourceRange {
  return {
    startOffset: token.start,
    endOffset: token.end,
    startLine: token.startPos.line + 1,
    startColumn: token.startPos.column + 1,
    endLine: token.endPos.line + 1,
    endColumn: token.endPos.column + 1,
    filepath,
  };
}

function register(map: Map<string, TextNote>, key: string, value: TextNote): void {
  if (map.has(key)) {
    throw new Error(`Multiple note values were found for one DBML element: ${key}`);
  }
  map.set(key, value);
}
