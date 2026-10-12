# Durable blocking HumanAttention

## Status and scope

Quest Engineering now has a provider-neutral request/response control path for a
native harness operation that must block until Product supplies structured human
input. The semantic operations are:

- `request_human_assistance`
- `wait_for_human_assistance_response`
- `acknowledge_human_assistance_response`

`HarnessControlClient.requestHumanAssistanceAndWait` composes registration and
waiting for adapters that want the `request_human_assistance_and_wait` behavior.
The local bridge CLI exposes the indefinite wait as `local-control-wait`.

This work does **not** implement a Claude Mod adapter, change an execution
profile, authenticate a provider, invoke inference, or alter Herdr.

## Authorities and durable records

The model or native extension supplies only the question payload: category,
message, optional interaction/schema, and safe native-agent provenance. It does
not receive or submit QE Action, Run, Attempt, lineage, session, Worker, or
nonce authority.

`HarnessControlAuthority` binds the request to the current opaque local control
context. Worker SQLite durably records:

- attention ID and positive request generation;
- registration idempotency key;
- Action, Run, Occurrence, Attempt, PhysicalLineage/session, harness execution,
  and optional native-session identity;
- adapter wait recoverability (`rebind_exact` or `wait_not_recoverable`);
- bounded request and response payloads;
- response, delivery, cancellation, and uncertainty state;
- append-only request lifecycle events.

The server stores the corresponding request in `human_attention_requests` and
projects its non-secret state through the existing execution session and Work
Yard. Only one unresolved blocking request may exist per Action.

## State model and ordering

Response state is one of:

- `pending`
- `responded`
- `cancelled`
- `obsolete`

Delivery state is one of:

- `response_not_delivered`
- `delivery_requested`
- `delivery_acknowledged`
- `delivery_uncertain`

The authoritative success path is:

1. Worker commits the bound request before surfacing it.
2. Product validates the exact active session, interaction capability, payload
   shape, and Action cancellation fence.
3. The server commits the response in PostgreSQL **before** requesting Worker
   delivery.
4. Worker commits the exact response in SQLite before resolving the native
   waiter.
5. Resolving the waiter durably changes delivery to `delivery_requested`.
6. Native code explicitly acknowledges consumption with the exact request
   generation and delivery-attempt ID.
7. Worker commits `delivery_acknowledged`, clears the active attention
   projection, and reports the receipt to the server.

A response is never considered delivered merely because a network send
succeeded. Product reports `delivered: true` only after native acknowledgement.

## Delivery certainty and replay

Automatic replay is allowed only while state is `response_not_delivered`.
Worker reconciliation can prove that a committed response did not cross the
native callback boundary; in that case the same durable delivery-attempt ID is
reused.

Once delivery enters `delivery_requested`, loss of the acknowledgement is
ambiguous. A Worker/control-generation change records `delivery_uncertain` and
automatic replay is forbidden. Product displays the committed delivery state
instead of offering a duplicate response form. Human or recovery policy must
resolve uncertainty explicitly.

Duplicate registration and response operations are idempotent only when their
durable identity and payload agree. Stale generation, Action, lineage/session,
native-session, delivery-attempt, or payload combinations fail closed.

## Waiting, restart, and resource bounds

Ordinary local bridge calls retain their bounded timeout. Only
`wait_for_human_assistance_response` disables the socket/mailbox deadline.
Disconnecting a socket removes the in-memory waiter but does not cancel the
durable request. The Worker owns at most 64 simultaneous native waits, and
request/response payloads have explicit byte limits.

Adapter declarations control restart behavior:

- `rebind_exact`: after Worker loss, the adapter can reopen a wait for the exact
  durable request, provided delivery never became ambiguous.
- `wait_not_recoverable`: the old native callback cannot be reconstructed.
  After a controller restart QE marks an undelivered request `obsolete`; a
  request that had crossed into `delivery_requested` becomes
  `delivery_uncertain`. QE never pretends to restore that callback.

Worker reconciliation publishes non-pending request and delivery facts. The
server retains responses committed while a Worker is offline and returns them
on the next exact Worker generation. A prior-generation `delivery_requested`
record becomes uncertain rather than being replayed.

## Cancellation and terminalization

Product execution cancellation atomically marks any unresolved server request
cancelled in the same database transaction as the cancellation fence. Worker
cancellation and terminalization cancel or obsolete the exact local request,
release a live waiter with a typed cancellation result, and retain audit
evidence. Late responses are stale.

Existing nonblocking Pi and Antigravity HumanAttention remains supported.
Native session updates that replace or clear an older nonblocking question mark
its durable record obsolete, allowing a later distinct question for the same
Action.

## FakeHarness proof

`FakeHarness` is the provider-free acceptance implementation. Its deterministic
blocking mode:

1. registers a structured question through the real local authority;
2. blocks its native execution callback;
3. receives a committed response through the exact wait handle;
4. records the response only after native callback delivery;
5. acknowledges the delivery attempt; and
6. continues to structured completion.

Worker tests additionally cover database restart, exact rebind, disconnected
waits, stale/conflicting responses, cancellation, ambiguous delivery, and the
no-replay rule. Server integration covers an offline committed response,
reconciliation onto a later Worker generation, native acknowledgement, and
same-Attempt continuation.

## Claude Mod callback feasibility

Static analysis of the exact pinned Claude Code 2.1.292 Mod declarations finds
the callback shape feasible but not yet production-proven:

- a registered Mod tool can keep its tool handler pending;
- `$.process.spawn` provides a streaming child lifetime suitable for invoking
  `qe-harness-bridge local-control-wait`;
- the declared hook budget is 10 seconds, but declared Mod budget accounting
  pauses while `next(e)` or a `$` operation is in flight (except `$.clock`
  waits), and streaming spawn avoids the fixed `process.run` ceiling;
- callback and process cancellation signals can terminate the in-memory wait
  without deleting the durable QE request.

This is a **static feasibility finding**, not a Claude adapter acceptance claim.
No Claude Mod production code was added here. Until a future immutable Mod and
profile prove exact restart behavior, a Claude implementation must declare
`wait_not_recoverable`: Claude/Mod process loss destroys the native tool-call
promise, so recovery requires an explicit resumed turn. The generic QE request
and response remain durable, and a response that may already have entered the
old callback is never replayed automatically.

## Protocol versions

- Harness control protocol: 2
- Worker/server protocol: 14
- Worker dispatch SQLite schema: 2

Protocol peers fail closed unless they implement the durable identity and
delivery-state contract. Worker SQLite has one complete schema-version-2
bootstrap. Obsolete versions and malformed development databases fail closed
with the standard greenfield reset instruction; QE performs no legacy row or
schema conversion.
