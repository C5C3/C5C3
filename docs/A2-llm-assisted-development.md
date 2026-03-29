# LLM-Assisted Development

This part of CobaltCore uses Large Language Models (LLMs) as an integral part of its concept authoring and implementation workflow. This appendix documents the principles, practices, and tooling that govern how AI assistants are employed — from early design through code delivery.

## Guiding Principles

LLMs are a support tool, not a replacement for engineering judgment. Every AI-generated artifact is treated as a draft for further iteration, never as a final version. The following principles govern all AI usage in this project:

**Transparency and labeling.** AI-generated or AI-assisted content is clearly marked. Commits carry an `AI-assisted: Claude Code` trailer identifying the model and tooling involved. There is no ambiguity about whether a human or an AI produced a given artifact.

**Traceability.** Prompts (soon), model choices (soon), intended purpose, responsible persons, and decision rationale are captured in structured feature logs (`.planwerk/features/`). These logs are version-controlled and publicly accessible, ensuring that every AI interaction can be reconstructed after the fact.

**Editorial responsibility.** The human author listed in `git log` bears full responsibility for correctness, style, and security of committed code — regardless of whether an LLM produced the initial draft. Tone, content, and technical accuracy are always a human decision.

**Verification before publication.** All AI output passes through code review, linting, type checking, and the project's multi-level test suite before it reaches the main branch. Errors are corrected before merge; feedback on AI-generated contributions is addressed promptly.

**Neutrality.** AI-generated documentation and code comments are reviewed for balanced, representative language free from one-sided assumptions or biases.

**Data protection and minimization.** No credentials, secrets, or personal data are included in prompts. The project enforces this through `.gitignore`, `.secrets.toml`, and least-privilege access patterns. Only the minimum context necessary for a task is shared with external AI systems.

**Scope boundaries.** In security-relevant contexts — infrastructure deployment, secret management, RBAC configuration — AI output serves only as a starting point. Final decisions on security-critical code are made by humans with domain expertise.

**Model selection and sustainability.** Model selection considers capability, data residency, and resource efficiency. Where feasible, preferences for GDPR-compliant, open-source, and EU-hosted models are evaluated. Energy and resource impact of AI usage is taken into account.

## Human in the Loop

LLMs operate under strict human oversight at every stage. No AI-generated artifact reaches the main branch without explicit human approval.

**Concept phase.** An engineer authors the high-level architecture (sections 01–09 of this document). LLMs help expand outlines, identify gaps, and draft prose, but every design decision is made and ratified by a human.

**Planning phase.** The initial implementation plan (`.planwerk/PLAN.md`) is elaborated with AI assistance. Feature specifications — including scope, stories, requirements, and test cases — are generated collaboratively and reviewed before moving to `prepared` status.

**Implementation phase.** Code is written in a human–AI pair-programming model:

1. The engineer sets the task scope and acceptance criteria.
2. The LLM produces a draft implementation.
3. The engineer reviews, modifies, and tests the output.
4. Only code that passes all automated checks and human review is committed.

