# Tasks — add-curator-signal

> **T0 IS TASK #1 AND BLOCKING.** No transport REQ (REQ-SG-02 → REQ-SG-08) may
> be marked DONE until T0's findings are written to
> `~/.pi-curator/probes/t0-results.md`. Every downstream task cites which T0
> answer resolved its CONDITIONAL status. See spec REQ-SG-01.

## 1. T0 Probe (BLOCKING — do first)

- [ ] 1.1 Write a probe script `~/.pi-curator/probes/t0-probe.ts` that spawns
      two minimal pi sessions (sender + receiver) both loading `pi-intercom`,
      registers them under stable names, and has the sender emit a tagged
      intercom message with `details: { kind: "steer", mainSessionId: "probe" }`
      and body text `[STEER] probe payload`.
- [ ] 1.2 In the receiver session, register an extension hook that dumps the
      FULL delivered message object (customType, content, details, sender info)
      to `~/.pi-curator/probes/t0-results.md`. Answer T0-Q1 (does `details.kind`
      survive?), T0-Q2 (what `customType` is observed?), T0-Q4 (does the
      `[STEER]` prefix survive body reformatting?).
- [ ] 1.3 Run a SECOND probe variant with the receiver in non-interactive mode
      (`pi -p`) AND busy (looping a tool call) while the sender emits. Answer
      T0-Q3: does the auto-reply in `pi-intercom/index.ts:670-687` fire BEFORE
      any extension hook? Document observed behavior in t0-results.md.
- [ ] 1.4 Based on T0 results, update design.md with the confirmed kind-recovery
      stage (i) / (ii) / (iii) per D-C2/C4, and confirm or revise D-C3 path
      choice. If T0 forces D-H10-FALLBACK, add the D-H10-DEVIATION Decision Log
      entry NOW (before any code).
- [ ] 1.5 Commit t0-results.md and the updated design.md. Tag this commit;
      every downstream task references it.

## 2. Main-side receiver extension scaffold

- [ ] 2.1 Create `src/curator-receiver/index.ts` (or
      `profile/extensions/curator-receiver/` if landing in pi-plugins — confirm
      target with lead). Default export an extension registering a hook for
      incoming intercom messages.
- [ ] 2.2 Wrap the ENTIRE handler in try/catch (REQ-SG-09). On exception: log
      to `ui.notify`/`ui.setStatus` with `display:false`, never re-throw, never
      block the main turn.
- [ ] 2.3 Implement sender-based filtering (REQ-SG-03): match the delivered
      message's sender against the curator list provided by
      `add-cursor-lifecycle`. Cross-reference lifecycle's task that exposes
      `curatorsForMain(mainSessionId)`. Loose fallback: match senders whose
      name starts with `curator` and log a warning.
- [ ] 2.4 Implement session-targeting verification (REQ-SG-11): compare
      delivered `mainSessionId` against this main's session id; ignore
      mismatches.

## 3. Kind recovery + delivery mapping

- [ ] 3.1 Implement kind recovery per REQ-SG-04 and the T0-confirmed stage
      (cite t0-results.md commit). Primary: parse `[STEER]`/`[APPEND]` prefix
      from body. Fallback stages (ii)/(iii) only if T0 disproved (i).
- [ ] 3.2 Implement `steer` mapping (REQ-SG-05):
      `pi.sendMessage({customType:"curator_steer", content, display:true},
      {triggerTurn:true, deliverAs:"steer"})`. Mirror
      `todo-enforcer/index.ts:226-236`.
- [ ] 3.3 Implement `append` mapping (REQ-SG-06):
      `pi.sendMessage({customType:"curator_append", content, display:<persona
      default false>}, {deliverAs:"nextTurn"})`. NO `triggerTurn`. Document in
      code comment WHY `nextTurn` not `followUp` (idle stall trap,
      todo-enforcer index.ts:200-212).
- [ ] 3.4 Unrecoverable kind falls back to `steer` (REQ-SG-04 safe default).

## 4. Non-interactive + broker-down fallback file

- [ ] 4.1 If T0 confirmed C3 (expected: auto-reply blocks hooks), implement
      REQ-SG-07: when main is `ctx.mode === "rpc"`, the curator prose prompt
      branch writes findings to
      `~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl` instead of
      intercom. Coordinate the prose-prompt branch with `add-curator-lifecycle`
      (it owns the prompt).
- [ ] 4.2 Implement REQ-SG-08 broker-unreachable fallback: curator retries
      intercom send once, then writes the same fallback findings file.
- [ ] 4.3 Cross-ref `add-curator-lifecycle` task for `/curator status` to read
      and surface the fallback findings file. This change does NOT implement
      the slash command — it only guarantees the file format is stable.

## 5. D-H10-FALLBACK (ONLY if T0 forces it)

- [ ] 5.1 ONLY run this section if t0-results.md shows body prefix parsing
      fails AND `details.kind` does not round-trip. Otherwise SKIP — locked
      decision is prose-prompt (D-H10).
- [ ] 5.2 Add the `D-H10-DEVIATION` Decision Log entry to design.md with the
      one-line rationale (prose-prompt prefix does not survive re-emit per T0).
- [ ] 5.3 Implement a thin curator-side `signal_main(kind, message)` tool that
      wraps `intercom send` with `customType:"curator_signal_steer"` /
      `"curator_signal_append"` (the suffix IS in the always-forwarded
      customType field per D-C2/C4 stage iii).
- [ ] 5.4 Update REQ-SG-02 and REQ-SG-04 in spec to cite the deviation path.

## 6. Tests + smoke

- [ ] 6.1 Unit test: receiver drops unknown senders (REQ-SG-03 scenario).
- [ ] 6.2 Unit test: receiver maps steer → `{triggerTurn:true, deliverAs:"steer"}`
      (REQ-SG-05).
- [ ] 6.3 Unit test: receiver maps append → `{deliverAs:"nextTurn"}`,
      `triggerTurn` absent (REQ-SG-06).
- [ ] 6.4 Unit test: receiver swallows malformed signal + thrown exception
      (REQ-SG-09 scenarios).
- [ ] 6.5 Unit test: session-targeting mismatch ignored (REQ-SG-11).
- [ ] 6.6 Integration smoke (requires `add-curator-lifecycle` to exist):
      spawn a curator, have it emit a `[STEER]` finding and an `[APPEND]`
      finding, assert main receiver delivers per the kind map. Mark SKIPPED
      with a note if lifecycle is not yet merged.

## 7. No-email-bus + cross-refs

- [ ] 7.1 Grep the signal layer for `email_pub` / `email_sub` calls (REQ-SG-10);
      assert none exist.
- [ ] 7.2 Confirm no spawn/fork/janitor/persona-config/trim logic leaked into
      this change (REQ-SG-12) — all owned by `add-curator-lifecycle`.
- [ ] 7.3 Final `openspec status --change add-curator-signal` clean.

## Deferred (own future changes — NOT this change)

| DEF | Item | Own change |
|-----|------|-----------|
| DEF-1 | H9 probe: does `display:false` hide curator signals from ACP/team delegated branches? | `probe-curator-signal-display-visibility` (only if delegated-branch hiding becomes a real requirement) |
| DEF-2 | Cross-session scope (`scope:"all-sessions"`) | `curator-cross-session-scope` |
| DEF-3 | Mailbox reader (only if intercom proves insufficient post-T0) | `add-pi-curator-mailbox` |
| DEF-4 | Cross-check protocol | `add-pi-curator-crosscheck` |
| DEF-5 | email-bus-based transport (locked decision: WIP, do not depend) | `curator-email-bus-transport` (when email-bus stabilizes) |
