import type { languages } from "monaco-editor";

export const DBML_LANGUAGE_ID = "dbml";

export const dbmlLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
};

export const dbmlMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".dbml",
  keywords: [
    "Project",
    "Table",
    "TablePartial",
    "TableGroup",
    "Enum",
    "Ref",
    "Note",
    "Indexes",
    "DiagramView",
    "Records",
  ],
  typeKeywords: [
    "bigint",
    "bigserial",
    "boolean",
    "char",
    "date",
    "decimal",
    "double",
    "float",
    "int",
    "integer",
    "json",
    "jsonb",
    "numeric",
    "serial",
    "smallint",
    "text",
    "time",
    "timestamp",
    "uuid",
    "varchar",
  ],
  tokenizer: {
    root: [
      [/\/\*/, "comment", "@comment"],
      [/\/\/.*$/, "comment"],
      [/`/, "string.escape", "@backtick"],
      [/"/, "string", "@doubleQuotedString"],
      [/'/, "string", "@singleQuotedString"],
      [
        /[a-zA-Z_$][\w$]*/,
        { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } },
      ],
      [/-?\d+(?:\.\d+)?/, "number"],
      [/[{}()[\]]/, "delimiter.bracket"],
      [/[<>:~.,=+-]/, "delimiter"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\/\*/, "comment", "@push"],
      ["\\*/", "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
    backtick: [
      [/[^`]+/, "string.escape"],
      [/`/, "string.escape", "@pop"],
    ],
    doubleQuotedString: [
      [/[^"\\]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    singleQuotedString: [
      [/[^'\\]+/, "string"],
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
    ],
  },
};
