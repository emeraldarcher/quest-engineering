# War Room semantic wiring UX checkpoints

Deterministic fixture captures for the semantic authoring and validation pass.
Generate with:

```sh
bun run --cwd client screenshots:war-room-semantic-wiring-ux
```

1. `01-invalid-review-input.png` — missing Review input type and visible blocking guidance.
2. `02-quest-plan-input-type.png` — Quest Plan Type and Current Quest Plan source.
3. `03-plan-review-contract.png` — explicit reviewed input, Review Verdict, and Plan Acceptance.
4. `04-plan-acceptance-condition.png` — semantic “Quest Plan is accepted” Until condition.
5. `05-remediate-two-inputs.png` — remediation’s named Plan and feedback contracts.
6. `06-current-quest-plan.png` — automatic exact loop-carried Plan source.
7. `07-rejected-review-verdict.png` — exact rejected Plan Review source.
8. `08-accepted-quest-plan-export.png` — accepted-artifact export through Plan Acceptance.
9. `09-internal-output-export.png` — explicitly separate raw internal-output mode.
10. `10-invalid-draft-summary.png` — consolidated validation beside Save.
11. `11-valid-plan-review.png` — complete responsive Plan & Review composition.
12. `12-parent-tactic-use-binding.png` — child accepted output bound to Implement & Review.

Layout assertions run for every capture. The representative 1440, 1200, and 1024 widths must have no document/interface overflow, a center editor wider than 340px, and a semantic canvas taller than 180px.
