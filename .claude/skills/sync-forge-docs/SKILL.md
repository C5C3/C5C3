---
name: sync-forge-docs
description: Reconcile the C5C3 architecture documentation against the actual implementation in the C5C3/forge monorepo on GitHub, which is the source of truth for what is already built. Identifies gaps in both directions and aligns the docs non-destructively — correcting mismatches, adding newly-implemented capability, and integrating new fundamental forge concepts across the architecture chapters, while preserving documentation of planned, not-yet-implemented future work. Use when the user asks to sync/align docs with forge, reconcile docs against the implementation, fix stale docs, or find gaps between docs and the codebase.
---

# Sync C5C3 Docs with the forge Implementation

This repository (`C5C3/C5C3`) holds **architecture documentation** (a VitePress site under `docs/`). The
implementation lives in the separate **`C5C3/forge`** monorepo on GitHub. This skill brings the docs back in
line with what forge actually does — without losing the parts of the docs that intentionally describe the
future.

## Core principle: forge is the source of truth for what is *built* — the docs also describe the *future*

Two facts hold at once, and the whole skill balances them:

- **forge on GitHub is the source of truth for the current implementation.** Where the docs describe something
  that forge *has built differently*, forge wins and the docs are corrected. Never edit forge to match the docs.
- **The docs are deliberately forward-looking.** They document planned capability that forge has **not built
  yet** (e.g. operators not yet scaffolded). This planned content is valuable and must **not be lost** during
  the sync just because forge lacks it today.

So alignment is **non-destructive**: it fixes what is wrong, fills what is missing, and preserves what is
merely not-yet-built. When you cannot tell whether doc content is "stale (forge removed it)" or "planned (forge
hasn't built it yet)", **ask the user** rather than deleting.

**Always read forge from the GitHub repository, never from a local checkout.** Local checkouts drift, may be
stale, or sit on a feature branch — the canonical state is `C5C3/forge` on GitHub (default branch `main`). Even
if a `./forge` or `../forge` directory exists locally, ignore it and fetch fresh.

## Step 1 — Fetch forge fresh from GitHub

Confirm `gh` is authenticated (`gh auth status`) and pull a fresh, shallow copy of the default branch into a
temp directory each run:

```bash
FORGE=$(mktemp -d)/forge
gh repo clone C5C3/forge "$FORGE" -- --depth 1
git -C "$FORGE" rev-parse HEAD   # record the commit you compared against, for the report
```

Use `$FORGE` as the forge root for the rest of the run. Confirm it is forge (`go.work`, `internal/common/`,
`operators/` present). If the clone fails (no access / offline), fall back to `gh api` for individual files
(`gh api repos/C5C3/forge/contents/<path> -q '.content' | base64 -d`) or, only with the user's explicit
agreement, a named local checkout — and say in the report that you did not use GitHub. Clean up the temp dir
when done.

## Step 2 — Determine scope

- **With an argument** (a doc path, a chapter number, or a topic like "testing" / "crds" / "keystone"):
  scope to the matching file(s) under `docs/`. Map topics to files using the table in
  [references/doc-to-forge-map.md](references/doc-to-forge-map.md).
- **No argument**: default to the full implementation guide `docs/09-implementation/*.md` (the chapter most
  tightly coupled to forge), then offer to extend the sweep to the rest of `docs/` and `CLAUDE.md`.

For a multi-document sweep, fan out: verify each document against forge in parallel (one `Agent` per doc, or a
`Workflow` if the user opted into orchestration). Each verifier returns a structured gap list; you then
synthesize and apply. Keep the *applying* step serial and reviewable.

## Step 3 — Verify in both directions (gap discovery)

This is a **two-way** comparison. Walk the docs claim-by-claim against forge, *and* walk forge looking for
concepts the docs never mention.

### 3a. Docs → forge (is each documented, present-tense claim true?)

For every **verifiable** "this is how it works today" assertion, check it against the fetched forge tree:

| Claim type | How to verify against forge |
|---|---|
| **Operators that exist** | `ls $FORGE/operators/` — only these are actually built. Docs list 7 services; forge may have far fewer scaffolded. |
| **File / directory paths** | The path must exist in forge. Check `internal/common/<pkg>/`, `operators/<svc>/api/v1alpha1/`, controller dirs, etc. |
| **CRD types & fields** | Read `operators/<svc>/api/v1alpha1/*_types.go`. Verify struct names, field names, kubebuilder markers, defaults, validation. |
| **API groups / versions** | Grep `+groupName` / `+kubebuilder:object:root` markers and `PROJECT`/`go.mod` module paths. |
| **Sub-reconcilers & flow** | List `operators/<svc>/internal/controller/reconcile_*.go`. The real set of sub-reconcilers (and their order) is authoritative. |
| **Shared library packages** | `ls $FORGE/internal/common/` — package set, names, and exported types. |
| **Status conditions** | Grep the conditions package + controller for the actual condition type constants. |
| **Makefile targets & commands** | Read `$FORGE/Makefile`. Verify target names, variables (e.g. `OPERATOR=`), and example invocations. |
| **Tool / language versions** | `go.work` (Go version), `go.mod` files, `Makefile` pinned versions (envtest K8s, gofumpt, chainsaw, operator-sdk), `.github/workflows/`. |
| **Testing approach** | Test file naming, envtest usage, Chainsaw test layout. |
| **CI/CD & packaging** | `.github/workflows/`, `Dockerfile`/`images/`, `operators/*/helm/`, `releases/`. |
| **Secrets / deps flow** | ESO / OpenBao / MariaDB / Memcached wiring as actually coded in the relevant `reconcile_*.go`. |

