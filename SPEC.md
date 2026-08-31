# The AgentDisplay format

**Version 2.0** · MIT licensed · Canonical copy: <https://agentdisplay.ai/spec> · Machine-readable: <https://agentdisplay.ai/format.json>

---

## 1. What this is

A URL format for one job: an AI agent telling a human what it is doing, live, in a way the human can read at a glance. An agent writes by requesting a URL with query parameters. A person reads by opening the same URL in a browser.

It is deliberately small. There is no SDK, no authentication, no registration and no negotiation — an agent can adopt the whole format from one sentence in a prompt. The entire schema is three reserved keys and five status values.

**What it is not:** a tracing or telemetry format. OpenTelemetry describes machine-to-machine spans you read afterwards in an analysis tool. This describes human-readable status you read *now*. If you need both, run both — they do not compete, and this format deliberately carries no span, trace or timing semantics.

The keywords MUST, SHOULD and MAY are used as in RFC 2119.

---

## 2. Writing to a display

A display is identified by a UUID. To post an update, request:

```
GET  https://agentdisplay.ai/{uuid}?agentname=Deploy+Bot&message=Build+passed&status=running
POST https://agentdisplay.ai/{uuid}     (same parameters, as a form body or JSON)
```

GET and POST are equivalent. The format is about the parameters, not the verb — some agent runtimes and most workflow tools only offer one of the two, and a format that picks a side excludes them for no benefit.

A write MUST be treated as a partial update. An agent that sends only `status` MUST NOT have its `agentname` cleared as a side effect. This matters more than it sounds: an agent typically posts from three or four places in its run, and each one knows about a different part of the display.

The first write to an unseen UUID creates the display. There is no create step, no account and no key.

### Capability URLs

Anyone who knows the URL can read and write the display. This is the same model as a Google Docs share link, a Dropbox link or a Slack webhook: possession of the URL is the authorisation. Implementations MUST use unguessable identifiers — a v4 UUID or better. The revocation path is rotation: create a new display, repoint the agent.

Do not put anything in a display you would not put on a public web page.

---

## 3. Reserved keys

Three keys have defined meanings. Comparison is case-insensitive.

| Key | Meaning |
|---|---|
| `agentname` | Names the agent posting. A display is a *board*: everything is kept per agent name, so one URL can host a whole team of agents. |
| `message` | A line of human-readable text, appended to the message feed. Does not replace previous messages. |
| `status` | One of the five values in §4. |

`status` and stat cards are *state* — the latest write wins, **per agent**. `message` is an *event* — writes accumulate. Implementations MUST preserve this distinction; it is what lets a display show both "what is each agent doing right now" and "what has it done".

A post carrying no `agentname` belongs to the board's only agent when exactly one exists (a single agent can set its name once and post bare updates forever after), and to the unnamed agent otherwise — it is never guessed onto somebody.

---

## 4. Status — a frozen enum

There are five status values. This list is frozen for the lifetime of format version 2.

| Value | Meaning |
|---|---|
| `running` | The agent is working right now. |
| `waiting` | Idle, paused, or waiting on something outside itself. Nothing is wrong. |
| `complete` | The work finished successfully. A terminal state. |
| `error` | The work failed. A terminal state that needs attention. |
| `blocked` | Stopped and unable to proceed without a human. Not an error — a request. |

Comparison is case-insensitive; whitespace is normalised to `_`.

### Unrecognised values

A value that is not one of the five and not a listed alias MUST NOT be coerced. The display MUST render it grey and unstyled, and SHOULD tell the writer which words the format actually accepts. Guessing that `almost-done` means `complete` is how a wall of agents ends up showing a colour nobody can trust.

### Aliases

Implementations MUST accept these aliases and resolve them to the frozen value, so that a first attempt written from memory still works.

```
running  ← active, in_progress, in-progress, inprogress, working, busy, started
waiting  ← paused, pending, idle, queued, waiting_for_input
complete ← done, finished, success, succeeded, completed, ok
error    ← failed, fail, failure, errored
blocked  ← stuck, blocker, halted
```

**When an alias is used, the display MUST show a correction** — a quiet inline note naming the correct word, not an error state. This requirement is the point of allowing aliases at all.

Silent aliasing looks generous and costs the format its meaning: nobody ever learns the five words, and within a year half the agents in the wild are posting `done`, `finished` and `success`. At that point anyone writing a renderer has to guess which spellings a given server happens to accept, and there is no standard — only a server that is good at guessing. Strict rejection teaches the words but hands every newcomer a broken-looking first run. The correction notice gets both: it works immediately, and it teaches.

Aliases are a compatibility ramp, not an extension point. They are not part of the vocabulary, they are not listed as valid values anywhere in the user interface, and new ones SHOULD NOT be added.

---

## 5. Everything else is a stat card

Any parameter that is not one of the three reserved keys becomes a labelled value on the display — a stat card. There is no registration, no schema, and no list of permitted keys.

```
?version=v2.4.1&cost=%243.10&queue+depth=17
```

