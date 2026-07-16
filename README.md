# Holdfast

A network hiccup shouldn't kill a good session. Holdfast makes sure it doesn't.

It's a small local proxy that sits between your AI coding tool (Claude Code, Codex, other IDE agents) and the model API. When a request dies because the connection dropped, Holdfast catches it, hangs onto the request, waits for the network to come back, and quietly replays it. The turn picks up on its own. Nothing to retype, nothing to resend.

It is deliberately not an MCP server, a plugin, or a skill. Anything that lives inside the model needs the network to do its job, which is exactly the wrong moment to depend on the network. Holdfast runs underneath all that as a plain background process, so it's already awake and doing its job before the connection ever drops. If you need a label: it's a local resilience proxy.

## What it does

- Sits on `localhost` and forwards your tool's API traffic to the real model API.
- On a network error, holds the in-flight request instead of failing the turn.
- Probes connectivity on an interval and replays the request the moment the connection is back.
- Sends invisible keep-alive pings during a hold so the client connection doesn't time out on long outages.
- Only retries genuine network failures. Real API responses (including 4xx/5xx) pass straight through, so a turn is never double-run.
- Buffers the full response before sending it on, so a mid-stream drop always replays into a complete answer rather than a truncated one.
- Passes your API key through untouched. It is never stored or logged.

## Do you need it?

If you only ever use Claude Code, you might not. Claude Code has a built-in watchdog: set `CLAUDE_CODE_RETRY_WATCHDOG=1` and it retries transient failures for roughly three hours on its own. For a single-tool setup that covers most of what Holdfast does.

Holdfast earns its place when that isn't enough:

- **You use more than one tool.** The watchdog flag is Claude Code only. Codex, Kiro, and other agents don't have an equivalent. Holdfast protects anything that lets you set a base URL, so one setup covers all of them.
- **You want one place to configure it.** Point every tool at localhost and manage the behavior here, instead of chasing per-tool flags that may or may not exist.
- **You want a predictable retry cadence** rather than an undocumented backoff curve.

No magic, no lock-in. If the built-in flag is all you need, use that.

## Requirements

Node 16 or newer. That's the whole list: no dependencies, no build step.

## Usage

Run it straight from GitHub with npx, from anywhere, on any machine:

```bash
npx -y github:meadscientista/holdfast start
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
git clone https://github.com/meadscientista/holdfast.git
cd holdfast
node bin/holdfast start
```

## Stopping it

From any terminal, on any system:

```bash
npx -y github:meadscientista/holdfast stop
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

If a port is already taken, Holdfast says so on startup instead of failing silently. Pick another with `--port` and point your tool there.

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

Apache License 2.0. See [LICENSE](LICENSE).
