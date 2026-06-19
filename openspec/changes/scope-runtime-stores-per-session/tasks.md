## 1. Path derivation

- [x] 1.1 Update `getRuntimePaths` / `ensureRuntimeDir` to accept a `sessionId` and append `<sessionId>/` to the base root for session-scoped files
- [x] 1.2 Split the path contract: session-scoped files (`tasksFile`, `mailboxesFile`, `governanceFile`, `workersFile`) resolve under `<root>/<sessionId>/`; global files (`sessionNameRegistryFile`, `sessionArchiveFile`, `eventLogFile`) resolve directly under `<root>/`
- [x] 1.3 Add unit tests in `runtime-paths.test.ts` covering: session-scoped paths include `<sessionId>/`, global paths do not, custom `rootDir` override still appends session segment

## 2. Store constructor signature changes

- [x] 2.1 Add required `sessionId: string` (plus keep optional `rootDir`) to: `AcpTaskStore`, `MailboxManager`, `GovernanceStore`, `WorkerStore` (the 4 session-scoped stores)
- [x] 2.2 Throw synchronously when `sessionId` is missing/empty on those four stores (no silent global fallback)
- [x] 2.3 Leave `SessionNameStore`, `SessionArchiveStore`, and `AcpEventLog` signatures unchanged — they remain global (they catalog/audit sessions themselves)
- [x] 2.4 Update each store's `read()`/`write()` to use the new session-scoped path from `getRuntimePaths(this.rootDir, this.sessionId)`

## 3. Wiring (adapter / coordinator / index)

- [x] 3.1 Find where stores are instantiated in `src/index.ts`, `src/coordination/coordinator.ts`, `src/coordination/worker-dispatcher.ts` (grep `new AcpTaskStore`, `new MailboxManager`, etc.)
- [x] 3.2 Pass the current session ID into every session-scoped store constructor
- [x] 3.3 Verify `acp_task_*`, `acp_message_*`, `acp_task_assign`, `claimNextAvailable` flows all receive a session-scoped store instance

## 4. Legacy migration

- [x] 4.1 Add `migrateLegacyLayout(root)` that moves flat `tasks.json`, `mailboxes.json`, `governance.json`, `workers.json` from root into `<root>/legacy/` (the 4 session-scoped store files)
- [x] 4.2 Guard with idempotency: skip if `legacy/` already exists; use atomic `rename()` per file
- [x] 4.3 Add concurrency guard: write a `legacy/.migrating` marker before starting, remove on completion
- [x] 4.4 Leave `session-name-registry.json`, `session-archive.json`, and `events.jsonl` at root (global)
- [x] 4.5 Invoke `migrateLegacyLayout` once at coordinator boot, before any store opens
- [x] 4.6 Add migration tests: first-run relocates files, second-run no-op, concurrent-boot marker behavior

## 5. Test updates

- [x] 5.1 Update existing store tests (`task-store.test.ts`, `management-stores.test.ts`, etc.) to pass a `sessionId` at construction
- [x] 5.2 Add isolation test: two `AcpTaskStore` instances with different session IDs cannot see each other's tasks
- [x] 5.3 Add isolation test for `MailboxManager` and `WorkerStore` (message/worker from session A invisible to session B)
- [x] 5.4 Add "throws on missing sessionId" test for each of the four session-scoped stores
- [x] 5.5 Run full test suite (`npm test` or equivalent) and confirm green

## 6. Docs & cleanup

- [x] 6.1 Update `README.md` / `flow/findings/` runtime layout notes to reflect `<root>/<sessionId>/` structure
- [x] 6.2 Document rollback procedure (copy `legacy/*.json` back to root) in change closure notes
- [x] 6.3 Run `openspec validate scope-runtime-stores-per-session` and confirm the change passes validation
