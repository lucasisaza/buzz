---
title: "NIP-RS manual-unread: bounded exhaustive model — candidates A vs B"
tags: [nostr, nip-rs, read-state, formal-model, buzz]
status: active
created: 2026-07-16
---

# NIP-RS manual-unread encoding model

Bounded exhaustive model comparing two candidate CRDT encodings for a
manual mark-as-unread override layer within NIP-RS read state.

## Run

```bash
python3 exhaustive.py
python3 mutation.py
```

Both scripts are deterministic and exit 0 on success.

## Context

NIP-RS v1 encodes read state as grow-only `max(timestamp)` frontiers per
context. Manual mark-as-unread requires a second source of truth (an
override layer) because the frontier cannot be lowered — a lower value is
indistinguishable from a stale replica under `max()` merge.

The override layer must converge across devices, survive legacy client
rewrite cycles, and remain bounded within the existing 32 KiB plaintext
budget. Two candidate encodings are modeled:

- **A — lexicographic operation register:** per context, one register
  `{counter, client_tiebreak, op, baseline}` in a NEW top-level field.
- **B — two grow-only counters + baseline:** per context, `S` (set
  counter), `C` (clear counter), `B` (frontier-at-set-time) encoded as
  sibling keys under `contexts`.

## Model universe

- 2 upgraded devices + 1 legacy device
- 2 contexts (`c0`, `c1`)
- Actions: mark-unread, mark-read (with frontier advance),
  advance-frontier, compact, reinstall (client_id loss),
  deliver (including duplicate/replay)
- BFS over canonical global states with interleaved actions and deliveries
  (not phased), depth-bounded
- All delivery permutations of published blobs at terminal states
- Multi-slot union (split blob across 2 slots, deliver separately)
- Directed deep-history check: compact → new local actions (counter
  reuse) → delayed stale delivery (including split across 2 slots),
  over a 2,016-point parameter cube (stale `(S,C,B)` × post-compaction
  frontier × 7 action sequences × 2 tie policies × 3 delivery shapes)
- States explored: 7,107 per tie policy (14,214 total)

## Invariants checked

| # | Invariant | A | B (clear-wins) | B (set-wins) |
|---|-----------|---|-----------------|--------------|
| I1 | Join associative/commutative/idempotent | PASS | PASS | PASS |
| I2 | Convergence (all delivery orders) | PASS | PASS | PASS |
| I3 | No frontier regression | PASS | PASS | PASS |
| I4 | Concurrent set/clear winner stable | PASS | PASS | PASS |
| I5 | Compaction: no loss, no resurrection (immediate merge-back) | n/a | PASS | PASS |
| I5c | Deep-history: compact → reuse → delayed stale delivery | n/a | PASS | PASS |
| I6 | Replay harmless | PASS | PASS | PASS |
| I7 | Legacy rewrite safety | **FAIL** (witness) | PASS | PASS |
| I8 | Bounded key growth (3 keys/ctx live, 1 key/ctx tombstone) | n/a | PASS | PASS |
| I9 | DeviceA counter absorption | PASS | n/a | n/a |

I5 covers the immediate compacted-vs-pre-compaction merge shape (both
merge orders). I5c is the deeper property this round was opened to
close: it directly targets the ~9-transition history a depth-4 BFS
cannot structurally reach (compact → new local set/clear → delayed
stale delivery, including from a second slot), asserting that
compaction — a storage optimization — never changes the semantic
outcome relative to a reference device that never compacts.

## Candidate comparison

### Convergence

Both candidates converge under all tested delivery permutations.
Candidate B achieves this with componentwise `max()` merge (a standard
state-based CRDT join). Candidate A uses a register with lexicographic
tuple comparison — also convergent, but the register requires a
client-identity tiebreak field.

### Legacy compatibility matrix

| Scenario | A | B |
|----------|---|---|
| Upgraded publishes, legacy reads blob | Legacy drops `overrides` field | Legacy preserves `ov_*` sibling keys |
| Legacy rewrites same slot | **Overrides erased** (expected-witness confirmed) | Sibling keys survive sanitization |
| Upgraded reads legacy-rewritten blob | Override state lost | Override state intact |
| Legacy reads its own frontier | Inert (correct) | Inert (correct) |
| Legacy frontier advance past baseline | Cannot clear override (erased) | Stale set dominated (correct) |

