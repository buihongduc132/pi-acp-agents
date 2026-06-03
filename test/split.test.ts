import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

describe("two-package split", () => {
	// ── R-SP5: pi-acp-types package exists ───────────────────────────────

	describe("pi-acp-types package", () => {
		it("packages/pi-acp-types/package.json exists", () => {
			const pkgPath = join(ROOT, "packages", "pi-acp-types", "package.json");
			expect(existsSync(pkgPath)).toBe(true);
		});

		it("packages/pi-acp-types/src/index.ts exports core types", () => {
			const indexPath = join(ROOT, "packages", "pi-acp-types", "src", "index.ts");
			expect(existsSync(indexPath)).toBe(true);
			const content = readFileSync(indexPath, "utf-8");
			// Verify key types are exported
			expect(content).toContain("AcpConfig");
			expect(content).toContain("AcpAgentConfig");
			expect(content).toContain("AcpPromptResult");
			expect(content).toContain("AcpSessionHandle");
			expect(content).toContain("AcpRuntimePaths");
			expect(content).toContain("CircuitState");
		});

		it("base package depends on pi-acp-types", () => {
			const pkgPath = join(ROOT, "package.json");
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			expect(pkg.dependencies["pi-acp-types"]).toBe("workspace:*");
		});
	});

	// ── R-SP5: public-api.ts contract ────────────────────────────────────

	describe("public-api.ts exports", () => {
		it("exports loadConfig and validateConfig", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain("loadConfig");
			expect(content).toContain("validateConfig");
		});

		it("exports ensureRuntimeDir", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain("ensureRuntimeDir");
		});

		it("re-exports types from pi-acp-types", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain('from "pi-acp-types"');
			expect(content).toContain("AcpConfig");
			expect(content).toContain("AcpAgentConfig");
		});

		it("exports Coordinator and SessionManager", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain("AgentCoordinator");
			expect(content).toContain("SessionManager");
		});

		it("exports extension safety functions", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain("detectBaseLoaded");
			expect(content).toContain("activateExtensionSafely");
			expect(content).toContain("checkVersionCompatibility");
			expect(content).toContain("MIN_BASE_VERSION");
		});

		it("exports all stores for extension use", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain("AcpTaskStore");
			expect(content).toContain("MailboxManager");
			expect(content).toContain("GovernanceStore");
			expect(content).toContain("WorkerStore");
			expect(content).toContain("SessionNameStore");
		});

		it("exports version", () => {
			const content = readFileSync(join(ROOT, "src", "public-api.ts"), "utf-8");
			expect(content).toContain("export const version");
		});
	});

	// ── R-SP1: Extension safety ──────────────────────────────────────────

	describe("extension safety (R-SP1)", () => {
		it("extension-safety.ts exists", () => {
			const path = join(ROOT, "src", "extension-safety.ts");
			expect(existsSync(path)).toBe(true);
		});

		it("pi-acp-advanced package exists", () => {
			const pkgPath = join(ROOT, "packages", "pi-acp-advanced", "package.json");
			expect(existsSync(pkgPath)).toBe(true);
		});

		it("pi-acp-advanced imports from pi-acp-agents (not duplicating code)", () => {
			const indexPath = join(ROOT, "packages", "pi-acp-advanced", "src", "index.ts");
			expect(existsSync(indexPath)).toBe(true);
			const content = readFileSync(indexPath, "utf-8");
			expect(content).toContain('from "pi-acp-agents"');
			// Should NOT duplicate config loading logic
			expect(content).not.toContain("export function loadConfig");
			expect(content).not.toContain("export function validateConfig");
		});
	});

	// ── R-SP3: Loading order ─────────────────────────────────────────────

	describe("loading order (R-SP3)", () => {
		it("pi-acp-advanced checks base before registering tools", () => {
			const content = readFileSync(
				join(ROOT, "packages", "pi-acp-advanced", "src", "index.ts"),
				"utf-8",
			);
			// Must check base loaded early
			expect(content).toContain("checkBaseLoaded");
			// Must return early if base is missing
			expect(content).toMatch(/if\s*\(\s*!baseCheck\.ok\s*\)/);
			// Must NOT register tools before check passes
			const checkIdx = content.indexOf("checkBaseLoaded");
			const firstToolIdx = content.indexOf("registerTool");
			expect(checkIdx).toBeGreaterThanOrEqual(0);
			expect(firstToolIdx).toBeGreaterThan(checkIdx);
		});

		it("pi-acp-advanced emits warning when base is missing", () => {
			const content = readFileSync(
				join(ROOT, "packages", "pi-acp-advanced", "src", "index.ts"),
				"utf-8",
			);
			expect(content).toContain("console.error");
			expect(content).toContain("warning");
		});

		it("pi-acp-advanced returns without registering tools if base missing", () => {
			const content = readFileSync(
				join(ROOT, "packages", "pi-acp-advanced", "src", "index.ts"),
				"utf-8",
			);
			// Find the early return after base check
			const baseCheckIdx = content.indexOf("if (!baseCheck.ok)");
			const afterCheck = content.substring(baseCheckIdx, baseCheckIdx + 500);
			expect(afterCheck).toContain("return;");
			// No registerTool should appear before the base check passes
			const registerToolBeforeCheck = content.substring(0, baseCheckIdx).indexOf("registerTool");
			expect(registerToolBeforeCheck).toBe(-1);
		});
	});

	// ── No code duplication ──────────────────────────────────────────────

	describe("no code duplication", () => {
		it("pi-acp-advanced does not re-implement config loading", () => {
			const content = readFileSync(
				join(ROOT, "packages", "pi-acp-advanced", "src", "index.ts"),
				"utf-8",
			);
			// Should import from base, not reimplement
			expect(content).toContain("loadConfig");
			expect(content).not.toContain("readFileSync.*config.json");
		});

		it("pi-acp-advanced uses ensureRuntimeDir from base (not hardcoding paths for stores)", () => {
			const content = readFileSync(
				join(ROOT, "packages", "pi-acp-advanced", "src", "index.ts"),
				"utf-8",
			);
			// Should import ensureRuntimeDir from base
			expect(content).toContain("ensureRuntimeDir");
			// Should use the returned runtimePaths for store construction
			expect(content).toContain("runtimePaths.rootDir");
			// Should NOT construct its own runtime paths for stores
			// (base detection using join(homedir()) for checkBaseLoaded is OK)
			const afterToolRegistration = content.substring(content.indexOf("registerTool"));
			expect(afterToolRegistration).not.toContain("homedir()");
		});
	});
});
