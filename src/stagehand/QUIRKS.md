# Stagehand v3.3 SDK quirks

Single source of truth for every Stagehand SDK quirk monkey works around. Read this before bumping the SDK.

When `@browserbasehq/stagehand` updates, walk this list and verify each item against the new version. Anything still applicable: keep the workaround. Anything fixed upstream: delete the workaround.

Verified against Stagehand v3.3.0.

---

## Constructor

### `browserbaseSessionID` is capital `ID`

The constructor field is `browserbaseSessionID`, not `browserbaseSessionId` (lowercase d). One letter; easy to miss.

**Workaround:** `src/stagehand/adapter.ts` uses the capital-ID form.

### Page accessor

There is no `stagehand.page` accessor. Use `stagehand.context.activePage()` or `context.newPage(url)`.

**Workaround:** `src/stagehand/adapter.ts:StagehandHandle.page()` exposes a stable `page()` method that calls `activePage()` under the hood.

### `experimental: true` required for custom tools

Custom tools passed to `agent({tools: ...})` require `experimental: true` on the Stagehand constructor. Documented in upstream `packages/core/examples/agent-custom-tools.ts`.

**Workaround:** `experimental: true` always set in `adapter.ts`.

### Logger callback signature

`(line: LogLine) => void`. The LogLine type comes from Stagehand's public types.

---

## Agent execution

### `agent.execute()` does NOT accept `AbortSignal`

In Stagehand v3.3, `agent.execute()` doesn't have a signal parameter. Passing an AbortSignal is rejected with `InvalidArgumentError` in CUA mode (silently ignored in some other modes).

**Workaround:** mid-flight cancellation goes through closing the BB session — kills the CDP transport, forces `agent.execute()` to throw. SIGINT path: `runMission` catches the throw and classifies via `classifyError`. See `src/stagehand/agent.ts` and `src/runner/caps.ts`.

### `result.usage` is unreliable

`AgentResult.usage` returns undefined for any model not in Stagehand's `AVAILABLE_CUA_MODELS` constant — even in non-CUA modes. Was the case for `claude-opus-4-7` before it landed in their list (sometime around 2026-04).

Stagehand's BB-API client also strips usage for unrecognized models.

**Workaround:** `agent.ts` reads `result.usage` via untyped cast (`(result as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage`). When usage is missing, `formatCostSummary` shows "n/a (tokens not surfaced)" and continues.

### `actions[]` shape is opaque

Stagehand's CUA path returns actions with `type` + structured args (e.g. `{ type: 'click', x: 540, y: 320 }`). The hybrid path returns actions with `type` + `reasoning` + `pageUrl` + `timeMs` + tool-specific args.

In CUA mode, `description` / `pageUrl` / `timestamp` / `timeMs` / `reasoning` are NOT populated — only `type` plus action-specific structured args.

**Workaround:** `src/trace/build.ts:summarizeAction` synthesizes a description from the `type` + args when no `reasoning` is present. The trace's per-step URL field comes from `pageUrl` (populated in hybrid mode, empty in CUA).

### `excludeTools` works in hybrid mode

We pass `excludeTools` to `agent.execute()` to narrow hybrid mode's tool vocabulary to what review missions need (`act, goto, extract, screenshot, click, type, dragAndDrop`). Drops `fillForm`, `keys`, `scroll`, `navback`, `clickAndHold`, `wait`, `think`, `ariaTree`, `observe`, `braveSearch`, `browserbaseSearch`.

**Caveat:** Stagehand's docs mention `excludeTools` is for hybrid/dom modes; behavior in CUA mode is undefined. We only use it in hybrid.

---

## Mode dispatch

### Three modes: `dom` | `hybrid` | `cua`

Per Stagehand v3.3:
- `dom` (default): act/extract via a11y tree + small LLM
- `hybrid`: dom tools + pixel-level tools (click x,y, dragAndDrop, etc.) for visual edge cases
- `cua`: pure pixel via Anthropic Computer Use API

monkey defaults to `hybrid`. The `cua` branch was deleted in commit 84929db.

### Hybrid mode model warning

Stagehand emits a warning if the model isn't `gemini-3-flash` or `claude-*`. Vision models. Our agent model (`anthropic/claude-opus-4-6`) satisfies this.

**Workaround:** none needed; just don't pass a non-vision model.