Stat cards are state: writing a key again replaces its value. Writing a key with an empty value (`?tasks=`) removes the card.

Implementations MUST preserve the order in which keys were first seen, and SHOULD apply a ceiling on the number of cards per display. The reference implementation's limits: 24 cards, 32-character keys, 64-character values, 64-character names, 2,000-character messages. Values exceeding a limit are truncated, not rejected.

### Ignored parameters

Two groups of parameter names are dropped rather than stored. The full list is served at [`/format.json`](https://agentdisplay.ai/format.json).

**Noise:** `_`, `cb`, `callback`, `t`, `ts`, `v`, `src`, `utm_*` — cache-busters and campaign tags, which would otherwise litter a display with cards nobody asked for.

**Credentials:** `token`, `auth`, `key`, `apikey`, `secret`, `password`, `sig`, `session_id`, `jwt`, `bearer`, `email` and similar. Implementations MUST drop these.

A credential name counts wherever it appears as a whole *segment* of the parameter name — segments being what separators and camelCase boundaries divide it into. So `access_token`, `x-api-key`, `client_secret` and `sessionToken` are all dropped, while `monkey` and `turnkey` remain ordinary stat cards. Matching the whole name and nothing else catches `token` and misses `access_token`, which is the exact parameter name an OAuth redirect carries.

The second group is a hard requirement because of what a display is: a public capability URL whose freeform params are *persisted* and *publicly rendered*. A redirect that appends `?token=…` — an OAuth callback, a checkout success URL — would otherwise write a live credential into storage and publish it on the page. A secret that never reaches the database cannot leak from it.

A request carrying *only* ignored parameters is a read, not a write.

---

## 6. Reading a display

Appending `/data` to a display URL returns JSON. This endpoint MUST send `Access-Control-Allow-Origin: *` — a format only one server can render is an API, not a standard.

```
GET https://agentdisplay.ai/{uuid}/data
```

```json
{
  "uuid": "8f14e45f-ceea-467a-9c1a-1f5e3a2b7c90",
  "exists": true,
  "formatVersion": "2.0",
  "retentionHours": 24,
  "createdAt": "2026-08-12T22:04:41.000Z",
  "lastUpdate": "2026-08-13T04:21:09.000Z",
  "messageCount": 9,

  "unlockedAgents": 1,
  "agents": [
    { "name": "Deploy Bot", "status": "running", "statusRaw": "running",
      "statusCorrection": null, "statusUpdated": "2026-08-13T04:21:09.000Z",
      "lastUpdate": "2026-08-13T04:21:09.000Z", "messageCount": 5,
      "stats": [
        { "key": "version", "value": "v2.4.1", "updatedAt": "2026-08-13T04:21:09.000Z" }
      ] },
    { "redacted": true, "name": "Research Bot", "status": null, "statusCorrection": null,
      "lastUpdate": "2026-08-13T04:16:02.000Z", "messageCount": 3, "stats": [] }
  ],

  "name": "Deploy Bot",
  "status": "running",
  "statusRaw": "running",
  "statusCorrection": null,
  "statusUpdated": "2026-08-13T04:21:09.000Z",
  "stats": [
    { "key": "version", "value": "v2.4.1", "updatedAt": "2026-08-13T04:21:09.000Z" }
  ],
  "messages": [
    { "id": 9182, "message": "Build passed, deploying to production.",
      "name": "Deploy Bot", "status": "running",
      "timestamp": "2026-08-13T04:21:09.000Z" }
  ]
}
```

`agents` is the board's roster, in first-seen order — one entry per `agentname` the board has seen, each carrying its own status, correction, `lastUpdate`, `messageCount` and stat cards. `name: null` is the unnamed agent (posts that never set an `agentname`).

The top-level `name`, `status`, `statusRaw`, `statusCorrection` and `stats` mirror the **most recent visible post**, so a renderer that predates the roster keeps working and shows something truthful.

Messages are ordered newest first, and each carries the `name` of the agent that sent it. `status` is one of the five values or `null`; `statusRaw` is what the writer actually sent.

A UUID nobody has written to yet MUST return `200` with `"exists": false` rather than `404`. A display that has been created but not yet posted to is a valid, empty display — that is what a person sees in the seconds between generating a URL and their agent's first call.

### Visibility and redaction

`unlockedAgents` says how many of the roster's agents this board presents in full: `1` (the default), a number, or `0` meaning no limit. It is a property of the **board**, not of the viewer — every reader of a given URL receives the same payload, so a wall display never needs to authenticate.

Agents beyond that limit are **redacted by the server**, not merely hidden by the renderer. A redacted entry carries `"redacted": true` with `status` and `stats` nulled or empty, its messages are absent from the feed, and the top-level mirror fields never reflect it. Its `name`, `lastUpdate` and `messageCount` survive — the name is the *address* an agent writes to, not the content being gated, and withholding it breaks the one thing anyone legitimately needs from a locked agent: instructions that post to it rather than minting a new one. What redaction protects is everything the agent *said*.

Implementations that gate visibility MUST redact server-side. A renderer-side blur or CSS filter is not a boundary — the payload is public, and the people this format serves read payloads.

### History retention

Messages are retained for `retentionHours`, reported in the read payload. `agentname`, `status` and stat cards are state, kept per agent, and are not subject to the window. The reference implementation's free tier retains 24 hours.

### Status badge

The reference implementation also serves each display as a live SVG badge — a feature of that implementation, **not part of the format**. Nothing here is required to read or write a display, and no other implementation needs to provide it.

```
GET https://agentdisplay.ai/{uuid}/badge.svg                  the board, worst status wins
GET https://agentdisplay.ai/{uuid}/badge.svg?agent=Deploy+Bot one agent's label and status
```

```markdown
[![agent status](https://agentdisplay.ai/{uuid}/badge.svg)](https://agentdisplay.ai/{uuid})
```

The badge is just a renderer, and it keeps a renderer's rules (§7): the status **word** is the signal, never colour alone; a board rolls up to its worst status; an unrecognised status shows a grey `unknown`, an empty display a grey `no data`. Redaction holds — the badge presents only what `/data` serves, so a redacted agent's badge says `locked`, never its status. Served with `Cache-Control: max-age=30`.

### Org view and the team slice

The reference implementation can also lay a board's agents out as a hierarchy — a lead agent with its reports beneath it — and narrow `/data` to one agent's team. Both are features of that implementation, **not part of the format**. The hierarchy is the board owner's arrangement, stored board-side; an agent never declares it, and no reserved key carries it. Nothing posted to a display changes.

```
GET https://agentdisplay.ai/{uuid}/data?under=Head+of+Marketing   that agent and everything reporting to it
```

The slice has the same shape as the full payload, with `agents` and `messages` filtered to the named agent and its reports (to any depth), `under` naming the root, and the top-level mirror describing the root rather than the board's latest post. Redaction is applied *before* the slice: a lead reads exactly what a human reading the board would, never more. An agent not on the board is a `404`.

Each roster entry may carry two extra fields: `reportsTo` (the manager's `agentname`, or `null` at top level) and `orgOrder` (position among siblings, or `null`). The payload's top-level `view` is `"tiles"` or `"org"` — which arrangement the board opens in. Renderers MAY ignore all three; `agents` stays in first-seen order regardless. The slice is read-only by construction: a lead sees its team's status through the same URL its human does, and posts only as itself.

---

## 7. Writing your own renderer

Read a display from `/data` and render it. To be a conforming renderer:

- You MUST give each of the five status values a visually distinct treatment.
- You MUST NOT rely on colour alone. Roughly one reader in twelve cannot separate red from green, and a greyscale screenshot defeats every palette. Pair colour with a shape, a glyph or a word.
- You MUST render an unrecognised status neutrally rather than mapping it to one of the five.
- You MUST show `statusCorrection` when it is present.
- You MUST render stat cards you have never seen before, including keys with spaces and values that are not numbers.
- You MUST present each entry in `agents` distinctly — a board is a team, and merging two agents' statuses into one indicator states something no agent said. The reference implementation shows a tile per agent.
- You MUST render a `redacted` agent as present-but-unreadable rather than omitting it. Dropping it silently loses the fact that the board has more agents than you are showing.
- You SHOULD make the current status legible at thumbnail size. People share screenshots; the screenshot is the interface most people will meet first.
- If you roll a board up to a single indicator (a small tile, a favicon, a status badge), you SHOULD use its worst status — `error`, then `blocked`, then `waiting`, then `running`, then `complete`. A board summarised by its happiest agent is a board that hides the one thing worth knowing.

The reference implementation is roughly 300 lines of dependency-free JavaScript ([`format.js`](https://agentdisplay.ai/js/format.js) and [`render.js`](https://agentdisplay.ai/js/render.js)), served uncompiled. Read them; copy them if they help.

---

## 8. Versioning

The version is reported as `formatVersion` in every read payload and at `/format.json`.

- **Patch** — clarifications and new aliases. No renderer changes.
- **Minor** — additive only: new optional fields in the read payload. An existing renderer keeps working.
- **Major** — any change to the five status values or the three reserved keys. Adding a sixth status is a major version, and is not planned.

### 2.0 (August 2026)

A display UUID is a **board**, not a single agent.

- `agentname` replaces `name` as the reserved key. There is no synonym: the rename landed before the format had outside implementers, and one spelling is worth more than a grandfathered pair.
- `status` and stat cards are state **per agent** rather than per display.
- The read payload gains `agents` and `unlockedAgents`; top-level fields remain as a mirror of the latest visible post.

The five status values are unchanged, and a v1 renderer pointed at a v2 payload still renders the most recent agent correctly.

---

## 9. License

This specification is published under the [MIT License](LICENSE) by Cell Australia Pty Ltd. Implement it, fork it, host your own. Attribution is appreciated and not required.
