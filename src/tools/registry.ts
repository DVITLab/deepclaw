import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AppConfig } from "../config.js";

export function buildToolDefinitions(config: AppConfig): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [];

  if (config.shellEnabled) {
    const approvalHint =
      config.shellApprovalMode !== "off"
        ? " Heuristic risky commands may require the user to confirm in the chat (inline buttons) before the command runs."
        : "";
    tools.push({
      type: "function",
      function: {
        name: "run_shell",
        description:
          "Run one shell command via bash -lc. Initial cwd is <data-dir>/workspace (always). Commands must not use absolute paths outside that tree (except /dev/null for redirects). Relative paths resolve under the project workspace. The tool waits until the process exits (time limits apply). Do NOT run blocking dev servers in the foreground — use nohup ... & and log under ./ (e.g. ./.server.log). Prefer a single concise command; chain with && if needed." +
          approvalHint,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Full shell command string",
            },
          },
          required: ["command"],
        },
      },
    });
  }

  tools.push({
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file (read-only). Paths must lie under <data-dir>/workspace only (same rule in safe and full mode). Relative paths resolve there. Returns truncated UTF-8 content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative to <data-dir>/workspace or absolute path inside that directory",
          },
          max_chars: {
            type: "number",
            description: "Max characters to return (default 8000)",
          },
        },
        required: ["path"],
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file under <data-dir>/workspace only (always enforced; DEEPCLAW_WORKSPACE does not change this). Prefer this over run_shell for saving project files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative to <data-dir>/workspace or absolute within that directory (same folder as the default agent sandbox).",
          },
          content: { type: "string", description: "Full file contents" },
          create_directories: {
            type: "boolean",
            description: "If true, create parent directories (default false)",
          },
        },
        required: ["path", "content"],
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List files and subdirectories under a path inside <data-dir>/workspace only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory under <data-dir>/workspace (default . for that root)",
          },
          max_entries: {
            type: "number",
            description: "Max entries to return (default 200, max 500)",
          },
          recursive: {
            type: "boolean",
            description: "If true, list recursively up to depth 2 (default false)",
          },
        },
        required: [],
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "grep_workspace",
      description:
        "Search file contents with ripgrep (regex) under <data-dir>/workspace only. Same path sandbox as read_file.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Ripgrep regex pattern" },
          path: {
            type: "string",
            description: "Subdirectory or file under <data-dir>/workspace (optional, default that root)",
          },
          glob: {
            type: "string",
            description: "Optional glob filter e.g. *.ts, *.md",
          },
          max_matches: {
            type: "number",
            description: "Max matching lines (default 200, max 500)",
          },
        },
        required: ["pattern"],
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "git_status",
      description:
        "Run `git status` in <data-dir>/workspace (porcelain + branch). Read-only; prefer over shell for repo state.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "git_diff_stat",
      description:
        "Run `git diff --stat` in <data-dir>/workspace. Optional path limits diff to that path (must stay under that tree). Read-only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional path under <data-dir>/workspace; empty = whole repo",
          },
        },
        required: [],
      },
    },
  });

  if (config.runTestsToolEnabled) {
    tools.push({
      type: "function",
      function: {
        name: "run_tests",
        description:
          "Run a fixed automated test command in <data-dir>/workspace (no arbitrary shell). Preset npm_test runs `npm test`; pytest runs `pytest -q --maxfail 1`. Long timeout; output is truncated.",
        parameters: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              description: "npm_test (default) or pytest",
            },
          },
          required: [],
        },
      },
    });
  }

  tools.push({
    type: "function",
    function: {
      name: "send_file",
      description:
        "Deliver a file to the user on Telegram as a document attachment (after your text reply). File must be under <data-dir>/workspace (same as read_file). Max 50 MB. Call once per file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path under <data-dir>/workspace (relative or absolute within it)",
          },
        },
        required: ["path"],
      },
    },
  });

  if (config.browserEnabled) {
    const dnsHint = config.browserResolveDns
      ? " Hostnames are resolved and blocked if they point to private/reserved IPs (reduces DNS rebinding)."
      : "";
    tools.push({
      type: "function",
      function: {
        name: "browse_web",
        description:
          "Open an http(s) URL with headless Chromium (full access). Returns visible text (truncated). URLs whose host is loopback or a literal private/reserved IP are rejected (basic SSRF mitigation)." +
          dnsHint,
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "http or https URL" },
          },
          required: ["url"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "send_image_url",
        description:
          "TELEGRAM: Delivers an actual photo in chat (native image). browse_web does NOT do this — it only returns page text. When the user wants to SEE a picture, call with a DIRECT image file URL (JPEG, PNG, GIF, WebP), not an HTML gallery. Same allowlist/SSRF/DNS as browse_web. Fetches use browser-like headers and retries; operator may set DEEPCLAW_SEND_IMAGE_FETCH_MODE=auto|playwright for stubborn CDNs. Wikipedia/Wikimedia: upload.wikimedia.org file/thumb URLs. caption (required) = short alt-style text. If download fails, give the plain URL in text.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "Direct image URL (https preferred), not a gallery HTML page",
            },
            caption: {
              type: "string",
              description:
                "Required. Short description tied to your answer (like alt text), max 1024 chars",
            },
          },
          required: ["url", "caption"],
        },
      },
    });
  }

  if (config.longTermMemoryEnabled) {
    tools.push({
      type: "function",
      function: {
        name: "read_long_term_memory",
        description:
          "Read persistent notes for THIS chat only (facts, preferences, ongoing goals). Separate from the sliding message history; use to recall what the user asked you to remember across sessions. Plain text / Markdown body.",
        parameters: {
          type: "object",
          properties: {
            max_chars: {
              type: "number",
              description: `Max characters (default ${32000}, capped)`,
            },
          },
          required: [],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "write_long_term_memory",
        description:
          "Replace the entire long-term notes file for THIS chat with the given plain text (or light Markdown). Use when the user explicitly asks you to remember something long-term, or to update stored preferences. Overwrites previous content — read first if you need to merge.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Full new contents for this chat's long-term notes",
            },
          },
          required: ["content"],
        },
      },
    });
  }

  return tools;
}
