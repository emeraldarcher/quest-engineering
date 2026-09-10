# War Room interface UX checkpoint

Deterministic fixture captures for the Tactic-tree-first War Room milestone.

Regenerate while the client dev server is available at `127.0.0.1:1420`:

```bash
bun run --cwd client screenshots:war-room-interface-ux
```

The capture command checks document and interface-card horizontal overflow and
rejects an editing workspace whose center column or tree canvas collapses.
Captures cover 1440, 1200, and 1024 pixel desktop widths.

1. `01-empty-new-tactic.png` — empty semantic-workspace focal state
2. `02-plan-review-semantic-tree.png` — Plan & Review workflow
3. `03-compact-interface-summary.png` — read-only interface summary
4. `04-interface-editor.png` — contextual interface editor
5. `05-output-accepted-quest-plan.png` — friendly accepted-subject output
6. `06-optional-input-quest-plan.png` — optional Quest Plan input
7. `07-until-inspector.png` — bounded plan-revision inspector
8. `08-tactic-use-binding.png` — friendly reusable-Tactic binding
9. `09-nested-semantic-tree.png` — nested reusable composition
10. `10-removal-move-toolbar.png` — compact contextual tree actions
11. `11-1200-width-workspace.png` — representative constrained desktop
12. `12-full-width-workspace.png` — normal full-width authoring view