### Default mode warning

Stagehand v3.3 prints `"Using agent in default DOM mode (legacy). Agent will default to 'hybrid' on an upcoming release for improved performance."` when `mode` is undefined.

**Workaround:** we explicitly pass `mode: 'hybrid'` to suppress the warning.

---

## Model resolution

### `provider/model` format required for AI SDK path

Stagehand's AI-SDK path requires modelName with provider prefix: `anthropic/claude-opus-4-6`, `openai/gpt-5.5`. Without the slash, falls into the legacy `modelToProviderMap` lookup which throws `UnsupportedModelError` for any model not in their hardcoded list.

**Workaround:** `agent.ts` always passes the prefixed form (no longer strips for Azure).

### `executionModel` inheritance

If `executionModel` is unset on `agent({...})`, Stagehand uses the same model as the agent for in-agent grounding (`act`, `extract` internals). For hybrid mode this doubles load on the agent's deployment.

**Workaround:** `runMission.ts` always passes `executionModel: stagehandModel` (typically gpt-5.5) to route grounding through a different provider. See commit 3748357 (capacity hardening).

### Azure Foundry baseURL needs `/v1` for AI SDK

The Anthropic SDK auto-appends `/v1/messages` to baseURL. The AI SDK's anthropic provider only appends `/messages` — its default baseURL already contains `/v1`. Users storing the bare `https://<resource>.services.ai.azure.com/anthropic` form (works for Anthropic SDK) need `/v1` appended for AI SDK routing.

**Workaround:** `src/stagehand/agent.ts:ensureV1Suffix` normalizes the baseURL when handing to Stagehand's hybrid path. The Anthropic SDK direct path (`src/adjudicate/anthropic-client.ts`) does NOT need this.

---

## Error shapes

### Overload errors are wrapped

Anthropic 529 ("Overloaded") gets wrapped by Stagehand's internal retry layer as: `"Failed after 3 attempts. Last error: Overloaded"`.

**Workaround:** `agent.ts:classifyError` matches both `e?.error?.type === 'overloaded_error'` (raw form) AND `/overloaded|failed after \d+ attempts/i` (wrapped form). See commit 161c738.

### `act()` 45s default timeout

`act()` calls have a 45-second internal timeout. Past that, throws `TimeoutError: act() timed out after 45000ms (it may continue executing in the background)`.

**Workaround:** none. The error's classifyError path catches it as a timeout.

### `agent.execute()` post-session-close throws

If the BB session is closed while `agent.execute()` is mid-call (e.g., wallclock fire), Stagehand's internal CDP transport throws. Sometimes the error is `"Stagehand session was closed"`, sometimes `"Cannot read properties of null (reading 'awaitActivePage')"` (latter is a known Stagehand cleanup bug).

**Workaround:** classifyError matches both via `/closed|disconnected|cancelled|aborted|timeout/i`.

---

## Stdout pollution

Stagehand's internal debug logging (`[2026-...] DEBUG: css pierce-fallback ...`) writes to **stdout**, bypassing both our `pino`-style logger callback and the framework's stderr conventions.

**Workaround:** in `--json` mode we install `quarantineStdout` (in `commands/run.ts`) to hijack `process.stdout.write` and redirect to stderr for the duration of bootstrap + missions. Restored before `emitJson()` writes the JSON. See commit 9fd50f1.

---

## Update checklist (when bumping Stagehand)

- [ ] `result.usage` populates for our agent model? (If not, token tracking breaks silently.)
- [ ] `agent.execute({ signal })` accepted in hybrid mode? (If yes, we can drop the BB-session-close cancellation hack.)
- [ ] Default mode: still 'dom'? Or moved to 'hybrid' as Stagehand promised?
- [ ] `excludeTools` still respected in hybrid mode?
- [ ] Action shape: still `{ type, reasoning?, pageUrl?, timeMs?, ... }` in hybrid?
- [ ] Constructor field: still `browserbaseSessionID` (capital ID)?
- [ ] Stdout debug logging: still bypassing logger callback?
- [ ] Custom tools in DOM/hybrid mode: do they advertise to the model? (We don't use this today, but documented earlier as a limitation.)
- [ ] AI-SDK path's anthropic provider URL composition: still `${baseURL}/messages` (no auto `/v1`)?

If any answer changed: update this file + the corresponding workaround.
