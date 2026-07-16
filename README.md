# Holdfast

> Keep your AI-coding session alive through any network drop — no more typing "continue".

When your wifi flips (office → hotspot), your VPN reconnects, or you lose signal
while commuting, your AI coding tool's request to the API dies and the whole turn
freezes. You come back later and everything's broken — even though your laptop and
internet were fine except for one short blip. Today your only fix is to type
"continue" and hope.

**Holdfast makes that unnecessary.** It's a tiny local proxy that sits between your
AI tool and the model API. It absorbs network drops so your session never dies.

```
┌──────────────────┐      ┌──────────────────────┐      ┌───────────────────┐
│ Claude Code /     │ ───► │  Holdfast (localhost) │ ───► │  model API        │
│ Codex / Kiro / …  │ ◄─── │  hold · probe · replay│ ◄─── │  (Anthropic/…)    │
└──────────────────┘      └──────────────────────┘      └───────────────────┘
   never-breaking             absorbs the outage            the flaky link
   localhost socket
```

## Why this works (the one idea that matters)

Your AI tool normally connects **straight to the API**. When wifi flips, *that*
socket breaks and the turn errors out.

With Holdfast, your tool connects to **`localhost` — a connection inside your own
laptop that never breaks**, no matter how many times wifi drops or switches. Only
Holdfast's connection to the API breaks, and Holdfast absorbs it: it holds your
request, probes every 30s (for as long as you configure), and the instant the
network returns it replays the request and streams the answer back down the still-
alive localhost socket.

**You never type "continue" — because the turn never dies in the first place.**
That's strictly better than automating the keystroke.

During a long outage, Holdfast also sends invisible keep-alive "heartbeats" to your
tool so its connection can't idle out. This is what lets a 20–30 minute outage
survive.

## Requirements

- **Node.js 16+.** Nothing else.
- **Zero dependencies** — pure Node standard library. No `npm install`, no build,
  no native modules. Identical on macOS, Linux, Windows.

## Quick start

```bash
git clone <your-repo-url> holdfast
cd holdfast

# 1. Turn it on permanently (auto-starts on every login, stays running):
node bin/holdfast install

# 2. Point your AI tool at it (one-time, add to your shell profile):
export ANTHROPIC_BASE_URL=http://localhost:8787   # Claude Code

# 3. Use your tool exactly as before. That's it.
claude
```

Check it's alive anytime:

```bash
node bin/holdfast status
```

If you'd rather not auto-start, just run `node bin/holdfast start` in a spare
terminal whenever you work.

## Setting the hold duration

```bash
node bin/holdfast start --minutes 60     # hold up to 1 hour  (default)
node bin/holdfast start --minutes 30     # hold up to 30 min
node bin/holdfast start --minutes 120    # hold up to 2 hours
```

Or set `HOLDFAST_HOLD_MINUTES` in the environment (works with auto-start too).

## Using it with any IDE / tool (not just Claude Code)

Holdfast routes **by port** — one port per provider. Any tool that lets you
override the API base URL can be protected. Point the tool's base-URL setting at
the matching Holdfast port:

| Tool                         | What to set                              | Point it at             |
|------------------------------|-------------------------------------------|-------------------------|
| Claude Code                  | `ANTHROPIC_BASE_URL`                      | `http://localhost:8787` |
| OpenAI Codex / OpenAI tools  | OpenAI base URL / `OPENAI_BASE_URL`       | `http://localhost:8788` |
| Kiro / other Anthropic tools | provider base URL / endpoint setting      | `http://localhost:8787` |
| Any other                    | that provider's base-URL / endpoint field | its matching port       |

To protect several providers at once, configure multiple listeners:

```bash
export HOLDFAST_LISTENERS='[
  {"name":"anthropic","port":8787,"upstream":"https://api.anthropic.com"},
  {"name":"openai","port":8788,"upstream":"https://api.openai.com"}
]'
node bin/holdfast start
```

Holdfast forwards each request to the right upstream and applies the same
hold-and-replay logic to all of them. Your API keys pass through untouched and are
never stored or logged.

## What a drop looks like (from the log)

```
[anthropic] POST /v1/messages — request in-flight
[anthropic] network error (ECONNRESET) — entering hold (heartbeat on)
[anthropic] probe 1/120 … no network
[anthropic] probe 2/120 … no network
   … (wifi switching, commuting, VPN reconnecting) …
[anthropic] probe 7/120 … BACK ONLINE — replaying
[anthropic] response relayed ✓  (held 214s, session intact)
```