**Candidate A's legacy erasure is the decisive defect.** The desktop and
mobile parsers (`readStateFormat.ts:82-108`, `read_state_format.dart:100-141`)
reconstruct only `{v, client_id, contexts}`. A same-slot legacy rewrite
drops the top-level `overrides` field entirely and republishes without it.
There is no safe migration path: any user with a single legacy device
loses all manual-unread state on the next rewrite cycle.

Candidate B's sibling keys (`ov_s:`, `ov_c:`, `ov_b:`) pass all legacy
validation gates — keys are <= 256 UTF-8 bytes, values are uint32 —
and round-trip through legacy rewrite unmodified.

### Identity dependence

- **A requires client_id** for the tiebreak field. After reinstall
  (new `client_id`), the tiebreak changes. Convergence is preserved only
  because the counter is strictly higher; a same-counter reinstall would
  create an ambiguous merge.
- **B needs no client identity** — componentwise `max()` is
  identity-free. Confirmed: reinstall with new `client_id` preserves
  convergence.

### Bytes per manually-unread context

Sizes computed with realistic context IDs. Envelope cost
(`{"v":1,"client_id":"...","contexts":{}}`) is ~60 bytes and shared
across all contexts — amortized to near zero per context.

| Context type | Context ID example | ID length | Live override keys (3) | Tombstone key (1) |
|--------------|-------------------|-----------|------------------------|--------------------|
| Channel | `b68cd7cb-6f8d-4641-b743-a7349eb4114b` | 36 | 138 bytes | 45 bytes |
| Message | `msg:` + 64-hex event ID | 68 | 234 bytes | 77 bytes |
| Thread | `thread:` + 64-hex event ID | 71 | 243 bytes | 80 bytes |

Live-override bytes are unchanged by the reserved-namespace escaping
(below): every context ID Buzz actually generates (channel UUID,
`msg:hex64`, `thread:hex64`) is a no-op under `escape_context_key` — none
begin with `ov_` or `esc:` — so the escape marker costs 0 bytes in the
common case. Tombstone bytes are new in this revision: compaction no
longer drops the register to zero keys (see "Compaction behavior" below)
but a single `ov_c:` key with the counter ceiling.

Breakdown for channel context (worst real-world common case, live):
```
"ov_s:b68cd7cb-6f8d-4641-b743-a7349eb4114b":1    → 44 chars
"ov_c:b68cd7cb-6f8d-4641-b743-a7349eb4114b":0    → 44 chars
"ov_b:b68cd7cb-6f8d-4641-b743-a7349eb4114b":10   → 45 chars
                                          total  ≈ 138 bytes (+ 2 commas)
```

Tombstone floor for channel context (dead override after compaction):
```
"ov_c:b68cd7cb-6f8d-4641-b743-a7349eb4114b":3    → 45 chars ≈ 45 bytes
```

Candidate A for comparison: `{"counter":1,"tiebreak":"dev0","op":"SET","baseline":10}`
≈ 56 bytes per context as a JSON object, plus the top-level `overrides`
field overhead. However, this is moot since A's top-level field is erased
by legacy clients.

### Reserved key namespace

NIP-RS v1 context IDs are arbitrary UTF-8 (spec `:89`, `:113-114`), so a
pre-existing opaque context could legitimately begin with `ov_s:`,
`ov_c:`, or `ov_b:` and, once flattened into the same `contexts` map,
be misparsed as a control key for a *different* context.

**Reservation:** the 3-byte stem `ov_` and the escape marker `esc:` are
reserved at the spec-amendment level. A raw context ID that begins with
either is escaped on publish by prepending `esc:`, and unescaped on
receive by stripping exactly one leading `esc:` (`model.py:
escape_context_key`, `unescape_context_key`). This is a bijection, not
an idempotent no-op: a context literally named `esc:foo` escapes to
`esc:esc:foo` on the wire and unescapes back to exactly `esc:foo` on
receipt — the two operations are inverses, so no collision or data
loss occurs even for context IDs that already contain the marker.

**Cost:** zero bytes for every context ID Buzz generates today (channel
UUID, `msg:hex64`, `thread:hex64` — none start with `ov_` or `esc:`).
Only a context ID that happens to start with the reserved stem pays the
4-byte `esc:` prefix.

