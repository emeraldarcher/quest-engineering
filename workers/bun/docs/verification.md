# v0.7 verification and pressure results

## Automated gates

```text
Elixir core: 56 tests
Elixir server: 40 tests
Bun Worker: 13 tests
Mix check: passing
Dialyzer: passing
Bun typecheck/check: passing
```

`BunWorkerProtocolIntegrationTest` launches the real Bun daemon with its deterministic test provider and proves registration over the real Phoenix WebSocket, durable SQLite acceptance, execution, completion, and Runtime revision advancement. It runs when Bun is available and otherwise reports an explicit skip; it was separately run in the combined Elixir+Bun test image and passed.

## Live Herdr/Pi

The opt-in `integration:herdr-pi` harness passed with Herdr 0.8.2/protocol 20 and Pi 0.84.2:

- fresh Implement created a normal Herdr-hosted Pi
- Repair resolved the Implement occurrence and reused the same lineage, agent, pane, and stable result-control path
- each Action used a different nonce and result destination
- fresh Review created a distinct lineage and Pi agent
- all three Actions produced validated structured outputs
- Review returned `{"status":"accepted"}`
- native attach descriptors remained valid

The `integration:worker-restart` harness killed the Bun process while Pi was working. Herdr retained Pi; a new executor recovered the same lineage, agent, and pane, observed one agent for the Action, collected its structured result, and completed without a second execution.

## Full real control-plane pressure run

A retained repository-local proof exists at:

```text
.pi/tmp/v07-pressure-live/proof.json
```

Observed path:

```text
Elixir → Worker Protocol v2 → Bun Worker → Herdr → Pi
```

Observed flow:

```text
Plan fresh
→ Implement fresh
→ Review 0 fresh/rejected
→ Repair continued from Implement
→ Review 1 new fresh/accepted
→ Run completed at revision 5
```

Five unique Action IDs produced five unique idempotent transitions and five completed dispatches. Plan, Implement, both Reviews, and Repair returned exact declared structured artifacts. Implement and Repair shared one provider lineage; the two Review occurrences used distinct lineages. All local lineage occupancy was cleared before server acknowledgement and Herdr metadata was marked inactive after completion.

During Repair the Bun Worker was killed. The same Herdr/Pi process finished, the restarted Worker collected the result from its stable control path, reconnected at a newer server generation, and advanced the Run without duplicate execution.

## Control-plane and combined restarts

A separate real Pi Action was observed working while the Elixir container was stopped. The Worker completed locally with no server acknowledgement. After Elixir restart, protocol reconciliation applied the persisted result and completed the Run exactly once.

For the combined case, Pi was observed working before and after both Elixir and Bun were stopped. Pi reached `done` while both were absent. Restarting both layers recovered the same agent and pane, persisted/resent the result, and completed the same Action with one provider process.

The pressure tests also exposed and fixed two cold-node atom conversion defects in server persistence/dispatch projection. Closed states now use explicit mappings, and RuntimeCodec explicitly allowlists closed semantic/runtime atoms rather than depending on incidental VM atom loading.

## Remaining v0.8 product work

v0.7 intentionally uses one configured Git workspace and has no scheduler, Class, Loadout, Member, Squad, or Quest product model. Herdr prompt submission still has no idempotency key; an irreducibly ambiguous settled-without-result window remains safety-over-liveness and is never automatically reprompted.
