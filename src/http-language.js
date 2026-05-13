// Monaco language definition for `.http` / `.rest` files.
//
// Goal: behave like the VS Code REST Client format. We register:
//   - The language id `http`
//   - A Monarch tokenizer for syntax highlighting
//   - A simple configuration (comments)
//
// The registration is idempotent so HMR doesn't double-register.

import * as monaco from "monaco-editor";

let registered = false;

export function registerHttpLanguage() {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: "http",
    extensions: [".http", ".rest"],
    aliases: ["HTTP", "REST"],
  });

  monaco.languages.setLanguageConfiguration("http", {
    comments: {
      lineComment: "#",
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider("http", {
    defaultToken: "",
    tokenPostfix: ".http",

    // Recognized HTTP verbs at the start of a request line.
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
      "CONNECT",
      "TRACE",
    ],

    tokenizer: {
      root: [
        // Request separator. Anything after `###` is treated as the request's
        // human-readable name (highlighted distinctly).
        [/^###.*$/, "comment.request-separator"],

        // Line comments.
        [/^\s*(?:#|\/\/).*$/, "comment"],

        // File-level variable declaration: `@name = value`.
        [
          /^(@[\w.-]+)(\s*=\s*)(.*)$/,
          ["variable.name", "delimiter", { token: "string", next: "@popall" }],
        ],

        // Request line: METHOD URL [HTTP/version]
        [
          /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)(\s+)(\S+)(.*)$/,
          [
            "keyword.method",
            "",
            "string.link",
            "comment",
          ],
        ],

        // Header line: Name: Value
        [
          /^([A-Za-z][A-Za-z0-9-]*)(\s*:\s*)(.*)$/,
          ["attribute.name", "delimiter", { token: "string" }],
        ],

        // Variable reference {{name}} — works anywhere.
        [/\{\{[^}]+\}\}/, "variable.parameter"],

        // Bare URLs in body / values.
        [/https?:\/\/[^\s"'`]+/, "string.link"],

        // JSON-ish punctuation in body (light touch — full JSON tokenization
        // would require a sublanguage; this is just enough to make bodies
        // not look totally flat).
        [/[{}\[\]]/, "@brackets"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/-?\d+(\.\d+)?/, "number"],
        [/\b(true|false|null)\b/, "keyword"],
      ],
    },
  });
}