**Migration:** a context published unescaped by a client that predates
this amendment and that happens to start with `ov_` is a residual,
unsolved hazard — retroactive escaping cannot rewrite a blob the
publisher isn't aware of. This is a theoretical concern for the
reasons in the ">256-byte key drop hazard" section: Buzz's own key
shapes cannot trigger it, and no legacy client is known to generate
`ov_`-prefixed context IDs. Documented, not modeled further, per the
same practical-risk reasoning already applied to the 256-byte hazard
below.

**Verified:** `exhaustive.py::test_reserved_namespace_collision` — a
context literally named `ov_s:evil` round-trips through publish/receive
as frontier state (not misparsed as an override), and a real override on
a *different* context in the same blob is unaffected.

### Counter headroom (uint32)

Each counter (S, C) is a uint32: 2^32 - 1 = 4,294,967,295. At one
toggle per second, ~136 years. No practical concern for manual
right-click actions.

### >256-byte key drop hazard

Legacy `sanitizeContexts` drops any key with `len(key.encode('utf-8')) > 256`.
Adding the `ov_s:` prefix (5 bytes) to a context key creates a key of
`len(context_id) + 5` bytes. If the original context key is at or near
the 256-byte limit, the prefixed override key exceeds it and is silently
dropped by legacy sanitization.

In practice, context keys are UUIDs (36 bytes), hex event IDs (64-68 bytes),
or thread IDs (71 bytes) — all well under 256 bytes. The longest common
override key (`ov_b:thread:` + 64-hex = 76 bytes) has 180 bytes of
headroom. This hazard is theoretical but should be documented in the spec.

### 10,000-key validation limit

Legacy `isValidBlob` rejects blobs with >10,000 context keys. Live
override keys consume 3 entries per overridden context; a compacted
(tombstoned) override consumes 1:

| Overridden contexts | Live override keys | Typical frontier keys | Total | Headroom |
|--------------------|---------------------|-----------------------|-------|----------|
| 50 | 150 | ~500 | 650 | 93.5% |
| 100 | 300 | ~1,000 | 1,300 | 87% |
| 500 | 1,500 | ~2,000 | 3,500 | 65% |
| 3,000 | 9,000 | ~1,000 | 10,000 | 0% (limit) |

The 32 KiB byte budget is the binding constraint long before key count.

### Compaction behavior (tombstone-floor, policy-dependent)

**Revision note:** the prior "compacts to zero" design (delete-on-
dominance: a dead register was dropped entirely, 0 keys) is retracted.
Thufir's pass-3 review found a stale-replay resurrection: dropping all
`(S,C)` state made counters reusable, so a new local set/clear pair
restarting from `S=0,C=0` could be dominated by a delayed stale peer
snapshot on replay (`RegB(3,0,10)` → compact → `None` → local
set+clear → `RegB(1,2,20)` → stale replay merges in → `RegB(3,2,20)`,
`S>C`, resurrected). Fixed by a tombstone floor: any register with
recorded activity (S>0 or C>0) is *never* fully deleted — dead state
compacts to `RegB(0, max(S,C), 0)` instead of `None`. Only a virgin
register (never set, S==0 and C==0) has no ceiling to protect and
compacts to `None`.

**The compaction rule is now uniform across the dead cases — the
per-branch table collapses to a single test:**

| Condition | Clear-wins | Set-wins |
|-----------|-----------|----------|
| `override_set_b(reg)` is True (live) | Do not compact | Do not compact |
| `override_set_b(reg)` is False and `S>0 or C>0` (dead, ever-active) | Compact to tombstone floor `RegB(0, max(S,C), 0)` | Compact to tombstone floor (same) |
| `S == 0, C == 0` (virgin, never set) | Drop entirely (`None`) | Drop entirely (same) |

Because `override_set_b` is already policy-aware, "live" vs. "dead"
differs by policy exactly where it did before (`S == C, S > 0` is dead
under clear-wins, live under set-wins) — the tombstone floor rule itself
does not need to branch on policy; `compact_b` calls `override_set_b`
once and only tombstones the false branch.

Under clear-wins, a dead override compacts to the ~45-byte tombstone
(one `ov_c:` key, channel context) — **not** to zero, because `C` must
persist as the reuse-blocking ceiling. Under set-wins, `S == C` overrides
remain live and are never compacted (3 keys, ~138 bytes for channel
contexts) — unchanged from the prior revision.

