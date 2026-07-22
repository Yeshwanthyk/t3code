# Pi 0.80.10 RPC evidence fixtures

These redacted stdout fixtures are derived from the installed
`@earendil-works/pi-coding-agent` 0.80.10 `docs/rpc.md` and
`dist/modes/rpc/rpc-types.d.ts`. They contain protocol records only; stderr is
tested as a separate bounded byte stream.

- `startup-state.stdout.jsonl` proves correlated startup state and that
  `model.input`, not a provider-name heuristic, advertises image input.
- `resume-replay.stdout.jsonl` proves that a successful `switch_session` may
  still be cancelled, state identity must be verified, and durable replay uses
  `get_entries`. Entry IDs are session-local, so dedupe keys must also include
  `sessionId`.
- `turn-stream.stdout.jsonl` proves prompt acceptance is distinct from streamed
  work and that retry plus `agent_end` precedes authoritative `agent_settled`.
- `controls-ui.stdout.jsonl` proves model/thinking command responses, thinking
  readback, slash-command discovery, abort settlement, and documented extension
  UI request envelopes.
- `malformed.stdout.jsonl`, `oversized.stdout.jsonl`, and
  `process-failure.stderr.txt` exercise fail-closed framing and separate bounded
  diagnostics. Process exit and pending-command rejection belong to the scoped
  transport tests, not the stdout codec.

Pi 0.80.10 doesn't document `subagent_spawn` as a core RPC event. The decoder
therefore rejects it as unsupported until a companion extension contract owns
and versions that shape.
