# dsh-anchored-standard

[中文说明](./README.zh-CN.md)

An experimental DeepSeek Harness agent preset that bootstraps the first model
request with a Minimal-aligned prompt, two tools, and no auto-injected
workspace/skill context, then exposes the complete Standard tool catalog after
the first durable tool call or reply.

This is a community project. It is not an official DeepSeek preset and is not
affiliated with or endorsed by DeepSeek.

## Why

DeepSeek V4 Pro conditions strongly on the API-visible tool catalog. In the
Project2 evaluation, Standard and PTC produced scores of 91 and 92, while the
official Minimal preset produced 99 and 96. Permanently staying on Minimal,
however, gives up the Standard preset's broader tool set.

Anchored Standard separates initial trajectory selection from later tool use:

1. Keep the Minimal complete system prompt.
2. Expose only the platform shell plus `read` on the first model request.
3. Strip the auto-injected context on that first request as well — the
   AGENTS.md/CLAUDE.md workspace digest and the available-skills reminder that
   true Minimal never mounts (`suppressedContextSources` in the
   `tool-bootstrap` row). User-initiated skill gestures are not filtered, and
   both injections return unchanged from request #2 on.
4. After the session records its first durable promotion signal — a `tool/call`
   or the first `assistant/message`, whichever comes first — expose all
   Standard tools. Request #1 always sees the bootstrap catalog; request #2
   always sees the full catalog, so a text-only first reply can no longer trap
   the session in bootstrap. (`promoteOn` in the `tool-bootstrap` row selects
   the trigger: `either` default, `tool-call`, or `assistant-message`.)
5. Derive the phase from durable session events so resume and reload preserve it.

On Windows the bootstrap catalog is `pwsh/read`; on Linux it is `bash/read`.

## Results

Project2 V4.1b, DeepSeek V4 Pro, `reasoningEffort=max`, Windows native:

| Run | Ability | Reasoning blocks | `we` | `let's` | `let me` | Visible replies |
|---|---:|---:|---:|---:|---:|---:|
| r1 | 98 | 193 | 179 | 88 | 1 | 1 |
| r2 | 99 | 162 | 165 | 98 | 0 | 1 |

Both runs emitted exactly two tool-catalog snapshots: two bootstrap tools,
followed by the 25-tool Standard catalog. The result is reproducible evidence
for this task, not a claim of universal improvement across models or workloads.

Full methodology and aggregate evidence are in
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest).

## Compatibility

Developed and tested against:

- DeepSeek Harness `0.1.0-rc.5`
- repository commit [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
- Node.js 24 on Windows

DeepSeek Harness is currently a developer preview and explicitly permits
breaking changes. This preset is a full snapshot of the Standard composition,
so review upstream changes before using it with a newer release.

## Install

Clone this repository, then copy the entire `preset` directory into the user
preset root under the id `anchored-standard`.

PowerShell:

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\anchored-standard'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\preset' -Destination $target
```

Linux/macOS:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/anchored-standard"
cp -R preset "$dsh_home/.agent-presets/anchored-standard"
```

Fully restart DeepSeek Harness, create a blank session, and select
**Anchored Standard (experimental)**. Do not switch an active session from a
different preset.

## Verify

Export the session JSONL and inspect `request/header` events:

- the first header should contain only `pwsh/read` or `bash/read`;
- the first request's messages should contain no AGENTS.md/CLAUDE.md digest and
  no available-skills reminder — only the user message and the minimal persona
  system prompt;
- after the first tool call or the first assistant reply, the next changed
  header should contain the full Standard catalog;
- subsequent requests should keep that full catalog and restore the standard
  context injections.

Run the local zero-dependency tests with:

```sh
npm test
```

## Important behavior

- With the default `promoteOn: either`, the session promotes after its first
  durable `tool/call` OR its first `assistant/message`, whichever comes first —
  request #1 sees the bootstrap catalog and every later request sees the full
  catalog. A text-only first reply therefore still promotes at request #2;
  set `promoteOn: tool-call` to restore the original behavior, where a first
  response that makes no tool call never promotes.
- A failed tool execution still promotes the session because the durable
  `tool/call` already exists.
- A missing bootstrap tool degrades to the full catalog with a one-time
  warning instead of failing requests, so a composition drift cannot brick a
  session; invalid `promoteOn` values fail at preset mount instead.
- Promotion decisions are memoized per session for the process lifetime; the
  durable event scan runs once per session per process.
- While a session is unpromoted, the pre-step filter strips messages whose
  `source.kind` is listed in `suppressedContextSources` (default:
  `agent-instructions` and `skill-catalog`, the two automatic injections
  Standard adds over Minimal). Set the list to `[]` to disable the context
  filter; add other `source.kind` values to suppress more. A filter failure
  degrades to keeping every message rather than eating context.
- The tool catalog changes once, so request-prefix cache continuity also changes
  once between the first and second model requests.
- The preset has the same trust level as shell access. Review its files before
  installation.
- The plugin performs no network requests and adds no telemetry.

## Zero-Anchored Standard (experimental)

An extra test mode that does not change the Anchored Standard logic above. It
uses the same Minimal-aligned system prompt, but instead of exposing two tools
on the first request it injects one fixed zero-tool anchor turn:

1. When the user sends their first message, the `anchor-turn` plugin prepends a
   fixed user message — "This round is a test. Tools are not open yet; all
   tools will open next round." — ahead of it.
2. The first real model request carries ZERO tools, so the session's first
   reasoning chain follows the zero-injection "we" trajectory.
3. Once that anchor response is durable, the full Standard catalog is exposed
   and the real message proceeds with all tools.

Anchoring on the first message — not on session creation — keeps the
blank-session preset switcher usable. Subagents always see the full catalog.

Measured behavior (opencode-go, DeepSeek V4 Pro, `reasoningEffort=max`): the
anchor request is stable "we"-style with zero `let me`; the following
tool-bearing requests return to the "The user wants…/Let me" style. This mode
is a comparison point for whether the zero-tool first turn is worth the extra
model call — not a claim that tool rounds stay "we"-style.

Install as a separate preset id:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/zero-anchored-standard"
cp -R zero-anchored-standard "$dsh_home/.agent-presets/zero-anchored-standard"
```

Restart DeepSeek Harness, create a blank session, select **Zero-Anchored
Standard (experimental)**, then send your first message.

## Official ecosystem guidance

DeepSeek currently asks community plugin authors to publish plugins in their own
GitHub projects and add the [`dsh-plugin`](https://github.com/topics/dsh-plugin)
repository topic for discovery. The official repository does not currently
accept external pull requests and does not mandate a community repository
template. See the official
[`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/CONTRIBUTING.md).

## License

MIT. `preset/agent.cordis.yml` is derived from the DeepSeek Harness Standard
preset; the original DeepSeek copyright and MIT notice are retained in
[`NOTICE`](./NOTICE).