**Proof obligation closed:** `exhaustive.py::test_deep_history_compaction`
(2,016-point parameter cube) and `test_tombstone_stale_merge_direct`
verify no resurrection and no loss of a genuinely-live override across
the compact → new-action → delayed-stale-delivery shape, for both
single-slot and 2-slot-split delivery, both tie policies.
`mutation.py::mutant_m4` reverts to the old delete-on-dominance rule and
reproduces the exact resurrection witness
(`final_reg=RegB(s=3, c=2, b=20)`, `override_is_set=True`) — confirming
the suite would have caught the defect this round was opened to fix.

### GC/tombstone behavior

**Override keys with `ov_` prefix (legacy prune):** Legacy
`pruneStaleContexts` only drops `msg:`/`thread:`-prefixed keys past the
7-day horizon. Unknown-prefix keys (including `ov_*`) are kept forever:

- **Permanent tombstones:** every override that is ever compacted while
  dead leaves a permanent `ov_c:` key (~45 bytes, channel context) — this
  is no longer a "harmless, can shrink to zero" cost; it is a durable
  floor kept forever to block stale-replay resurrection. This is the
  direct storage consequence of fixing the CRITICAL above and must be
  budgeted, not treated as free.
- **Live overrides:** an override still live (per `override_set_b`)
  keeps all 3 keys (~138 bytes, channel context) until it becomes dead
  and is compacted down to the tombstone.

**Alternative: nesting under `msg:`/`thread:` prefixes** — confirmed
**state-loss hazard**. Legacy prune would delete overrides at the 7-day
horizon, silently losing active unread markers. Rejected.

### Legacy trim interaction

Legacy `trimContextsToBudget` evicts only `msg:`/`thread:` keys.
Override `ov_*` keys (including tombstones) are never evicted. Budget
analysis by context type, worst case (all overrides still live, 3 keys
each — the tombstone floor only ever *reduces* this cost):

| Overridden contexts | Context type | Live override bytes | With ~10 KiB frontiers | Fits 32 KiB? |
|--------------------|-------------|----------------|----------------------|-------------|
| 50 | Channel (UUID) | ~6.9 KiB | ~16.9 KiB | Yes |
| 100 | Channel (UUID) | ~13.8 KiB | ~23.8 KiB | Yes |
| 150 | Channel (UUID) | ~20.7 KiB | ~30.7 KiB | Marginal |
| 50 | Message (hex64) | ~11.9 KiB | ~21.9 KiB | Yes |
| 100 | Message (hex64) | ~23.7 KiB | ~33.7 KiB | **No** |

At the 100-override cap with every override compacted to its tombstone
floor instead: ~4.5 KiB (channel contexts, 100 × 45 bytes) — well
within budget alongside a full frontier set. The permanent-tombstone
floor from the CRITICAL fix costs storage but is bounded and small; it
does not change the 32 KiB conclusion below.

**Mitigation:** Upgraded clients should compact aggressively (any dead
override, not just baseline-dominated ones) and enforce a cap on active
override count. A cap of 100 channel-context overrides keeps *live*
override budget under ~14 KiB and *tombstoned* budget under ~4.5 KiB,
both within the 32 KiB limit alongside a full frontier set.

### Tie policy evidence: clear-wins vs set-wins

Both tie policies pass all invariants. The choice is a product-semantics
decision:

- **Clear-wins (S == C → read):** If two devices concurrently set and
  clear the same context, the result is "read." Conservative — no
  spurious unread badges. Matches the "I already read this" signal being
  more definitive than the "remind me" signal. Compaction advantage:
  `S == C` states are compactable.
- **Set-wins (S == C → unread):** Concurrent set and clear results in
  "unread." Preserves the reminder intent. Risk: a user who reads on one
  device while another has a stale mark-unread gets a persistent badge
  they can't clear without an explicit action. Compaction disadvantage:
  `S == C` states are live and cannot be compacted.