### 3b. forge → docs (what does forge have that the docs miss entirely?)

Sweep forge for **fundamental concepts the docs do not cover at all** — these are the highest-value gaps:

- New packages under `internal/common/` (a whole new shared concern).
- New sub-reconcilers / capabilities on existing operators (e.g. `reconcile_hpa`, `reconcile_networkpolicy`,
  `reconcile_httproute`, `reconcile_trustflush`, credential rotation) that imply an architectural feature.
- New CRDs / API groups, new controllers, new operators.
- New cross-cutting mechanisms (TLS/cert flows, network policy, autoscaling, gateway/HTTPRoute, health checks).
- Mine `$FORGE/docs/`, `$FORGE/README.md`, `$FORGE/.planwerk/`, and `$FORGE/CLAUDE.md` for the *intent* behind
  new code — but the **code** outranks forge's own prose when they conflict.

Prefer precise tooling: Grep/Glob and read the actual `.go`/`Makefile`/`go.work` files rather than guessing.

### Classify every gap

1. **Mismatch** — docs describe X as current, forge implements Y. → Correct the doc to Y.
2. **Implemented-but-undocumented (incremental)** — forge has a detail the docs omit. → Add it to the right doc.
3. **Implemented-but-undocumented (fundamental / new concept)** — forge introduces a concept the docs lack
   entirely. → Add it *and integrate it architecturally* (see Step 5).
4. **Documented-but-unbuilt (planned future)** — docs describe something forge has not built yet. → **Preserve.**
   Keep it, ensure it reads as planned, do not delete.
5. **Genuinely stale (forge removed it)** — forge actively removed/renamed something the docs still present as
   current. → Rewrite/remove. If you cannot confirm it was *removed* (vs. never-yet-built), treat as class 4
   and ask.

## Step 4 — Report gaps before mass edits

Produce a concise gap report grouped by document, each entry tagged with its class, the doc claim, the forge
reality (cite `file:line` in forge plus the forge commit SHA you cloned), and the proposed fix. Call out
class-3 (new fundamental concepts to weave in) and any class-4/5 ambiguities you want the user to confirm.
Surface this before applying many edits — get a go-ahead, or proceed if the user already asked for a full
alignment.

## Step 5 — Align the docs (apply fixes), non-destructively

Edit the docs so they match forge **for what is built**, add what is missing, and keep what is planned.

### Preserve the future
Never drop content just because forge lacks it. For **planned, not-yet-implemented** items (class 4): keep the
design intent, make the status honest (mark as **planned / not yet implemented** consistent with how the docs
already mark future work), and reword present-tense prose ("the Nova operator reconciles…") to future/intended
tense. The Keystone-first strategy is explicit in the docs, so Keystone stays the concrete present-tense
reference and the rest is framed as following it.

### Integrate new fundamental concepts architecturally
When forge has introduced a fundamental concept missing here (class 3), do **not** just append a paragraph to
the implementation chapter. Pull it up to the right architectural altitude and weave it across the docs:

- Add/extend the **architecture** treatment (e.g. `docs/02-architecture-overview.md`, `docs/04-architecture/*`)
  so the concept is explained as a design decision, not only as code.
- Reflect it in the relevant **component** docs (`docs/03-components/*`) and any **deployment/operations**
  chapters it touches (`docs/05-*`, `docs/06-*`).
- Then document the concrete implementation in `docs/09-implementation/*`.
- Update cross-cutting tables (operator list, API-group table, tech-stack) and `CLAUDE.md` so every copy of the
  fact stays consistent.

When unsure where a new concept belongs architecturally, propose the placement in the gap report and ask.

### Editing conventions
- Preserve VitePress markdown, heading structure, relative links (`../04-architecture/01-crds.md`), code-fence
  languages, and the language rule (**documentation in English**; code in Go).
- **No inline SPDX header in `.md`** — `docs/**.md` is covered by `REUSE.toml` annotations.
- Keep embedded Go faithful to forge (copy real struct/reconciler shapes; trim with `// ...`, don't paraphrase
  signatures wrongly).
- Make focused edits; don't reflow unrelated prose. Prefer many small Edits over rewriting whole files.

## Step 6 — Verify your changes

```bash
npm run docs:build      # VitePress build must succeed (catches broken links/refs)
```

If the user wants the full gate (or before a PR), also run the repo's linters (MegaLinter / cspell / lychee)
per `CLAUDE.md`, and add any new technical terms to `cspell.yaml`. Re-verify a sample of your fixes against
forge to catch over-correction, and re-check that no planned/future content was accidentally removed.

Summarize: the forge commit compared against, gaps by class, files touched, which new concepts you integrated
and where, and anything left as planned or deferred to the user.

## Guardrails

- Always read forge from GitHub (`C5C3/forge`, branch `main`); ignore local forge checkouts; re-fetch each run.
- Never modify the forge repo. This skill only edits docs in `C5C3/C5C3`.
- **Non-destructive**: never delete planned/future content; when unsure if something is stale vs. unbuilt, ask.
- New fundamental forge concepts get integrated across the architecture chapters, not dumped into one section.
- Don't fabricate forge details — if you can't find the code, mark the claim "unverified" rather than guessing.
- Keep edits reviewable and consistent across every place a fact is repeated.