**Review phase.** Pull requests undergo both automated CI validation and human code review. AI-generated review suggestions (via Planwerk's `review` task) serve as input to the human reviewer, not as a substitute.

```text
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────┐
│  Human sets │────▶│ LLM drafts  │────▶│ Human reviews│────▶│  CI runs │
│  scope +    │     │ code / docs │     │ + modifies   │     │  tests   │
│  criteria   │     │             │     │              │     │  + lint  │
└─────────────┘     └─────────────┘     └──────────────┘     └────┬─────┘
                                                                  │
                                              ┌───────────────────┘
                                              ▼
                                        ┌──────────┐     ┌──────────┐
                                        │  Human   │────▶│  Merge   │
                                        │  approves│     │  to main │
                                        └──────────┘     └──────────┘
```

## Test-Driven Development

This part of CobaltCore follows a strict test-driven approach that serves as both a quality gate and a guardrail for AI-generated code. Tests are specified before implementation and define the contract that any code — human or AI-authored — must satisfy.

### Test Levels

**Unit tests.** Table-driven Go tests covering pure functions and type logic. Target: 80%+ coverage for `internal/common/`, 90%+ for webhook validation. These run in milliseconds and provide the fastest feedback loop for AI-generated code.

**Integration tests.** envtest-based tests that exercise reconciliation loops against a real API server and etcd. Target: 70%+ coverage for operator controllers. These validate that AI-generated Kubernetes interactions behave correctly without requiring a full cluster.

**End-to-end tests.** [Chainsaw](https://github.com/kyverno/chainsaw)-based E2E tests running on kind clusters. These exercise the complete deployment stack — from FluxCD infrastructure through operator orchestration to a running Keystone API. Organized under `tests/e2e/` with scenarios for happy paths, failure recovery, scaling, and upgrade rollouts.

### TDD and AI Workflow

The test-first approach is particularly valuable when working with LLMs:

1. **Specify first.** Test specifications are defined in the Planwerk feature log (`test_specifications` field) before any implementation code is written.
2. **Generate with constraints.** The LLM receives the test specification as context when generating implementation code, anchoring its output to concrete expectations.
3. **Validate immediately.** Every AI-generated code change is verified against the existing test suite (`make test`, `make test-integration`, `make lint`) before review.
4. **Coverage as contract.** CI enforces coverage thresholds (configured in `.codecov.yml`) — AI-generated code that reduces coverage below thresholds is rejected automatically.

```text
Feature Log               Implementation              Verification
┌─────────────────┐      ┌───────────────────┐       ┌─────────────────┐
│ test_           │─────▶│ Write tests first │──────▶│ make test       │
│ specifications  │      │ (from spec)       │       │ make test-      │
│                 │      │                   │       │   integration   │
│ requirements    │─────▶│ Implement code    │──────▶│ make lint       │
│ (with scenarios)│      │ (AI-assisted)     │       │ make e2e        │
│                 │      │                   │       │                 │
│ acceptance      │─────▶│ Verify criteria   │──────▶│ Coverage ≥      │
│ criteria        │      │                   │       │   thresholds    │
└─────────────────┘      └───────────────────┘       └─────────────────┘
```

## Planwerk — Tooling for AI-Driven Development

[Planwerk](https://github.com/planwerk) is the project management and AI orchestration tool used to structure CobaltCore's development workflow. It bridges the gap between high-level planning and AI-assisted implementation by providing a structured, auditable framework.

### Feature Lifecycle

Every unit of work follows a defined lifecycle managed through Planwerk:

```text
draft ──▶ elaborated ──▶ preparing ──▶ prepared ──▶ implementing ──▶ completed
                                          │
                                          ▼
                                      reviewed
```

Each transition produces a versioned JSON artifact in `.planwerk/features/` containing:

| Section | Purpose |
| --- | --- |
| `description` | Scope (included/excluded), visualizations (Mermaid), key components, deviation notes |
| `stories` | User stories with role, want, so-that, and acceptance criteria |
| `requirements` | Formal requirements with IDs (REQ-001, …), priority, rationale, and when/then scenarios |
| `tasks` | Numbered implementation tasks with time estimates and dependency links |
| `test_specifications` | Test cases mapped to files, functions, stories, and expected outcomes |
| `review_criteria` | Checklist items for code review |
| `execution_history` | Timestamped records of AI-assisted implementation runs |
| `status_history` | Audit trail of lifecycle transitions |

### Feature Logs and Review Trail

Feature logs in `.planwerk/features/` serve as the project's audit trail for AI-assisted development. Each log captures the full context of a feature — from initial specification through implementation decisions to review outcomes.

Example: `CC-0001-a001-scaffold-go-workspace-and-module-structure.json` documents the Go workspace scaffolding with complete scope definition, five user stories, detailed acceptance criteria, and deviation notes (e.g., the decision to use Go 1.25 over the initially documented version).

Completed features are archived in `.planwerk/completed/`. Review artifacts are tracked in `.planwerk/reviews/`. Progress snapshots are stored in `.planwerk/progress/`.

This structure ensures that every AI interaction in the development process is:

- **Traceable** — linked to a specific feature ID and status transition.
- **Reproducible** — captured with sufficient context to understand the AI's input and output.
- **Auditable** — version-controlled alongside the code it produced.

## Responsible Use Checklist

Before merging any AI-assisted contribution, the following checks apply:

- [ ] Clear added value from AI assistance is identifiable.
- [ ] No sensitive or personal data was included in prompts.
- [ ] Generated code has been reviewed, tested, and edited by a human.
- [ ] AI involvement is marked via commit trailers.
- [ ] Output has been checked for neutrality and balanced assumptions.
- [ ] All required CI gates (lint, test, coverage) pass.
- [ ] Necessary approvals have been obtained.

---

The principles and practices described in this appendix are rooted in the [OSISM KI-Manifest](https://osism.cloud/de/ki-manifest) (CC BY-SA 4.0), which provides the ethical and organizational foundation for responsible AI usage.