**Recommendation:** Clear-wins. A false negative (missing badge) is
recovered by re-marking unread. A false positive (badge that won't clear)
is more frustrating. This matches Slack's behavior: reading anywhere
clears everywhere. The compaction advantage further favors clear-wins.

### Multi-slot union

Production splits blobs across up to 8 slots (`READ_STATE_MAX_SLOTS`).
`mergeReadStateEvents` merges all slots with per-context `max()`. Override
sibling keys are individual context entries and follow the same merge path.

Confirmed: splitting a published blob across 2 slots and delivering each
separately produces the same final override and frontier state as
delivering the full blob, regardless of delivery order.

## Mutation harness

6 mutants, all caught with recorded counterexamples:

| Mutant | Rule dropped | Counterexample |
|--------|-------------|----------------|
| M1 | Baseline dominance check | `RegB(1,0,10)` at frontier=100: correct=inactive, mutant=active (stale set persists) |
| M2 | `max(S,C)+1` counter bump | After set→set→clear: correct `RegB(2,3,10)` (clear wins), mutant `RegB(2,1,10)` (set persists) |
| M3 | Tie policy | `RegB(1,1,10)` at frontier=10: clear-wins=False, set-wins=True |
| M4 | Tombstone-floor compaction (delete-on-dominance revert) | `RegB(3,0,10)` at frontier=20 compacts to `None` (vs. tombstone `RegB(0,3,0)`); local set+clear reuses counters from zero; delayed stale replay resurrects — `final_reg=RegB(s=3,c=2,b=20)`, `override_is_set=True` (reproduces Thufir's pass-3 CRITICAL) |
| M5 | uint32 value range | Value 4,294,967,296 rejected by legacy sanitization |
| M6 | Componentwise-max merge | LWW delivery-order-dependent: convergence breaks under permutation |

Each mutant is injected into the model via DeviceB subclass (M1, M2, M4,
M6) or direct function evaluation (M3, M5), then the applicable invariant
suite is rerun. M4 reverts to the pre-fix delete-on-dominance compaction
rule and directly reproduces Thufir's pass-3 CRITICAL resurrection
witness — the exact `RegB(3,0,10)` → `None` → counter-reuse → stale
replay → `RegB(3,2,20)`,`override_is_set=True` sequence — with a
fallback to the directed deep-history cube (`test_deep_history_compaction`)
if the hand-built scenario doesn't trigger under a given tie policy.

## Recommendation

**Candidate B (two grow-only counters + baseline) with clear-wins tie
policy.**

Evidence:

1. **Legacy safety:** B's sibling keys survive legacy rewrite; A's
   top-level field is erased. Hard blocker for A — no migration path
   tolerates a single legacy device.
2. **Identity-free:** B needs no client_id for correctness; A's
   tiebreak creates a reinstall fragility.
3. **CRDT properties:** Both pass all merge invariants. B's
   componentwise max is simpler and more standard.
4. **Bytes:** B at 3 live keys costs 138 bytes/context (channel UUID) to
   243 bytes/context (thread hex64); a dead override compacts to a single
   ~45-80 byte tombstone key instead. Cap of 100 overrides stays within
   32 KiB budget for both live and tombstoned cases.
5. **Compaction:** B supports safe policy-aware compaction. Clear-wins
   allows compacting `S == C` states (set-wins does not).
6. **Tie policy:** Clear-wins avoids persistent false-positive badges
   and enables more aggressive compaction.

## Honest limits

- The model enumerates bounded abstract operations, not real encrypted
  NIP-59 payloads or relay replacement semantics.
- Counter values in the general BFS explorer are bounded by its exploration
  depth (max ~4 via BFS depth 4); the directed deep-history cube
  (`test_deep_history_compaction`) reaches counter values up to the stale
  parameter range (0-3) plus post-compaction action sequences, covering the
  ~9-transition witness the BFS explorer cannot structurally reach. Real
  uint32 overflow/wrap is tested only via the legacy sanitization mutant (M5).
- Two contexts are modeled. Production users may have hundreds of contexts,
  but the CRDT properties are per-context — cross-context interactions are
  limited to the shared byte budget (tested via trim/prune interaction).
- Multi-slot behavior is confirmed via split+merge convergence test, but
  the split algorithm itself (`splitContextsIntoBudgetedSlots`) is not
  modeled. Implementation-level testing is needed for slot placement.
- The model assumes eventual delivery (all blobs eventually reach all
  devices). Permanent message loss is not modeled.
- Byte sizes are computed from JSON serialization of realistic key names.
  Actual encrypted blob overhead (NIP-59 envelope, relay metadata) adds
  to the total but does not affect the 32 KiB plaintext budget.
