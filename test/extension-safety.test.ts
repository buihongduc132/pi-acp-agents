import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	detectBaseLoaded,
	activateExtensionSafely,
	checkVersionCompatibility,
	MIN_BASE_VERSION,
} from "../src/extension-safety.js";

describe("extension-safety", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "acp-safety-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── detectBaseLoaded ─────────────────────────────────────────────────

	describe("detectBaseLoaded", () => {
		it("returns ok=false when runtime dir is missing", () => {
			const result = detectBaseLoaded(join(tmpDir, "nonexistent"));
			expect(result.ok).toBe(false);
			expect(result.warning).toContain("pi-acp-agents");
			expect(result.warning).toContain("Runtime dir missing");
		});

		it("returns ok=false when config.json is missing", () => {
			mkdirSync(tmpDir, { recursive: true });
			const result = detectBaseLoaded(tmpDir);
			expect(result.ok).toBe(false);
			expect(result.warning).toContain("config");
		});

		it("returns ok=false when config.json is corrupt", () => {
			mkdirSync(tmpDir, { recursive: true });
			writeFileSync(join(tmpDir, "config.json"), "not json{{{");
			const result = detectBaseLoaded(tmpDir);
			expect(result.ok).toBe(false);
			expect(result.warning).toContain("corrupt");
		});

		it("returns ok=false when config has no agent_servers", () => {
			mkdirSync(tmpDir, { recursive: true });
			writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ agent_servers: {} }));
			const result = detectBaseLoaded(tmpDir);
			expect(result.ok).toBe(false);
			expect(result.warning).toContain("no agents");
		});

		it("returns ok=true when runtime dir + config + agents exist", () => {
			mkdirSync(tmpDir, { recursive: true });
			writeFileSync(
				join(tmpDir, "config.json"),
				JSON.stringify({ agent_servers: { gemini: { command: "gemini" } } }),
			);
			const result = detectBaseLoaded(tmpDir);
			expect(result.ok).toBe(true);
			expect(result.runtimeDir).toBe(tmpDir);
			expect(result.configFile).toBe(join(tmpDir, "config.json"));
		});

		it("returns baseVersion when package.json is reachable", () => {
			// Simulate a deploy-like layout: tmpDir = runtime, pkg at tmpDir/../../package.json
			const pkgDir = join(tmpDir, "agent", "git", "github.com", "buihongduc132", "pi-acp-agents");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ version: "0.4.1" }),
			);
			const runtimeDir = join(tmpDir, ".pi", "acp-agents");
			mkdirSync(runtimeDir, { recursive: true });
			writeFileSync(
				join(runtimeDir, "config.json"),
				JSON.stringify({ agent_servers: { gemini: { command: "gemini" } } }),
			);
			const result = detectBaseLoaded(runtimeDir);
			expect(result.ok).toBe(true);
			expect(result.baseVersion).toBe("0.4.1");
		});
	});

	// ── activateExtensionSafely ──────────────────────────────────────────

	describe("activateExtensionSafely", () => {
		it("returns activated=false when base is missing", () => {
			const result = activateExtensionSafely(join(tmpDir, "nonexistent"));
			expect(result.activated).toBe(false);
			expect(result.warning).toContain("pi-acp-agents");
		});

		it("returns activated=true when base is loaded", () => {
			mkdirSync(tmpDir, { recursive: true });
			writeFileSync(
				join(tmpDir, "config.json"),
				JSON.stringify({ agent_servers: { gemini: { command: "gemini" } } }),
			);
			const result = activateExtensionSafely(tmpDir);
			expect(result.activated).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		it("never throws even with totally invalid path", () => {
			expect(() => activateExtensionSafely("\0null\0byte")).not.toThrow();
		});
	});

	// ── checkVersionCompatibility ────────────────────────────────────────

	describe("checkVersionCompatibility", () => {
		it("returns compatible=false when version is undefined", () => {
			const result = checkVersionCompatibility(undefined);
			expect(result.compatible).toBe(false);
			expect(result.requiredVersion).toBe(MIN_BASE_VERSION);
		});

		it("returns compatible=false when version is below minimum", () => {
			const result = checkVersionCompatibility("0.2.2");
			expect(result.compatible).toBe(false);
			expect(result.currentVersion).toBe("0.2.2");
			expect(result.warning).toContain("0.3.0");
		});

		it("returns compatible=true when version meets minimum", () => {
			const result = checkVersionCompatibility("0.3.0");
			expect(result.compatible).toBe(true);
			expect(result.currentVersion).toBe("0.3.0");
		});

		it("returns compatible=true when version exceeds minimum", () => {
			const result = checkVersionCompatibility("1.0.0");
			expect(result.compatible).toBe(true);
		});

		it("returns compatible=true for higher minor version", () => {
			const result = checkVersionCompatibility("0.5.0");
			expect(result.compatible).toBe(true);
		});

		it("returns compatible=false for older major version", () => {
			// Should not happen in practice, but test the comparison
			const result = checkVersionCompatibility("0.3.0", "1.0.0");
			expect(result.compatible).toBe(false);
		});

		it("handles invalid version format gracefully", () => {
			const result = checkVersionCompatibility("not-a-version");
			expect(result.compatible).toBe(false);
			expect(result.warning).toContain("Invalid");
		});

		it("uses custom requiredVersion when provided", () => {
			const result = checkVersionCompatibility("0.4.0", "0.5.0");
			expect(result.compatible).toBe(false);
			expect(result.requiredVersion).toBe("0.5.0");
		});
	});
});
