/**
 * pi-acp-agents — Extension safety module (R-SP1, R-SP4).
 *
 * Provides base-detection, safe activation guards, and version
 * compatibility checks for the pi-acp-advanced extension package.
 *
 * R-SP1: Extension MUST fail loudly but never crash when base is missing.
 * R-SP4: Extension MUST declare and verify minimum base version.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── R-SP1: Base detection ──────────────────────────────────────────────────

export interface BaseDetectionResult {
	/** Whether the base package runtime is available */
	ok: boolean;
	/** Runtime directory path (only when ok=true) */
	runtimeDir?: string;
	/** Config file path (only when ok=true) */
	configFile?: string;
	/** Human-readable warning (only when ok=false) */
	warning?: string;
	/** Base version string (only when ok=true and detectable) */
	baseVersion?: string;
}

/**
 * Detect whether the pi-acp-agents base package is loaded and configured.
 *
 * Checks:
 * 1. Runtime directory exists (~/.pi/acp-agents/)
 * 2. Config file exists (~/.pi/acp-agents/config.json)
 * 3. Config contains at least one agent_server entry (base is initialized)
 *
 * Returns a result object with ok=true/false and context.
 */
export function detectBaseLoaded(runtimeDirOverride?: string): BaseDetectionResult {
	const runtimeDir = runtimeDirOverride ?? join(homedir(), ".pi", "acp-agents");
	const configFile = join(runtimeDir, "config.json");

	if (!existsSync(runtimeDir)) {
		return {
			ok: false,
			warning: `⚠️ pi-acp-advanced requires pi-acp-agents to be installed and loaded first.\n   Runtime dir missing: ${runtimeDir}\n   Fix: Add "npm:pi-acp-agents" to your settings.json packages BEFORE "npm:pi-acp-advanced".\n   Extension is inactive until base is available.`,
		};
	}

	if (!existsSync(configFile)) {
		return {
			ok: false,
			warning: `⚠️ pi-acp-advanced requires pi-acp-agents config at ${configFile}.\n   Fix: Add "npm:pi-acp-agents" to your settings.json BEFORE "npm:pi-acp-advanced".\n   Extension is inactive until base is available.`,
		};
	}

	// Config exists — check if base has been initialized (has agent_servers)
	let baseVersion: string | undefined;
	try {
		const raw = readFileSync(configFile, "utf-8");
		const config = JSON.parse(raw);
		const hasAgents = config.agent_servers && Object.keys(config.agent_servers).length > 0;
		if (!hasAgents) {
			return {
				ok: false,
				warning: `⚠️ pi-acp-agents runtime dir exists but no agents are configured.\n   Fix: Configure at least one agent in ${configFile}, then restart pi.\n   Extension is inactive until base has agents.`,
			};
		}
		// Try to read base version from package.json in parent dir
		try {
			const pkgPath = join(runtimeDir, "../../agent/git/github.com/buihongduc132/pi-acp-agents/package.json");
			if (existsSync(pkgPath)) {
				baseVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
			}
		} catch {
			// Version detection is best-effort
		}
	} catch {
		// Corrupt config file — treat as not loaded
		return {
			ok: false,
			warning: `⚠️ pi-acp-agents config file at ${configFile} is corrupt or unreadable.\n   Fix: Restore a valid config.json or reconfigure pi-acp-agents.`,
		};
	}

	return { ok: true, runtimeDir, configFile, baseVersion };
}

// ── R-SP1: Safe activation guard ───────────────────────────────────────────

export interface ActivationResult {
	activated: boolean;
	warning?: string;
}

/**
 * Attempt to activate the extension safely.
 *
 * If base is not loaded, returns { activated: false, warning: ... }.
 * If base is loaded, returns { activated: true }.
 *
 * Never throws — caller should use the result to decide whether
 * to register tools.
 */
export function activateExtensionSafely(runtimeDirOverride?: string): ActivationResult {
	try {
		const detection = detectBaseLoaded(runtimeDirOverride);
		if (!detection.ok) {
			return { activated: false, warning: detection.warning };
		}
		return { activated: true };
	} catch (err) {
		// Absolute safety net — never crash
		const msg = err instanceof Error ? err.message : String(err);
		return {
			activated: false,
			warning: `⚠️ pi-acp-advanced failed during base detection: ${msg}\n   Extension is inactive. Fix the error above and restart pi.`,
		};
	}
}

// ── R-SP4: Version compatibility ───────────────────────────────────────────

export interface VersionCheckResult {
	compatible: boolean;
	currentVersion?: string;
	requiredVersion: string;
	warning?: string;
}

/** Minimum base version required by the extension */
export const MIN_BASE_VERSION = "0.3.0";

/**
 * Parse a semver string into [major, minor, patch].
 * Returns null for invalid input.
 */
function parseSemver(version: string): [number, number, number] | null {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/**
 * Compare two semver tuples: returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
	if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
	if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
	if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
	return 0;
}

/**
 * Check whether the detected base version is compatible with the extension.
 *
 * @param baseVersion The version string detected from the base package
 * @param requiredVersion Minimum required version (default: MIN_BASE_VERSION)
 * @returns VersionCheckResult with compatibility status
 */
export function checkVersionCompatibility(
	baseVersion: string | undefined,
	requiredVersion: string = MIN_BASE_VERSION,
): VersionCheckResult {
	if (!baseVersion) {
		return {
			compatible: false,
			requiredVersion,
			warning: `⚠️ Cannot determine pi-acp-agents version. Extension requires >=${requiredVersion}.\n   Fix: Ensure pi-acp-agents is installed and properly initialized.`,
		};
	}

	const current = parseSemver(baseVersion);
	const required = parseSemver(requiredVersion);

	if (!current) {
		return {
			compatible: false,
			currentVersion: baseVersion,
			requiredVersion,
			warning: `⚠️ Invalid base version format: "${baseVersion}". Expected semver (e.g., 0.3.0).`,
		};
	}

	if (!required) {
		// If required version is invalid, assume compatible (don't block)
		return { compatible: true, currentVersion: baseVersion, requiredVersion };
	}

	if (compareSemver(current, required) < 0) {
		return {
			compatible: false,
			currentVersion: baseVersion,
			requiredVersion,
			warning: `⚠️ pi-acp-advanced requires pi-acp-agents >=${requiredVersion} (found: ${baseVersion}).\n   Fix: npm i pi-acp-agents@latest`,
		};
	}

	return { compatible: true, currentVersion: baseVersion, requiredVersion };
}
