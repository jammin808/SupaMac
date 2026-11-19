# Stability and efficiency review

SupaMac retains the SolidJS/Rust architecture. Replacing the mature core with a
new framework while importing it would increase regression risk. The first
changes concern reproducible source, self-hosting diagnostics and analysis.

## AI and service boundaries

The native agent implementation is `crates/agent`. Inbound handlers extract
identity and typed access receipts; domain services own authorization and
business policy; outbound adapters implement persistence/provider calls. This
import does not move policy into the frontend or weaken those boundaries.

`crates/agent_harness` orchestrates durable sessions and serialized commands;
`crates/agent_session` owns persisted lifecycle state. The existing design uses
recovery journals, leases/fences, bounded reattach concurrency, jittered backoff,
and idle-session release. Keep those invariants when changing providers. A model
timeout must not cause a non-idempotent tool side effect to be executed again.

OpenAI uses the native Responses provider, workspace tools remain permissioned,
and token/usage accounting stays attached to the turn. Prefer a smaller model
and lower reasoning effort for routine work where evaluation supports it; choose
larger models explicitly for harder tasks. Do not silently route private context
to another provider as an outage fallback.

## Game-engine techniques that fit

| Technique | Existing foundation / implementation direction |
| --- | --- |
| Frame-budgeted work | `apps/web/src/lib/utils/create-render-queue.ts` coalesces keyed work, prioritizes visible work, and cancels on disposal. Preserve this rather than adding a permanent animation loop. |
| Data-oriented updates | Apply incremental CRDT/cache deltas; update affected entities instead of cloning or re-rendering the whole workspace. |
| Work off the UI thread | Keep heavier parsing/indexing in the existing WASM/worker paths and preserve ownership of transfer buffers. |
| Bounded memory | Virtualize long lists, release idle sessions, cancel superseded requests and evict stale caches. Never add unbounded per-message history or replay maps. |
| Deterministic state transitions | Keep serialized agent commands, durable action IDs, fenced ownership and replay-safe tool delivery. |
| Profile before optimizing | Measure interaction latency, long tasks, memory and provider usage on representative workspaces before changing architecture. |

Continuous 60 Hz polling, object pools without allocation measurements, a generic
ECS rewrite, and speculative rewrites of the agent runtime add complexity without
evidence of an improvement here. The import makes no claim of faster performance
than upstream; this is an architectural assessment, not a benchmark result.

## Validation priorities

Preserve the upstream tests for render-queue cancellation, graph/cache worker
takeover, CRDT reconciliation, session recovery, cooperative agent cancellation,
tool replay and quota enforcement. Evaluate real provider failures (429, 5xx,
disconnect, malformed streams), concurrent edits, lost tool acknowledgements and
restore from backup on the deployment host. Track p95 interaction latency,
peak memory and tokens/cost per completed task; reject a performance change if it
breaks correctness or privacy.

The fork-owned CI needs no cloud deployment credentials. Upstream automation is
kept behind a repository boundary; this is verified by generator tests, including
jobs that already use `always()`, input conditions and explicit `false`.
