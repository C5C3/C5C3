# LLM-Assisted Development

This part of CobaltCore uses Large Language Models (LLMs) as an integral part of its concept authoring and implementation workflow. This appendix documents the principles, practices, and tooling that govern how AI assistants are employed — from early design through code delivery.

## Guiding Principles

LLMs are a support tool, not a replacement for engineering judgment. Every AI-generated artifact is treated as a draft for further iteration, never as a final version. The following principles govern all AI usage in this project:

**Transparency and labeling.** AI-generated or AI-assisted content is clearly marked. Commits that involved an AI assistant carry an `AI-assisted:` trailer naming the tool and model — for example, `AI-assisted: Claude Code`. Human and AI contributions may be mixed within a single change; the trailer records that an assistant was involved.

**Traceability.** Each unit of work is captured in a structured, version-controlled feature log under `.planwerk/features/` in the [implementation repository](https://github.com/C5C3/forge). A log records the intended purpose, user stories, requirements, implementation tasks, test specifications, status transitions, and execution history — enough context to reconstruct how a feature was specified and built. See [`CC-0001`](https://github.com/C5C3/forge/blob/main/.planwerk/completed/CC-0001-a001-scaffold-go-workspace-and-module-structure.json) for a complete example.

**Editorial responsibility.** Every commit must carry a `Signed-off-by` trailer from a human, who bears full responsibility for the correctness, style, and security of the change — regardless of whether an LLM produced the initial draft. Tone, content, and technical accuracy are always a human decision.

**Verification before publication.** All AI output passes through human code review and the project's automated quality gates — linting and the [multi-level test suite](./09-implementation/06-testing.md) — enforced in [CI](./09-implementation/07-ci-cd-and-packaging.md) before it reaches the main branch.

**Neutrality.** AI-generated documentation and code comments are reviewed for balanced, representative language free from one-sided assumptions or biases.

**Data protection and minimization.** Credentials, secrets, and personal data are never pasted into prompts, and only the minimum context needed for a task is shared with external AI systems. Secrets are kept out of the repository (via `.gitignore`) and managed through the [secret-management stack](./05-deployment/02-secret-management.md) (OpenBao and the External Secrets Operator) rather than committed files. These measures keep secrets out of version control; they do not by themselves prevent a local AI tool from reading files it can access, so keeping sensitive material out of the working context remains a deliberate practice.

**Scope boundaries.** In security-relevant contexts — infrastructure deployment, secret management, RBAC configuration — AI output serves only as a starting point. Final decisions on security-critical code are made by humans with domain expertise.

**Model selection and sustainability.** Model selection considers capability, data residency, and resource efficiency. Where feasible, GDPR-compliant, open-source, or EU-hosted models are preferred, and the energy and resource impact of AI usage is weighed as part of that choice.

## Human in the Loop

LLMs operate under strict human oversight at every stage. No AI-generated artifacts are merged without explicit human approval.

**Concept phase.** Engineers author the high-level architecture — the concept and architecture chapters of this documentation (sections 01–09). LLMs help expand outlines, identify gaps, and draft prose, but every design decision is made and ratified by a human.

**Planning phase.** The initial implementation plan (`.planwerk/PLAN.md`) is elaborated with AI assistance. Feature specifications — including scope, stories, requirements, and test cases — are generated collaboratively and reviewed before moving to `prepared` status.

**Implementation phase.** Code is written in a human–AI pair-programming model:

1. The engineer sets the task scope and acceptance criteria.
2. The LLM produces a draft implementation.
3. The engineer reviews, modifies, and tests the output.
4. Only code that passes all automated checks and human review is committed.
5. Every commit is created and signed-off by a human.

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

## Test-Driven Development with AI

CobaltCore follows a strict test-driven approach that serves as both a quality gate and a guardrail for any contribution — human- or AI-authored. Tests are specified before implementation and define the contract the code must satisfy. The test levels (table-driven unit tests, envtest-based integration tests, and Chainsaw end-to-end tests) and the per-component coverage targets are documented in [Testing](./09-implementation/06-testing.md); this section describes how that approach constrains AI-generated code.

The test-first approach is particularly valuable when working with LLMs:

1. **Specify first.** Test specifications are defined in the Planwerk feature log (`test_specifications` field) before any implementation code is written.
2. **Generate with constraints.** The LLM receives the test specification as context when generating implementation code, anchoring its output to concrete expectations.
3. **Validate immediately.** Every code change is verified against the test suite (`make test`, `make test-integration`, `make lint`) before review.
4. **Coverage as contract.** CI enforces coverage thresholds (configured in [`.codecov.yml`](https://github.com/C5C3/forge/blob/main/.codecov.yml)) — code that reduces coverage below thresholds is rejected automatically, before it is ever suggested for human review.

```text
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Spec defines │────▶│ Tests written│────▶│ Code written │────▶│  CI verifies │
│ test cases   │     │ from the spec│     │ to pass tests│     │  + coverage  │
│ (feature log)│     │ (TDD)        │     │ (human + AI) │     │  thresholds  │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

## Planwerk

[Planwerk](https://github.com/planwerk) is the planning and AI-orchestration tool that structures CobaltCore's development workflow. It manages each unit of work through a defined lifecycle — from `draft` to `completed` — and, at every transition, writes a versioned JSON feature log under `.planwerk/features/` in the [implementation repository](https://github.com/C5C3/forge).

These feature logs are the project's audit trail for AI-assisted development. Each one is **traceable** to a feature ID and status transition, **reproducible** from the context it captures, and **auditable** because it is version-controlled alongside the code it produced. For a worked example, see [`CC-0001`](https://github.com/C5C3/forge/blob/main/.planwerk/completed/CC-0001-a001-scaffold-go-workspace-and-module-structure.json), which documents the Go workspace scaffolding with its scope definition, user stories, acceptance criteria, and deviation notes.

Refer to the [Planwerk documentation](https://github.com/planwerk) for the full feature-log schema and the tooling it provides.

---

The principles and practices described in this appendix are rooted in the [OSISM KI-Manifest](https://osism.cloud/de/ki-manifest) (CC BY-SA 4.0), which provides the ethical and organizational foundation for responsible AI usage.
