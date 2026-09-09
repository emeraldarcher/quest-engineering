# Spec-driven development and reusable Tactic interfaces

Quest Engineering keeps five related concepts deliberately separate.

## Artifact kind

An **artifact kind** answers “what kind of work product is this?” Built-in suggestions are:

- `quest_plan` — **Quest Plan**
- `change_set` — **Change Set**
- `review_verdict` — **Review Verdict**

Kinds remain open so teams may use meaningful custom kinds such as `architecture_spec`, `requirements_spec`, or `test_plan`. Generic infrastructure does not collapse those meanings into `document` or `blob`.

## Output and binding

A Step output has a local name and a kind. For example, **Review Plan** produces output `verdict` of kind **Review Verdict**. `verdict` is a local slot, not an artifact kind.

A binding identifies one concrete output, such as **Review Plan → Verdict**. Inputs and Until conditions select contextual bindings, never entries from the global kind catalog. The compiler resolves each binding to an exact immutable artifact ID.

## Acceptance gate and review contract

An acceptance gate answers “what semantic approval can this verdict satisfy?” A Review Verdict output declares a review contract containing:

- `gate_key`, such as `plan_acceptance` or `implementation_acceptance`;
- the named Step input that is the exact reviewed subject.

Runtime scopes every Review Verdict to `status`, `gate_key`, `subject_kind`, and `subject_artifact_id`. Acceptance requires all fields to match. Acceptance of Quest Plan v2 cannot accept v3, and Plan Acceptance cannot authorize Delivery. Delivery requires `implementation_acceptance` for the exact Change Set being published.

## Tactic input

A reusable Tactic input is a friendly typed port. It has a semantic key, label, artifact kind, and required/optional flag. Optional absence is represented by omission; Quest Engineering never invents a placeholder artifact.

**Implement & Review** declares:

```text
Inputs
  Quest Plan · Optional
```

Standalone execution supplies no Plan and remains valid. Composition may bind the port to one exact accepted Quest Plan.

## Tactic output

A reusable Tactic output is a friendly typed export. A generic export maps to an internal binding. An accepted-subject export maps to the exact loop-carried artifact whose Review Verdict satisfied a named gate. Exports are references, not copies: artifact ID, content hash, version, and producer provenance remain unchanged.

## Quest Plan documents

Quest Plans use the generic immutable document envelope with Markdown content, deterministic logical filename, SHA-256 content hash, version, producer occurrence/attempt provenance, and `supersedes_artifact_id`. Revision appends history:

```text
Quest Plan v1 → rejected
Quest Plan v2 → rejected
Quest Plan v3 → accepted
```

Worker-owned materialization occurs outside Git worktrees. Phoenix stores logical content and provenance, never Worker-local paths.

## Canonical reusable composition

### Plan & Review

```text
Plan
  produces plan : Quest Plan

Until Quest Plan is accepted
  Review Plan
    uses current plan
    produces verdict : Review Verdict
    gate Plan Acceptance
  otherwise Revise Plan
    uses current plan and rejected verdict
    produces the next plan : Quest Plan
  maximum plan revisions: 2

Outputs
  accepted_plan : Quest Plan
  label: Accepted Quest Plan
  source: Plan Acceptance → Accepted Subject
```

Two revisions permit three reviews: v1, v2, and v3.

### Implement & Review

```text
Inputs
  plan : Quest Plan · Optional

Implement
  uses plan when supplied
  produces change_set : Change Set

Until Implementation is accepted
  Review
    uses current change_set
    produces verdict : Review Verdict
    gate Implementation Acceptance
  otherwise Repair
    uses current change_set and rejected verdict
    produces the next change_set : Change Set
  maximum repairs: 3

Outputs
  accepted_change_set : Change Set
  label: Accepted Change Set
  source: Implementation Acceptance → Accepted Subject
```

### Plan, Implement & Review

```text
Sequence
  TacticUse planning: Plan & Review

  TacticUse implementation: Implement & Review
    Quest Plan ← planning.accepted_plan
```

War Room presents this as:

```text
Plan & Review
      │
      │ Accepted Quest Plan
      ▼
Implement & Review
```

Internally, slash-scoped Step identities prevent collisions. Child internals remain encapsulated; only declared outputs enter the parent scope. Launch snapshots freeze child definitions, interfaces, input bindings, output mappings, and remediation limits.

Semantic remediation remains independent from operational attempts, recovery epochs, `/qe-retry`, conversational takeover, and `/qe-resume`.
