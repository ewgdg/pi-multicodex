# THROWAWAY: filesystem usage coordination

This branch-only prototype is not production code and is not integrated with MultiCodex.

## Exact question

Can short filesystem leases plus atomic state replacement usually coalesce cross-process usage refreshes while recovering inspectably from crashes, suspension, malformed state, missed hints, and rename failure?

## Run

```sh
pnpm prototype:usage-coordination
```

That starts an interactive scenario picker. Run every scenario noninteractively with:

```sh
pnpm prototype:usage-coordination --all
```

The prototype uses real Node child processes and a retained temporary directory. Every protocol action emits the complete account-scope filesystem view, followed by each scenario's final state and verdict.

Shared state deliberately has no schema-version field. Known coordination fields are validated, while additive unknown fields are preserved during read-merge-publish mutations.

## Deliberate limits

- Local filesystems only; NFS, SMB, and virtualization-mounted coordination roots are outside the question.
- Leases are advisory, not locks. Recovery can overlap a resumed owner, and the demo explicitly accepts rare last-writer-wins publication.
- Wall-clock expiry and short timings are compressed for observation, not production values.
- Watcher loss is modeled by deliberately withholding a hint, then reconciling from canonical state. This does not evaluate `fs.watch()` quality.
- No production imports, integration, reusable package, or test suite. Delete this prototype after the protocol decision is captured.
