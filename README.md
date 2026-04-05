# deepclaw

Telegram bot agent using the **DeepSeek** API (OpenAI-compatible). **Run only in Docker** — `deepclaw run` exits on a bare-metal host so dependencies (Chromium, Tesseract, Whisper, etc.) stay inside the image.

Roadmap: [issue #1](https://github.com/dngvn/deepclaw/issues/1).

## Requirements

- **Docker** (required to run the bot)

## Run with Docker

1. Copy `.env.example` to `.env` and set `DEEPSEEK_API_KEY` and `TELEGRAM_BOT_TOKEN` (from [@BotFather](https://t.me/BotFather)).
2. Build and run:

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

**Hugging Face (optional):** You **do not** need a Hugging Face account or token. The image still pre-downloads **faster-whisper** `tiny` anonymously (maybe slower; Hub may show an “unauthenticated” notice). In `.env`, keep **`HF_TOKEN=`** empty as in [`.env.example`](.env.example) — that is enough for `docker compose build`. Only if you want higher Hub rate limits, add a free **read** token from [Hugging Face settings](https://huggingface.co/settings/tokens). Compose passes **`HF_TOKEN`** as a **BuildKit build secret** during `docker compose build` only (not stored in image layers). If build errors on the `hf_token` secret, ensure the line **`HF_TOKEN=`** exists in `.env` (value can be empty).

Without Compose, pass the same variable to `docker build` as a build secret, or omit it when you have no token:

```bash
DOCKER_BUILDKIT=1 docker build --secret id=hf_token,env=HF_TOKEN -t deepclaw .
DOCKER_BUILDKIT=1 docker build -t deepclaw .
```

3. Stop: `docker compose down`.

**Health:** Compose defines a **`healthcheck`** against `http://127.0.0.1:7587/health` (the default **`DEEPCLAW_HEALTH_PORT`**). If you set **`DEEPCLAW_HEALTH_PORT=0`** or change the port, edit **`docker-compose.yml`** healthcheck (or remove it) so the URL matches.

### Laptop / heat on the host

Docker + **faster-whisper** (voice) and **Chromium** (`browse_web`) are the usual reasons a **Mac/PC runs hot**. Mitigations:

- **Docker Desktop (or Engine) → Resources**: lower **CPUs** and **Memory** for the VM — often the biggest win on Apple Silicon/Intel laptops.
- **Stop when idle**: `docker compose stop` (or `down`) so nothing runs in the background.
- **Voice CPU:** set `DEEPCLAW_VOICE_TRANSCRIPTION=0` to disable, or **`auto`** to enable only if a startup probe can `import faster_whisper` (skips voice entirely when deps are missing). Default remains **`on`** (always try).
- **Fewer browser tool calls**: `browse_web` / dev previews inside the container spin up Chromium and spike CPU.
- **Optional**: uncomment `deploy.resources.limits` in `docker-compose.yml` to cap this service (see comment there; if your Compose version ignores it, rely on Docker’s global CPU/RAM sliders).

### Preview ports (Docker)

Host ports are mapped to **standard** ports inside the container so dev tools need no extra flags. Open **`http://127.0.0.1:<host_port>`** in your browser (not the raw container port unless they match).

| Host | Container | Typical use |
|------|-----------|---------------|
| 31300 | 3000 | Next.js, CRA, many frameworks |
| 35173 | 5173 | Vite dev |
| 34173 | 4173 | Vite preview |
| 38080 | 8080 | Custom HTTP |
| 38000 | 8000 | `python -m http.server`, Django dev |
| 35000 | 5000 | Flask, etc. |

Example: Vite defaults to port 5173 in the container; on the host use `http://127.0.0.1:35173`. Bind the server to `0.0.0.0` so it is reachable from outside the container process.

Uncommon host ports reduce clashes with other local apps and casual port scans; they are **not** a substitute for a firewall or trusted network. Combine with `DEEPCLAW_ALLOWED_USER_IDS` for the bot (see Security).

Logs use **one file per day** (e.g. `deepclaw-2026-04-04.log`) under **`./agent-data/logs` on the host** when you mount **`./agent-data:/app/agent-data`** (default layout). Override the base path with `DEEPCLAW_LOG_FILE` if needed.

## CLI (inside the container)

The image default command runs the bot. In `docker compose exec deepclaw deepclaw doctor`, the first **`deepclaw`** is the **Compose service name**; the second is the **`deepclaw`** CLI **inside** the image (`docker exec` does not use `ENTRYPOINT`, so that wrapper is required). With **`docker compose run`**, only the service name appears before the subcommand:

```bash
docker compose exec deepclaw deepclaw doctor
docker compose run --rm deepclaw doctor
```

- `deepclaw doctor` — print config status (no secrets). **Same container rule** as `run`.
- `deepclaw run --channel telegram` — Telegram bot (blocking). Both commands **exit on a bare-metal host**; use the **`docker compose …`** lines above.

Repository maintainers may use **Node.js 20+** on the host only for `npm ci`, `npm test`, and `npm run build` when developing this repo — not for running the agent against Telegram.

## Environment variables

**Required:** `DEEPSEEK_API_KEY`, `TELEGRAM_BOT_TOKEN`.

Everything else is optional; **`deepclaw doctor`** (inside the container) prints resolved paths and flags. Personality defaults to `prompts/personality.md` — override with `DEEPCLAW_PERSONALITY_FILE` if needed.

### Planning pipeline (`DEEPCLAW_PLANNING`)

When enabled, the agent uses a **planning route** (**PLAN** vs **DIRECT**) to decide whether to run **plan → review → execute** or go straight to the tool loop. On **Telegram**, normal text (not starting with `/`) is always run through a **unified gate** (one LLM completion): it classifies **reminders** (propose / list / remove / clarify / **clear_memory** / none) and, when the action is **none**, also returns **plan** or **direct** for planning — reminder + planning routing share that call. There are **no** regex shortcuts: routing stays **multilingual** and accuracy is preferred over saving API calls. Slash commands skip the unified gate and go straight to the agent. If you disable planning (`DEEPCLAW_PLANNING=0`), the unified gate still runs for reminders but the agent ignores the planning route and always uses the direct tool loop. The user only sees the **final answer** (gate/plan/review stay internal).

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEEPCLAW_PLANNING` | on (`true`) | Set `0` or `false` to disable planning and use the direct tool loop only (no gate, no plan phase). |
| `DEEPCLAW_PLANNING_PLAN_MAX_TOKENS` | `768` | Max tokens for the planning completion. |
| `DEEPCLAW_PLANNING_REVIEW_MAX_TOKENS` | `512` | Max tokens for the review completion. |
| `DEEPCLAW_PLANNING_REVIEW` | **on** | Set `0` / `false` / `off` to skip the separate **review** completion after plan (one fewer LLM call). |

Gate classifier `max_tokens` is fixed in code (small). When the planning path runs, chat history stores the same **final** plain-text reply the user sees.

### Paths, API, agent, media

**Convention:** implemented optional features default **on** when unset (voice transcription, rolling summary, long-term memory in **full** mode, DNS checks for `browse_web`, shell confirm for risky commands). Set env to **`0` / `false` / `off`** (or the documented disable value) **only when you do not want** that feature.

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEEPCLAW_DATA_DIR` | `./agent-data` (cwd); image `/app/agent-data` | Root for `chat-history/`, `workspace/`, `logs/`, `reminders.json`. |
| `DEEPCLAW_WORKSPACE` / `DEEPCLAW_WORKDIR` | `<data-dir>/workspace` | Workspace override (`WORKDIR` is legacy). |
| `DEEPCLAW_LOG_FILE` | `<data-dir>/logs/deepclaw.log` | Daily `deepclaw-YYYY-MM-DD.log` beside it; `-` / `none` = no file logs. Line timestamps and the date in the filename use **`DEEPCLAW_TZ`** (via `process.env.TZ`), not hard-coded UTC. |
| `DEEPCLAW_CHAT_HISTORY_DIR` | `<data-dir>/chat-history` | Per-chat JSON; `-` / `none` = off. |
| `DEEPCLAW_CHAT_HISTORY_MAX_MESSAGES` | `48` (allowed `8`–`128`) | Max user/assistant/tool messages kept per chat (sliding window). |
| `DEEPCLAW_LLM_TIMEOUT_MS` | `180000` | LLM HTTP timeout (ms). |
| `DEEPCLAW_LLM_MAX_RETRIES` | `3` (allowed `0`–`8`) | Retries with backoff for chat completions on HTTP 429 and 5xx. |
| `DEEPCLAW_BROWSER_ALLOWLIST` | (empty) | Comma-separated allowed **hostnames** for `browse_web` and **`send_image_url`** in full mode (`example.com`, `*.example.com`). Empty = any public host allowed by existing SSRF rules (private/literal loopback hosts still blocked). |
| `DEEPCLAW_BROWSER_RESOLVE_DNS` | **on** | Unset = resolve hostname and reject private/reserved IPs. **`auto`** = same as on. Set `0` / `false` / `off` to skip (only literal-IP checks in the URL). |
| `DEEPCLAW_SHELL_APPROVAL` | **on** (`dangerous`) | Unset / **`on`** / **`true`** / **`auto`**: only **heuristic risky** `run_shell` commands ask for **inline Telegram** confirmation (Run / Cancel). There is no mode that prompts for every shell. **`off`** / **`0`** / **`false`**: never prompt. |
| `DEEPCLAW_SHELL_TIMEOUT_MS` | `120000` (`15000`–`600000`) | Wall-clock limit for **`run_shell`**: the shell process group is stopped when exceeded (SIGTERM, then SIGKILL). |
| `DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS` | `45000` (`5000`–≤ general cap) | Shorter cap when the command matches the **blocking dev-server** heuristic (e.g. `vite`, `npm run dev`, `python -m http.server` without `nohup` / trailing `&`). Clamped so it never exceeds **`DEEPCLAW_SHELL_TIMEOUT_MS`**. |
| `DEEPCLAW_LONG_TERM_MEMORY` | **on** (full profile) | **Full** mode: unset = **on** (`read_long_term_memory` / `write_long_term_memory` under `<data-dir>/ltm/`). **Safe** mode: always off. Set `0` / `false` / `off` to disable in full. Cleared when the user resets the conversation (unified gate **clear_memory**) or equivalent natural-language wipe. |
| `DEEPCLAW_ROLLING_SUMMARY` | **on** | Unset = **on**: long persisted threads may be compressed with an LLM recap plus recent messages. Set `0` / `false` / `off` to disable. |
| `DEEPCLAW_ROLLING_SUMMARY_MIN_MESSAGES` | `40` (`20`–`200`) | Minimum messages before rolling summary runs. |
| `DEEPCLAW_ROLLING_SUMMARY_TAIL` | `24` (`8`–`96`) | Recent messages kept verbatim after a rolling summary. |
| `DEEPCLAW_HISTORY_TOOL_MAX_CHARS` | `0` | If &gt; `0`, truncate **tool** message bodies outside the last `DEEPCLAW_HISTORY_TOOL_FULL_WINDOW` messages to save tokens. |
| `DEEPCLAW_HISTORY_TOOL_FULL_WINDOW` | `16` (`4`–`64`) | Last *N* messages keep full tool bodies when `DEEPCLAW_HISTORY_TOOL_MAX_CHARS` &gt; `0`. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API base. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Model id. |
| `DEEPCLAW_AGENT_MAX_STEPS` | `16` (max `32`) | Tool-loop step cap per user message. If the cap is hit, the agent runs one extra no-tools completion to summarize tool output instead of stopping with a bare error. |
| `DEEPCLAW_BROWSER_TIMEOUT_MS` | `30000` | `browse_web` and **`send_image_url`** HTTP fetch timeout (ms). |
| `DEEPCLAW_IMAGE_FETCH_USER_AGENT` | (empty) | If set, **first** HTTP attempt for **`send_image_url`** uses this `User-Agent`. Empty = use the default bot UA (`DeepclawBot` in code); built-in retries may still use a Chrome-like UA. |
| `DEEPCLAW_SEND_IMAGE_FETCH_MODE` | **`http`** | **`http`** = Node `fetch` only (with retries / headers). **`playwright`** = download via Playwright’s request context (heavier, better vs some WAFs). **`auto`** = `http` first, then Playwright if the response looks blocked or not an image. |
| `DEEPCLAW_IMAGE_FETCH_REFERER` | **on** (`same-origin`) | Unset / **`on`** / **`same-origin`**: send `Referer: <url-origin>/` on image fetch (helps hotlink rules). **`off`** / **`0`**: no `Referer` header. |
| `DEEPCLAW_BROWSER_MAX_CONTENT_CHARS` | `12000` | Truncate fetched page text. |
| `DEEPCLAW_ALLOWED_USER_IDS` | (empty) | Comma-separated Telegram user ids; empty = allow all. |
| `DEEPCLAW_MAX_MESSAGE_CHARS` | `32768` | Max length (UTF-16 code units) for inbound user text per message; **`0` = no limit**. Very long paste spam is rejected with a short reply. |
| `DEEPCLAW_CHAT_COOLDOWN_MS` | `0` | Min milliseconds between **handled** user messages **per chat**; **`0` = off**. Helps with accidental double-send. |
| `DEEPCLAW_RUN_TESTS_TOOL` | **on** (full profile) | Unset = **on** in full mode: agent may call **`run_tests`** (`npm test` or `pytest` presets in workspace). **Safe** mode: always off. Set `0` / `false` / `off` to disable. |
| `DEEPCLAW_MAX_PENDING_TURNS_PER_CHAT` | `8` (`1`–`64`) | Max agent turns **queued per chat** (including the active one). **`0` = unlimited**. Extra messages get a short “wait” reply. |
| `DEEPCLAW_SHUTDOWN_TIMEOUT_MS` | `30000` (`1000`–`600000`) | On SIGTERM/SIGINT, abort in-flight LLM turns and wait up to this long for per-chat queues to finish before stopping Telegram polling. |
| `DEEPCLAW_HEALTH_PORT` | `7587` | **`0` = off.** Else an HTTP server listens on **`DEEPCLAW_HEALTH_HOST`** (default `127.0.0.1`) with **`GET /health`** → `{"ok":true}`. Docker Compose uses this for **`healthcheck`**. |
| `DEEPCLAW_HEALTH_HOST` | `127.0.0.1` | Bind address for the health server (keep loopback unless you know the risk). |
| `DEEPCLAW_LLM_CIRCUIT` | **on** | Set `0` / `false` / `off` to disable. When **on**, repeated **5xx / 429 / network** failures (after retries) open a short **circuit**; completions fail fast with a user-visible message until the open window passes. |
| `DEEPCLAW_LLM_CIRCUIT_FAILURE_THRESHOLD` | `5` (`1`–`50`) | Consecutive counted failures before the circuit opens. |
| `DEEPCLAW_LLM_CIRCUIT_OPEN_MS` | `60000` (`1000`–`600000`) | How long the circuit stays open after tripping. |
| `DEEPCLAW_USER_MESSAGE_COOLDOWN_MS` | `0` | Min ms between **handled** messages **per Telegram user id** (all chats). **`0` = off**. Complements **`DEEPCLAW_CHAT_COOLDOWN_MS`** (per chat). |
| `DEEPCLAW_TELEGRAM_TOOL_PREAMBLE` | **on** | Set `0` / `false` / `off` to disable. When **on**, if the model’s **first** step in a turn uses tools and includes non-empty plain text in that same assistant message, that text is sent to Telegram **before** tools run; the usual final text and attachments follow. The extra bubble may not appear in persisted `chat-history` JSON (only the final assistant line is stored per user turn). |
| `DEEPCLAW_TZ` | `UTC` | IANA zone; sets `process.env.TZ` (reminders, cron display). |
| `DEEPCLAW_OCR_LANGS` | `eng` | Tesseract `-l` for photo OCR (e.g. `eng+vie` needs extra packs). |
| `DEEPCLAW_VOICE_TRANSCRIPTION` | **on** | Unset = always try voice transcribe. **`off`** / `0` = disable. **`auto`** = probe faster-whisper once at bot start, disable if import fails (lighter default when Whisper is missing). |
| `DEEPCLAW_WHISPER_MODEL` | `tiny` | Voice: faster-whisper model id. |
| `DEEPCLAW_WHISPER_DEVICE` | `cpu` | `cpu` or `cuda`. |
| `DEEPCLAW_WHISPER_COMPUTE_TYPE` | `int8` | e.g. `float32` if `int8` fails. |
| `DEEPCLAW_WHISPER_PYTHON` | (empty → `python3`) | Interpreter for `scripts/whisper_transcribe.py` (image sets venv). |
| `DEEPCLAW_WHISPER_TIMEOUT_MS` | `120000` | Voice subprocess timeout (ms). |

Within one assistant step, if the model returns **several read-only tools at once** (e.g. multiple `read_file`, `list_dir`, `grep_workspace`, `git_status` / `git_diff_stat`, `browse_web`, `read_long_term_memory`), those calls run **in parallel**. Any batch that includes `run_shell`, `write_file`, `send_file`, `send_image_url`, `run_tests`, or LTM write runs **sequentially** so order and side effects stay predictable.

Long turns (planning + many tools) also refresh Telegram “typing” every ~2 seconds so the client does not look idle while work continues. Bot replies are sent as **normal chat messages** (no **`reply_parameters`** quote of the user’s message). In **forum** (topic) chats, **`message_thread_id`** is set when the user’s message was in a topic so replies and follow-up chunks stay in that thread. Optional **tool-round preamble** (see **`DEEPCLAW_TELEGRAM_TOOL_PREAMBLE`**) can send one short user-visible line before the first tool batch in a turn.

### Telegram: no slash commands

The bot clears the Telegram **`/` command menu** on startup and after reconnects (**`setMyCommands([])`**), so there are no built-in slash shortcuts. Use **natural language** for everything: questions, coding, reminders, clearing memory (“forget this chat”, etc.), and listing reminders (“show my reminders”). To **abort the current reply** for this chat, send a **short** phrase alone such as **`stop`**, **`cancel`**, **`dừng lại`**, or **`hủy`** (in-flight LLM stops; a **shell** subprocess may still finish). Longer sentences are not treated as stop requests.

### Chat history (Telegram)

Telegram does not expose full server-side history to bots. Context is **saved locally** per chat as JSON under `DEEPCLAW_CHAT_HISTORY_DIR` (see table above). If a history file is **not valid JSON** (or the root is not an array), it is **renamed aside** to a `*.corrupt-*.bak` file in the same folder and the chat starts with an empty thread. **`reminders.json`** is treated similarly when the file cannot be parsed as expected.

- **Docker**: bind-mount **`./agent-data` → `/app/agent-data`** so history, reminders, workspace, and logs survive rebuilds (or drop the volume for ephemeral data).
- **Clear memory**: ask in natural language (e.g. forget this chat / reset conversation / xóa hết nhớ) — the unified gate triggers **clear_memory**, wiping RAM + persisted history (and long-term memory for that chat when enabled), then one short model reply.
- **Media**: **text** as usual. **Photos** → Tesseract OCR + optional caption (defaults in table; Docker image includes English). **Voice** → faster-whisper in-container ([repo](https://github.com/SYSTRAN/faster-whisper)); **default is on** (always try transcribe). Set **`DEEPCLAW_VOICE_TRANSCRIPTION=off`** to disable, or **`auto`** to probe at startup and skip voice if Whisper is unavailable.
- **Video, bare documents, stickers** without caption → short hint; **caption on other media** is treated as text.

### Scheduled reminders (Telegram)

Reminders are always on: jobs are stored under **`<data-dir>/reminders.json`** (default **`./agent-data/reminders.json`** when `DEEPCLAW_DATA_DIR` is unset). The bot can store **recurring** reminders and send plain text at cron times (no tools, no full agent turn).

- **Create**: describe a schedule in natural language. **Recurring** (e.g. every day at 8am) uses a cron expression after you confirm. **One-shot** (e.g. “in 30 minutes” or “in 3 months”) stores a single fire time computed **when you confirm** (`fireInMinutes` from the model; no fixed maximum like one week). Long delays use chained timers so the process can wake the job after many days. The **unified gate** (one LLM call with reminder + planning routing) classifies the message; if it proposes a reminder, you get proposal text and inline buttons (labels and copy come from the model). Nothing is saved until you confirm. If you only say you **want** reminders with **no time** yet, the gate typically returns **clarify** so the model can ask for a concrete schedule in the user’s language.
- **List**: ask in natural language (e.g. “show my reminders”, “liệt kê nhắc nhở”) for this chat. The reply is **written by the model** from stored job facts (same timezone as below).
- **Delete**: say you want to cancel/remove/stop a reminder (any language). The same small classifier runs first with your current jobs as context; it can remove by **job id** or a **unique text match** on `reminderText`. Only reminders **you created in this chat** are affected. If nothing matches unambiguously, you get a short hint (often to list reminders first to see ids). This path is **not** the tool-using agent—it does not use `read_file` / shell on the JSON file.
- **Chat history**: list / clarify / propose / remove replies and inline confirm/cancel are **appended to the same persisted thread** as normal agent turns (when `DEEPCLAW_CHAT_HISTORY_DIR` is enabled), so later messages can refer to reminders you set up. Automated **fire** pings (cron/once delivery) are still not written into that history.
- **Timezone**: **`DEEPCLAW_TZ`** (IANA) — see table above; no `Intl` fallback beyond explicit zone or UTC.
- **Persistence**: jobs are kept in the JSON file (history is not auto-deleted). The bot must stay running for schedules to fire (**in-process `node-cron`**; no system `crontab` in the image). After restart, jobs are reloaded from the file.
- **Snooze**: when a reminder **fires** (or a **missed** one-shot is reported), the message includes **inline snooze** buttons (e.g. 10m / 1h / tomorrow) that schedule a **one-shot** follow-up in this chat.
- **Per-job timezone** (optional): stored jobs may include **`timeZone`** (IANA); cron scheduling uses that zone, falling back to **`DEEPCLAW_TZ`** when unset.
- **Missed one-shot reminders**: if a **once** job’s fire time is already in the past when the bot starts (e.g. it was offline), the bot sends a short **“Missed reminder”** notice with the reminder text, then disables that job in the file.
- **Single instance**: run **one** process (or replica) per bot token and shared `reminders.json`. Multiple processes can **double-send** reminders and race on the JSON file; the mutex is **in-process only**.

### Agent permissions: `DEEPCLAW_SAFE_MODE` only

| Value | Behavior |
|-------|----------|
| **Unset** or empty string | **Full** — `read_file` / `write_file` / `list_dir` / `grep_workspace` / `send_file` locked to **`<data-dir>/workspace`**; `run_shell` (cwd there, no absolute paths outside except `/dev/null`); `browse_web`, `send_image_url` |
| **`1`**, **`true`**, **`yes`**, **`on`** when set | **Safe** — same path sandbox for file tools; no `run_shell`, `browse_web`, or `send_image_url` |
| **`0`**, **`false`**, or any other set value that is not truthy above | **Full** (same as unset) |

The Docker image and `docker-compose` set **`DEEPCLAW_SAFE_MODE=0`** for an explicit full profile. When the variable is **unset** in the container environment, behavior is the same (**full** tools). Set **`DEEPCLAW_SAFE_MODE=1`** (or **`true`**) in `.env` if you want the read-only sandbox.

Legacy **`DEEPCLAW_CONTAINER_FULL_ACCESS`** is ignored if present. Shell timeouts use **`DEEPCLAW_SHELL_TIMEOUT_MS`** / **`DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS`** (see table above), not older unused env names.

## Local data layout

Under **`DEEPCLAW_DATA_DIR`**: `chat-history/`, **`workspace/`** (mandatory sandbox for **`read_file`**, **`write_file`**, **`list_dir`**, **`grep_workspace`**, **`send_file`**, **`git_*`**, **`run_tests`**, and **`run_shell` cwd** — not widened by **`DEEPCLAW_WORKSPACE`**), `logs/`, `reminders.json`, and optionally **`ltm/`** when **`DEEPCLAW_LONG_TERM_MEMORY`** is on. **`DEEPCLAW_WORKSPACE`** may still point at another directory for your own layouts, but agent file tools always use **`<data-dir>/workspace`**. Both directories are created on startup when they differ.

If you upgraded from an older layout, rename **`long-term-memory/`** or **`memory/`** to **`ltm/`** (or move the `chat_*.md` files) so existing per-chat notes stay visible.

**Upgrading from older defaults** (`./workspace`, `./logs` at repo root): move under `./agent-data/` or point `DEEPCLAW_WORKSPACE` / `DEEPCLAW_LOG_FILE` at the old paths.

## Prompts (loaded by default)

Shipped as **`prompts/personality.md`**. Override with **`DEEPCLAW_PERSONALITY_FILE`** if needed. If you still point **`DEEPCLAW_PERSONALITY_FILE`** at the old **`prompts/deepclaw.md`**, rename that file or update the env to **`prompts/personality.md`**.

## Tools

- **Full** (unset, or **`DEEPCLAW_SAFE_MODE=0`** / **`false`**, or explicit **`0`** in Docker): file tools and shell cwd are confined to **`<data-dir>/workspace`**; **`run_shell`** also rejects absolute paths outside that tree (except **`/dev/null`**). Tools: `read_file`, `write_file`, `list_dir`, `grep_workspace`, `send_file`, `git_status`, `git_diff_stat`, `run_shell`, `browse_web`, **`send_image_url`**, and (unless **`DEEPCLAW_RUN_TESTS_TOOL=0`**) **`run_tests`** (`npm test` / `pytest` in that workspace). The image includes common CLIs, Chromium, **ripgrep** (`rg`), **Tesseract** (English), **ffmpeg** + **faster-whisper** (`tiny`) for voice (see **Chat history (Telegram)** above).
- **`browse_web`**: literal **loopback or private/reserved IPs** in the URL are rejected. By default (**`DEEPCLAW_BROWSER_RESOLVE_DNS`** on), the hostname is **resolved** and the same private/reserved checks apply to the resolved address (stronger than URL-only checks). Optional **`DEEPCLAW_BROWSER_ALLOWLIST`**: when non-empty, only listed hostnames (and `*.subdomain` patterns) are allowed, in addition to those rules.
- **`send_image_url`** (full mode, with `browse_web`): downloads a **direct** JPEG/PNG/GIF/WebP URL after the same allowlist/SSRF/DNS checks as `browse_web`, then sends **`sendPhoto`** (one image) or a **Telegram media group** (two or more in the same turn, captions merged on the first). By default uses Node **`fetch`** with **`Referer`** (origin), **`Accept-Language`**, and up to **three** HTTP attempts (bot UA, then Chrome-like UA, then without `Referer` if still retryable). Set **`DEEPCLAW_SEND_IMAGE_FETCH_MODE=playwright`** or **`auto`** to use Chromium’s fetch for harder hosts. **`DEEPCLAW_IMAGE_FETCH_USER_AGENT`** overrides the first attempt’s UA. **Caption is required** (short, tied to the answer). Max **~10 MB** per image, **5** per turn. Many sites still block hotlinking or bots — prefer direct file URLs (e.g. `upload.wikimedia.org`); if **`DEEPCLAW_BROWSER_ALLOWLIST`** is set, the image host must be allowed. Not available in safe mode.
- **`run_shell`**: by default, only **heuristic risky** commands ask for **inline Telegram** confirmation (“Run command” / “Cancel”). Set **`DEEPCLAW_SHELL_APPROVAL=off`** to disable prompts entirely. Approval timeouts treat as cancel. Each run is also capped by **`DEEPCLAW_SHELL_TIMEOUT_MS`** (and a shorter **`DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS`** when the command looks like a foreground dev server); the shell process group is stopped when the limit is reached — use **`nohup`** / **`&`** for long-running servers (see env table).
- **Long-term memory**: **on by default** in full profile (unset); one Markdown file per chat under **`ltm/`** in the data dir. Set **`DEEPCLAW_LONG_TERM_MEMORY=0`** to turn off. Safe mode has no memory tools.
- **Safe** (**`DEEPCLAW_SAFE_MODE=1`** or **`true`** / **`yes`** / **`on`**): workspace tools only — `read_file`, `write_file`, `list_dir`, `grep_workspace`, `send_file` (no `run_shell` / `browse_web` / `send_image_url`).
- **`read_file`** / **`list_dir`** / **`grep_workspace`** / **`send_file`**: paths only under **`<data-dir>/workspace`** (same in safe and full mode).
- **`write_file`**: create/update UTF-8 text files only there (max ~4 MiB per write).
- **`list_dir`**: list directory entries (optional shallow recursive listing, capped).
- **`grep_workspace`**: search with ripgrep regex under allowed paths; output capped.
- **`send_file`**: queues a file to be sent as a **Telegram document** after the text reply (same path rules as `read_file`). The model must call this tool; describing a path in chat alone does not attach a file. Max 50 MB per file (Telegram limit).

## Security

Public bots can be abused — use `DEEPCLAW_ALLOWED_USER_IDS`. Full mode is powerful inside the container; deploy only in isolated environments and be careful when mounting host volumes.

## License

MIT
