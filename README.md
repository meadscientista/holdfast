# Holdfast

Holdfast keeps your AI coding session running when your internet drops. Normally, if the wifi blips mid-task, the tool's API request fails, the session freezes, and you have to come back and restart it by hand — Holdfast retries the failed request automatically until the network returns, so the session finishes on its own.

It works as a small proxy on `localhost`, sitting between your tool (Claude Code, Codex, other IDE agents) and the model API. When a request fails on a connection error, Holdfast holds it, checks for connectivity every 30 seconds, and replays it the moment you're back online. From the tool's side the request just took a little longer. Nothing to retype, nothing to resend.

It is deliberately not an MCP server, a plugin, or a skill. Anything living inside the model needs the network to function — exactly what's broken during a drop. Holdfast runs underneath as a plain background process, already awake before the connection ever fails. The label, if you want one: a local resilience proxy.

## What it does

- Sits on `localhost` and forwards your tool's API traffic to the real model API.
- On a network error, holds the in-flight request instead of failing the turn.
- Probes connectivity on an interval and replays the request the moment the connection is back.
- Sends invisible keep-alive pings during a hold so the client connection doesn't time out on long outages.
- Only retries genuine network failures. Real API responses (including 4xx/5xx) pass straight through, so a turn is never double-run.
- Streams responses through live — tokens arrive as the model produces them (SSE and AWS event-stream alike), so the screen never freezes waiting on a buffered blob. If the connection drops *before the first byte*, the request is held and replayed cleanly; a drop *after* streaming has begun is surfaced honestly rather than silently re-run (the client already holds a partial answer).
- Passes your API key or bearer token through untouched. It is never stored or logged.

## Requirements

Node 16 or newer. That's the whole list: no dependencies, no build step.

## Usage

Run it straight from GitHub with npx, from anywhere, on any machine:

```bash
npx -y github:ompandey98/holdfast start
```

The `-y` tells npx to fetch and run without a confirmation prompt, so this is always a single command.

Point your tool at it. For Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude
```

Drop that export line into your shell profile (`~/.zshrc` or `~/.bashrc`) and you can forget it's there. Use your tool exactly as before; Holdfast is an invisible pass-through until the moment the network drops, and then it earns its keep.

Prefer a copy on disk (to auto-start it, tweak it, or skip the re-fetch)?

```bash
git clone https://github.com/ompandey98/holdfast.git
cd holdfast
node bin/holdfast start
```

## Stopping it

From any terminal, on any system:

```bash
npx -y github:ompandey98/holdfast stop
```

If you cloned it, `node bin/holdfast stop` does the same. Or press `Ctrl-C` in the window where it's running. `stop` frees the port; if you installed the auto-start service it also stops the current process, though it will start again on next login (use `uninstall` to prevent that).

## Always-on

To have Holdfast start automatically on login:

```bash
node bin/holdfast install     # launchd (macOS), systemd (Linux), Task Scheduler notes (Windows)
node bin/holdfast status      # confirm it's running
node bin/holdfast uninstall   # remove auto-start
```

## Using it with other tools

Holdfast starts a listener for every supported provider automatically — Anthropic, OpenAI, Bedrock, and Kiro are all on by default. There is nothing to enable and nothing to declare about which tool or IDE you use: run the one command and every supported tool is protected. A listener is passive (just a localhost port that does nothing until a tool points at it), so running all of them costs nothing.

Holdfast routes by port. Each port maps to one upstream API; your tool chooses the port by which base URL you give it. The defaults are baked in, so they're the same on every machine.

| Tool | Setting to change | Point it at |
|---|---|---|
| Claude Code (Anthropic API) | `ANTHROPIC_BASE_URL` | `http://localhost:8787` |
| Claude Code (Bedrock mode) | `ANTHROPIC_BEDROCK_BASE_URL` + `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` | `http://localhost:8789` |
| Codex / OpenAI tools | OpenAI base URL or `OPENAI_BASE_URL` | `http://localhost:8788` |
| Kiro | `codewhisperer.config.krsEndpoints` in Kiro settings (see below) | `http://localhost:8790` |
| Other Anthropic tools | that provider's base URL field | `http://localhost:8787` |
| Anything else | its base URL / endpoint field | its matching port |

The base URL you give a tool must point at the port whose upstream matches that tool's provider. Anthropic tools go to the Anthropic port, OpenAI tools to the OpenAI port, Bedrock-mode tools to the Bedrock port.

### AWS Bedrock (Claude Code in Bedrock mode, Kiro)

Setups that talk to Claude through AWS Bedrock sign every request with AWS SigV4, and a signature is bound to the destination host — so a plain pass-through proxy would break it. Holdfast handles this properly: the Bedrock listener re-signs each request with your machine's own AWS credentials (environment or `~/.aws/credentials`, re-read every attempt so refreshed credentials are picked up mid-hold), which also means a request replayed after a long outage gets a fresh, valid signature instead of an expired one.

Point Bedrock-mode Claude Code at it like this:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_BEDROCK_BASE_URL=http://localhost:8789
export CLAUDE_CODE_SKIP_BEDROCK_AUTH=1   # Holdfast signs instead
claude
```

The Bedrock upstream region follows `AWS_REGION` (default `us-east-1`); override the endpoint entirely with `HOLDFAST_BEDROCK_UPSTREAM`, the port with `HOLDFAST_BEDROCK_PORT`, and the credentials profile with `HOLDFAST_AWS_PROFILE`.

### Kiro

Kiro does **not** go through Bedrock or the Anthropic API. Its agent chat streams through the Kiro Runtime Service — its client resolves to `https://runtime.<region>.kiro.dev` (default `us-east-1`; `eu-central-1` is the other commercial region) and authenticates with an SSO **bearer token**, not AWS SigV4. Holdfast passes that bearer through untouched, so this listener is a plain streaming pass-through (no re-signing). The Kiro listener runs by default on port `8790` — nothing to enable.

