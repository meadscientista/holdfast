# Holdfast

Holdfast is a local proxy that keeps AI coding sessions alive across network interruptions. It sits between your tool (Claude Code, Codex, and other IDE agents) and the model API. When a request fails because the connection dropped, Holdfast holds the request, waits for connectivity to return, and replays it automatically. The session continues on its own, with no need to retype or resend.

It is not an MCP server, a plugin, or a skill. It runs as a standalone background process, so it keeps working even when the network (the thing an in-model helper would depend on) is down. The accurate term for it is a local resilience proxy.

## What it does

- Sits on `localhost` and forwards your tool's API traffic to the real model API.
- On a network error, holds the in-flight request instead of failing the turn.
- Probes connectivity on an interval and replays the request the moment the connection is back.
- Sends invisible keep-alive pings during a hold so the client connection doesn't time out on long outages.
- Only retries genuine network failures. Real API responses (including 4xx/5xx) pass straight through, so a turn is never double-run.
- Buffers the full response before sending it on, so a mid-stream drop always replays into a complete answer rather than a truncated one.
- Passes your API key through untouched. It is never stored or logged.

## Requirements

Node 16 or newer. No dependencies, no build step.

## Usage

Run it directly with npx, from anywhere, on any system:

```bash
npx github:meadscientista/holdfast start
```

Point your tool at it. For Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude
```

Add that export line to your shell profile (`~/.zshrc` or `~/.bashrc`) to make it permanent. Use the tool normally; Holdfast is a transparent pass-through until the network actually drops.

Prefer a local copy (to auto-start, edit, or avoid re-fetching)?

```bash
git clone https://github.com/meadscientista/holdfast.git
cd holdfast
node bin/holdfast start
```

## Stopping it

From any terminal, on any system:

```bash
npx github:meadscientista/holdfast stop
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

Holdfast routes by port. Each port maps to one upstream API; your tool chooses the port by which base URL you give it. The defaults are baked in, so they're the same on every machine.

| Tool | Setting to change | Point it at |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` | `http://localhost:8787` |
| Codex / OpenAI tools | OpenAI base URL or `OPENAI_BASE_URL` | `http://localhost:8788` |
| Other Anthropic tools | that provider's base URL field | `http://localhost:8787` |
| Anything else | its base URL / endpoint field | its matching port |

The base URL you give a tool must point at the port whose upstream matches that tool's provider. Anthropic tools go to the Anthropic port, OpenAI tools to the OpenAI port.

Run multiple providers at once by defining listeners:

```bash
export HOLDFAST_LISTENERS='[
  {"name":"anthropic","port":8787,"upstream":"https://api.anthropic.com"},
  {"name":"openai","port":8788,"upstream":"https://api.openai.com"}
]'
node bin/holdfast start
```

If a port is already in use, Holdfast reports it on startup. Pick another with `--port` and point your tool there.

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
| `HOLDFAST_PORT` | `8787` | default Anthropic listener port |
| `HOLDFAST_LISTENERS` | Anthropic only | JSON array to run multiple providers |
| `HOLDFAST_LOG_FILE` | `~/.holdfast/holdfast.log` | log location |

## Scope

Holdfast handles connection-level failures: dropped or switched networks, DNS failures, connection resets, refused connections, and timeouts, including repeated drops within a single turn and outages up to the configured window.

It does not cover: the model API itself being down or returning errors (passed through as-is), expired or invalid API keys (passed through so you can see them), a machine that is fully powered off, or reconstructing a partially streamed response from before a drop (the request is replayed cleanly instead). If a tool enforces a hard per-request time limit, the keep-alive pings defeat idle timeouts but cannot override that limit.

## Testing

```bash
node test/integration.js
```

Simulates an upstream outage and confirms the request is held, kept alive with heartbeats, and delivered once connectivity returns, plus a normal pass-through request.

## License

MIT