Live log lives at `~/.holdfast/holdfast.log`.

---

## What kinds of "broken internet" can it survive?

**✅ Handles these fully — session continues on its own:**

| Situation | Why it's covered |
|---|---|
| Wifi flip (office → hotspot → office) | localhost socket never breaks; Holdfast re-probes and replays |
| Short blips (2–60 seconds) while commuting | held and replayed the moment signal returns |
| Longer outages (5, 10, 20, 30 min) | heartbeats keep the tool's socket alive; replays on return, up to your `--minutes` window |
| VPN drop / reconnect | just another network error → held and retried |
| DNS failures (`ENOTFOUND`, `EAI_AGAIN`) | classified as network errors → held |
| Connection reset / refused / timeout (`ECONNRESET`, `ETIMEDOUT`, …) | classified as network → held |
| Laptop briefly loses then regains signal | Holdfast keeps probing the whole window |
| Multiple drops in one turn | each drop re-enters the hold loop; keeps going |

**⚠️ Partially / depends:**

| Situation | Reality |
|---|---|
| **Laptop lid closed / sleep** | If the OS suspends the process, timers pause. On wake, Holdfast resumes probing and can still recover **if within the hold window and the IDE hasn't already given up**. Keep "prevent sleep on lid close while plugged in" on (macOS: `caffeinate`, or Amphetamine) for best results. Holdfast keeps the *network* side alive; it can't stop the OS from suspending the whole machine. |
| **Outage longer than your `--minutes`** | After the window elapses, Holdfast surfaces a real error (nothing more it can do). Set a longer window if your commute has long dead zones. |
| **IDE has a hard per-request wall-clock cap** | Some tools abort *any* request past N minutes regardless of activity. Heartbeats defeat *idle* timeouts but cannot override a hard cap. Most tools don't have one; if yours does, that single turn may still end. |

**❌ Cannot help with (out of scope):**

| Situation | Why |
|---|---|
| The model API itself being down / returning 5xx | That's a real API answer, not a network drop — Holdfast passes it through untouched (retrying could double-run your turn). |
| Your API key expiring / auth errors (401/403) | Real API responses; passed through so you can see and fix them. |
| Laptop fully powered off / crashed | Nothing running can help; the process is gone. |
| Losing the *content* already generated before a mid-turn drop | Holdfast preserves the **turn**, not partial tokens. On recovery the request is replayed cleanly (buffer-then-replay), so you get a complete answer — but a half-streamed answer from before the drop is discarded rather than stitched. |

### Robustness guarantees baked in
- **Never double-runs a turn:** only *network* errors are retried; anything the API
  actually answered (2xx/4xx/5xx) is returned as-is.
- **Never leaves a half-response:** the full upstream response is buffered before a
  byte reaches your tool, so a mid-stream drop always replays cleanly.
- **Never idles out:** heartbeats hold the client connection open through long waits.
- **Cheap probing:** between retries it opens a bare TCP connection, not a full
  (billable, side-effecting) API call.

## Commands

| Command | Does |
|---|---|
| `holdfast start [--minutes N] [--port P]` | start the proxy (default command) |
| `holdfast status` | check every listener |
| `holdfast install` | auto-start on login (launchd / systemd / Task Scheduler) |
| `holdfast uninstall` | remove auto-start |
| `holdfast help` | help |

## Configuration (env vars, all optional)

| Var | Default | Meaning |
|---|---|---|
| `HOLDFAST_HOLD_MINUTES` | `60` | how long to keep holding |
| `HOLDFAST_RETRY_INTERVAL_MS` | `30000` | probe interval |
| `HOLDFAST_HEARTBEAT_MS` | `15000` | keep-alive ping interval |
| `HOLDFAST_PORT` | `8787` | default Anthropic listener port |
| `HOLDFAST_LISTENERS` | (Anthropic only) | JSON array for multi-provider |
| `HOLDFAST_LOG_FILE` | `~/.holdfast/holdfast.log` | log path |

## Test

```bash
node test/integration.js
```

Simulates a held streaming request through an outage (asserting heartbeats fire and
the real response arrives) plus a normal online request.

## License

MIT
