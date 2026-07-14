# Portable ephemeral Usage Broker IPC

Research for [Evaluate portable ephemeral broker IPC primitives](https://github.com/ewgdg/pi-multicodex/issues/8).

## Question

Which Node process, IPC, and lifecycle primitives can provide a launcher-independent, auto-spawned, ephemeral Usage Broker across Linux, macOS, and Windows?

## Recommendation

Use a standalone Node process with:

- `node:net` stream IPC:
  - filesystem Unix-domain socket on Linux and macOS;
  - Windows named pipe under `\\.\pipe\`;
- a deterministic hashed endpoint scoped by canonical Pi agent directory, OS user identity, and protocol major version;
- `spawn(process.execPath, [packagedBrokerEntry], { detached: true, stdio: "ignore", windowsHide: true })`, followed by `unref()`;
- four-byte big-endian length-prefixed, size-capped JSON frames with explicit write backpressure;
- endpoint bind as final broker authority, with an exclusive-create startup lease used only to suppress duplicate spawning and serialize stale Unix-socket recovery;
- idle shutdown only after no clients, unregistered connections, in-flight refreshes, or queued outbound work remain for the full grace period;
- client reconnect with bounded jittered backoff and extension-lifecycle generation guards;
- a packaged JavaScript `.mjs` broker entry rather than TypeScript, `tsx`, `npx`, or a launcher-relative script.

This is portable for ordinary desktop launches. Absolute launcher independence cannot be guaranteed on Windows using Node primitives alone: libuv detached spawning does not request `CREATE_BREAKAWAY_FROM_JOB`, so a launcher-controlled Windows Job Object may still terminate the broker.

## IPC transport

Node exposes one IPC interface through `net.Server.listen(path)` and `net.createConnection(path)`, while mapping paths to the platform-native transport:

- Unix-domain sockets outside Windows;
- named pipes on Windows.

This keeps framing, connection handling, broker behavior, and the client interface shared. Only endpoint construction and stale-path cleanup vary by platform.

Filesystem Unix sockets survive process crashes and are automatically removed only after a normal server close. Windows named pipes disappear when their final handle closes. Linux abstract sockets avoid filesystem debris but are Linux-only and do not provide the private-directory access boundary needed by the cross-platform design.

Node binds pipes with `UV_PIPE_NO_TRUNCATE`, rejecting oversized Unix socket paths instead of silently truncating them. Keep the endpoint short enough for macOS, whose practical pathname limit is lower than Linux.

Primary sources:

- [Node 24.17 IPC path behavior](https://nodejs.org/download/release/v24.17.0/docs/api/net.html#identifying-paths-for-ipc-connections)
- [Node `pipe_wrap.cc`](https://github.com/nodejs/node/blob/v24.17.0/src/pipe_wrap.cc#L162-L168)
- [libuv Unix pipe implementation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/unix/pipe.c)
- [libuv Windows named-pipe implementation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/pipe.c#L704-L801)
- [Node long-pipe-path test](https://github.com/nodejs/node/blob/v24.17.0/test/parallel/test-net-pipe-with-long-path.js)
- [POSIX `sockaddr_un`](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/sys_un.h.html)

## Scope-specific endpoint naming

Do not embed or sanitize the full agent-directory path into the endpoint. That can expose path details, collide after sanitization, and exceed platform path limits.

Build scope identity from:

1. protocol namespace and major version;
2. canonical absolute Pi agent directory;
3. OS user identity.

Hash that input with SHA-256 and retain a fixed-length prefix.

Recommended endpoint shapes:

- Unix: a short private per-user runtime directory containing `usage-broker-v1-<hash>.sock`;
- Windows: `\\.\pipe\pi-multicodex-usage-v1-<hash>`.

Canonicalize the agent directory before hashing so symlink aliases do not create separate brokers. Preflight Unix endpoint UTF-8 byte length against the macOS constraint before binding.

## Simultaneous startup

Endpoint bind is the final startup authority:

- first broker to bind wins;
- competing brokers receive `EADDRINUSE`, health-check the winner, then exit;
- Windows leaves no stale pipe pathname;
- Unix requires stale socket recovery after crashes.

Recommended client startup sequence:

1. Attempt a protocol health connection.
2. If unavailable, acquire a startup lease through exclusive `wx` creation inside the private runtime directory.
3. Repeat the health check after acquiring the lease.
4. On Unix only, after a definite failed connection, `lstat()` the endpoint.
5. Remove it only when it is a socket inside the verified private runtime directory.
6. Spawn the broker and retain the startup lease until an authenticated health response succeeds.
7. Other contenders wait and retry health rather than spawning immediately.
8. The broker never blindly unlinks an endpoint before binding.

The startup lease is advisory, not a correctness boundary. PID reuse, suspension, and check-then-unlink races prevent strict ownership. The endpoint bind decides the winner, and refresh work must tolerate rare duplicate brokers during stale recovery.

`pi-intercom` provides useful project evidence for the auto-spawn pattern, but its current broker unconditionally unlinks the Unix socket before binding. MultiCodex should not copy that unsafe recovery step.

Primary sources:

- [POSIX `bind()` and `EADDRINUSE`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/bind.html)
- [pi-intercom broker spawn implementation](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/spawn.ts)
- [pi-intercom broker implementation](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/broker.ts)

## Message framing and backpressure

Unix-domain sockets and Windows byte-mode pipes are streams. They do not preserve application message boundaries.

Use this frame format:

1. unsigned four-byte big-endian payload length;
2. UTF-8 JSON payload.

Protocol constraints:

- reject lengths above a fixed maximum before buffering the payload;
- validate every decoded message;
- require a capability-authenticated protocol handshake before serving health or usage requests;
- correlate request and response messages with IDs;
- build each frame into one buffer;
- serialize writes per socket;
- stop writing when `socket.write()` returns `false` and resume after `drain`;
- bound queued bytes per client and disconnect slow consumers;
- treat write callbacks as local OS-buffer acceptance, not remote acknowledgement.

Node warns that ignoring write backpressure can cause unbounded buffering and eventual process failure. `pi-intercom` demonstrates correct length-prefixed parsing and a one-megabyte frame cap, but its current writer does not handle a `false` return from `socket.write()`.

Primary sources:

- [Node writable stream backpressure](https://nodejs.org/download/release/v24.17.0/docs/api/stream.html#writablewritechunk-encoding-callback)
- [pi-intercom framing](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/framing.ts)

## Permissions and authentication

### Unix

Create and verify a broker runtime directory that:

- belongs to the current UID;
- has mode `0700`;
- is a real directory rather than a symlink;
- contains all socket and startup artifacts.

The private parent directory is the main access boundary. The socket may additionally use mode `0600`. Do not change process-wide `umask()` from the extension.

### Windows

Node/libuv passes default security attributes to `CreateNamedPipeW`. Microsoft documents a default named-pipe DACL that can grant read access beyond the creator, and libuv does not request `PIPE_REJECT_REMOTE_CLIENTS`. Node core does not expose custom named-pipe DACL or peer-SID configuration.

A deterministic pipe name is therefore not authentication. Require a random scope capability stored under the private Pi agent directory and presented before any health or usage response. The capability file is fixed broker bootstrap state, not usage coordination state.

If strict same-user Windows ACL enforcement is mandatory, Node core alone is insufficient; use a native helper or binding.

Primary sources:

- [Microsoft named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft `CreateNamedPipe`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
- [libuv Windows named-pipe creation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/pipe.c#L704-L801)

## Detached and hidden spawning

Use:

```ts
spawn(process.execPath, [brokerEntry], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  cwd: runtimeDirectory,
  env: minimalBrokerEnvironment,
}).unref();
```

Rationale:

- Unix libuv uses `setsid()` for detached children.
- Windows libuv requests `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`.
- `windowsHide` hides the console window and may request `CREATE_NO_WINDOW` when stdio is not inherited.
- Ignored or separately redirected stdio prevents the broker retaining the parent terminal.
- `process.execPath` supplies the resolved Node executable.
- `fork()` is unnecessary because its parent-child IPC channel preserves coupling the broker does not need.

Windows caveat: libuv intentionally does not request `CREATE_BREAKAWAY_FROM_JOB`. A child normally remains subject to an inherited Windows Job Object. Direct hidden spawning therefore requires real Windows tests under command shells, terminals, CI, and expected Pi launchers.

Primary sources:

- [Node detached child-process documentation](https://nodejs.org/download/release/v24.17.0/docs/api/child_process.html#optionsdetached)
- [Node `windowsHide`](https://nodejs.org/download/release/v24.17.0/docs/api/child_process.html#child_processspawncommand-args-options)
- [libuv Windows process flags](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/process.c#L1020-L1064)
- [libuv Unix `setsid()`](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/unix/process.c#L317-L319)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## Broker lifecycle

Broker idle shutdown must account for all broker work, not only registered clients.

Arm idle detection at startup. Shut down only when the full grace period has elapsed with:

- no registered clients;
- no accepted but unregistered sockets;
- no in-flight refresh assignment;
- no pending response or outbound queue.

On shutdown:

1. stop accepting connections;
2. drain or close client sockets;
3. await server close;
4. allow Node/libuv to remove the Unix socket;
5. set `process.exitCode` and let the event loop finish.

Do not call `process.exit()` immediately after `server.close()`, because Node warns that forced exit can abandon pending asynchronous I/O.

Primary source:

- [Node `process.exit()` warning](https://nodejs.org/download/release/v24.17.0/docs/api/process.html#processexitcode)

## Client reconnect and extension reload

Client requirements:

- fail ambiguous in-flight requests when disconnected;
- reconnect with bounded exponential backoff and jitter;
- rerun spawn-if-needed and registration after each reconnect;
- guard delayed startup, reconnect, and callback work with an extension-runtime generation;
- invalidate the generation and disconnect the old client during shutdown or reload;
- resubmit locally cached snapshots and pending invalidations after broker restart;
- do not replay a refresh unless request IDs and attempt-token semantics make the replay idempotent.

`pi-intercom` provides useful patterns for reconnect backoff and lifecycle-generation guards.

## Packaging

Ship a self-contained JavaScript broker entry and include it in the package allowlist. Verify inclusion with `npm pack --dry-run`.

Do not launch packaged TypeScript directly:

- Node 24 can strip erasable TypeScript in ordinary source files;
- Node explicitly refuses TypeScript under `node_modules`;
- Pi installs npm packages into managed npm roots.

A packaged `.mjs` entry avoids `tsx`, `npx`, shell lookup, package-manager layout assumptions, and launcher-relative paths.

Primary sources:

- [Node TypeScript in dependencies](https://nodejs.org/download/release/v24.17.0/docs/api/typescript.html#type-stripping-in-dependencies)
- [Pi package installation](https://github.com/earendil-works/pi-mono/blob/v0.74.0/packages/coding-agent/docs/packages.md)

## Required prototype checks

1. Linux and macOS crash leaving a socket, followed by simultaneous recovery from 2–20 clients.
2. Startup lease owner killed, suspended past stale threshold, and resumed.
3. Endpoint path aliases, Unicode, long paths, and Windows case differences.
4. Named-pipe simultaneous bind, pipe squatting, wrong protocol, and unauthenticated clients.
5. Direct Windows `detached + stdio: "ignore" + windowsHide` under command shells, terminals, Pi package launch, CI, and Job Objects.
6. Parent exits immediately after broker spawn while another client remains connected.
7. Fragmented headers and payloads, coalesced frames, oversized frames, malformed JSON, and slow/non-reading peers.
8. Broker death before request, during refresh, after accepting a result, and before responding.
9. Last client disconnect during active refresh and reconnect during idle-shutdown transition.
10. Extension reload while startup or reconnect promises remain pending.
11. Installed npm tarball launch from paths containing spaces and a read-only package directory.
12. Node-only broker launch without `tsx`, `npx`, Bun, shell resolution, or inherited `NODE_OPTIONS`.

## Design implications

- Use one Node `net` client interface with Unix-socket and Windows-pipe endpoint adapters.
- Keep usage state ephemeral, but permit fixed private bootstrap artifacts for scope capability and startup serialization.
- Treat endpoint bind as broker authority; the filesystem lease only reduces duplicate spawning.
- Broker attempt tokens can reject late refresh results centrally without immutable result files or filesystem fencing.
- Prototype Windows security and process-lifetime behavior before claiming launcher independence.