To route Kiro through it you point Kiro's endpoint at the listener. Kiro's client sets its endpoint explicitly, so — unlike Bedrock — the `AWS_ENDPOINT_URL` environment variable is **ignored** by it, and setting that variable globally would wrongly redirect *other* AWS tools (including Claude Code in Bedrock mode). The correct, Kiro-only hook is Kiro's own trusted endpoint setting. In Kiro's `settings.json`:

```json
"codewhisperer.config.krsEndpoints": [
  { "region": "us-east-1", "endpoint": "http://localhost:8790" }
]
```

This affects only Kiro and cannot touch any other tool. Match the `region` to the one Kiro is using. Override the upstream Holdfast forwards to with `HOLDFAST_KIRO_UPSTREAM`, the region with `HOLDFAST_KIRO_REGION`, and the port with `HOLDFAST_KIRO_PORT`. (The endpoint host, bearer auth, and env-var precedence are traced from the Kiro agent extension; confirm the `krsEndpoints` redirect against your Kiro build, as the setting is read dynamically rather than declared in the extension manifest.)

All four listeners (Anthropic, OpenAI, Bedrock, Kiro) run by default. To replace that set entirely — fewer, more, or custom providers — define your own:

```bash
export HOLDFAST_LISTENERS='[
  {"name":"anthropic","port":8787,"upstream":"https://api.anthropic.com"},
  {"name":"openai","port":8788,"upstream":"https://api.openai.com"}
]'
node bin/holdfast start
```

If a port is already taken, that one listener is skipped with a warning and the rest keep running — a busy port (usually Holdfast already running there) never fails the others or the process. Change any default port with its `HOLDFAST_*_PORT` variable.

## Hold duration

Defaults to 60 minutes. Override per run or via environment:

```bash
node bin/holdfast start --minutes 30
```

## Commands

| Command | Description |
|---|---|
| `holdfast start [--minutes N] [--port P]` | start the proxy (default command) |
| `holdfast stop` | stop the running proxy and free the port |
| `holdfast stats` | lifetime counters: drops caught, sessions saved, per provider and per tool |
| `holdfast status` | report each listener |
| `holdfast install` | auto-start on login |
| `holdfast uninstall` | remove auto-start |
| `holdfast help` | show help |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOLDFAST_HOLD_MINUTES` | `60` | how long to keep holding |
| `HOLDFAST_RETRY_INTERVAL_MS` | `30000` | connectivity probe interval |
| `HOLDFAST_HEARTBEAT_MS` | `15000` | keep-alive ping interval |
| `HOLDFAST_PORT` | `8787` | Anthropic listener port |
| `HOLDFAST_OPENAI_PORT` | `8788` | OpenAI listener port |
| `HOLDFAST_OPENAI_UPSTREAM` | `https://api.openai.com` | full OpenAI endpoint override |
| `HOLDFAST_BEDROCK_PORT` | `8789` | Bedrock listener port |
| `HOLDFAST_BEDROCK_UPSTREAM` | regional bedrock-runtime | full Bedrock endpoint override |
| `HOLDFAST_AWS_PROFILE` | `default` | AWS credentials profile used for signing |
| `HOLDFAST_KIRO_PORT` | `8790` | Kiro listener port |
| `HOLDFAST_KIRO_REGION` | `us-east-1` | KRS region (`us-east-1` / `eu-central-1`) |
| `HOLDFAST_KIRO_UPSTREAM` | `runtime.<region>.kiro.dev` | full Kiro endpoint override |
| `HOLDFAST_LISTENERS` | all four (Anthropic, OpenAI, Bedrock, Kiro) | JSON array to replace the default set |
| `HOLDFAST_LOG_FILE` | `~/.holdfast/holdfast.log` | log location |

## Scope

Holdfast handles connection-level failures: dropped or switched networks, DNS failures, connection resets, refused connections, and timeouts, including repeated drops within a single turn and outages up to the configured window.

A drop *before* the first response byte is held and replayed cleanly. A drop *partway through* an already-streaming response is not re-run — the client is holding a partial answer, so replaying would double-run the turn; that case is surfaced honestly instead.

It does not cover: the model API itself being down or returning errors (passed through as-is), expired or invalid API keys (passed through so you can see them), or a machine that is fully powered off. If a tool enforces a hard per-request time limit, the keep-alive pings defeat idle timeouts but cannot override that limit.

## Testing

```bash
node test/integration.js
node test/streaming.js
```

`integration.js` simulates an upstream outage and confirms the request is held, kept alive with heartbeats, and delivered once connectivity returns, plus a normal pass-through request. `streaming.js` confirms live streaming (tokens arrive as produced, not buffered), that a pre-first-byte drop is still held and replayed on the streaming path, that an AWS event-stream response streams live with its bearer token passed through untouched, and that the Kiro listener forwards live with the bearer preserved and Host rewritten to the upstream. It also confirms that a busy port is skipped without taking down the other listeners.

## Seeing what it's done

The running terminal logs every event as it happens: each request, each disconnect it catches, each probe, and a `SAVED` line with a running tally when a session is recovered. The same log goes to `~/.holdfast/holdfast.log`. For lifetime numbers across restarts, `holdfast stats` prints drops caught, sessions saved, give-ups, and total time held, broken down by provider and by client tool.

## License

Apache License 2.0. See [LICENSE](LICENSE).
