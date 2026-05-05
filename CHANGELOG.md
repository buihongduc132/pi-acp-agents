# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-05-05

### Added

- Extracted as standalone repository from pi-plugins monorepo
- Production-grade package structure (files whitelist, engines, scripts)
- SKILL.md for pi skill discovery
- GitHub Actions CI workflow
- Comprehensive test suite (36+ tests)
- `acp_delegate` — short-lived task delegation
- `acp_broadcast` — parallel multi-agent broadcast
- `acp_compare` — structured response comparison
- TUI widget for session status display
- Circuit breaker resilience (closed/open/half-open)
- Background health monitor with stale session cleanup
- Busy-session mutex (concurrent prompt guard)
- Per-session JSON-RPC trace logging
- `/acp-config` slash command

### Changed

- Package name: `@walodayeet/pi-acp-agents`
- Repository: standalone GitHub repo

## [0.1.0] - 2025-05-04

### Added

- Initial release within pi-plugins monorepo
- Core tools: `acp_prompt`, `acp_status`, `acp_session_new`
- Session management: `acp_session_load`, `acp_session_set_model`, `acp_session_set_mode`
- `acp_cancel` for ongoing prompt cancellation
- Gemini CLI adapter with auto-authentication
- Custom adapter for user-defined ACP commands
- Config file support at `~/.pi/acp-agents/config.json`

[0.2.0]: https://github.com/buihongduc132/pi-acp-agents/releases/tag/v0.2.0
[0.1.0]: https://github.com/buihongduc132/pi-acp-agents/releases/tag/v0.1.0
