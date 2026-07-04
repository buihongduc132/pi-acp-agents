# _STATE — pi-acp-agents (local machine state)

Local, non-committed setup state. Per project convention (`<promptDir>/agents/common/state/`). Update whenever something is configured manually and NOT fully automated in git.

## 2026-07-04 — agent-profile-description backfill

- Backfilled `description` into the live `~/.pi/acp-agents/config.json` for all 7 canonical aliases (`claude`, `pi`, `verifier`, `coder`, `browser-tester`, `red`, `general`).
- Source of truth for the descriptions: `docs/agent-profiles-example.json` (canonical example) + `AGENTS.md` "Agent profiles vs servers" table.
- This is a one-off manual edit — not yet automated. If the live config is regenerated from the canonical example or redeployed, re-apply the same descriptions (or source them directly from `docs/agent-profiles-example.json`).
- Verified: `python3 -c "import json; c=json.load(open('/home/bhd/.pi/acp-agents/config.json')); print({k: v.get('description','<MISSING>')[:40] for k,v in c['agent_servers'].items()})"` shows all 7 populated.

### ⚠️ CA (callsout) — runtime config data-loss event

During this session, `~/.pi/acp-agents/config.json` (the path `loadConfig()` reads via `CONFIG_PATH = join(homedir(), ".pi", "acp-agents", "config.json")`) was WIPED: the directory was recreated at 2026-07-04 09:37 with only `logs/` and `runtime/` subdirs, no `config.json`. The operator's 5 customized agent profiles (verifier, coder, browser-tester, red, general — each with `systemPrompt` paths) existed ONLY at this runtime path and were NOT in any `~/.pi/.backup.*/acp-agents/config.json` (backups only carry the 2-agent shipped default: claude + pi).

Reconstructed + restored from content captured at session start (the original `cat` output), with descriptions added. SystemPrompt paths preserved exactly:
- verifier → `/home/bhd/.agents/skills/wear-hats/references/_agent/verifier.md`
- coder → `/home/bhd/.hermes/profiles/coder/SOUL.md`
- browser-tester → `/home/bhd/.hermes/profiles/hermes-tester/SOUL.md`
- red → `/home/bhd/.pi/acp-agents/prompts/red.md`
- general → `/home/bhd/.pi/agent/APPEND_SYSTEM.md`

**Gap to fix**: the runtime config at `~/.pi/acp-agents/config.json` is fragile — it is not covered by the `~/.pi/.backup.*` rotation (which only backs up `~/.pi/agent/`, the prod stage) and can be wiped when the dir is recreated. Recommend: (1) source-of-truth the operator's full config into a tracked file (e.g. commit a `~/.pi/acp-agents/config.json` equivalent into a profile repo), OR (2) extend `ensureRuntimeDir`/backup to cover `~/.pi/acp-agents/config.json`. Until then, any manual edit there is at risk.
