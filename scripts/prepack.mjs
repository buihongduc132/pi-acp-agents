#!/usr/bin/env node
/**
 * prepack.mjs — Runs before npm pack / npm publish.
 * Validates package structure, pi fields, and file existence.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const errors = [];

// 0. workspace:* protocol check — npm publish doesn't resolve workspace:* (only pnpm does).
// If workspace:* is still in deps AND we're NOT running under pnpm, the published package
// will be broken for npm consumers. Skip if running under pnpm (it resolves workspace:* after prepack).
const isDryRun = process.env.npm_config_dry_run === "true";
const isPnpm = (process.env.npm_config_user_agent || "").includes("pnpm");
if (!isDryRun && !isPnpm) {
	for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
		const deps = pkg[field];
		if (!deps) continue;
		for (const [name, version] of Object.entries(deps)) {
			if (typeof version === "string" && version.startsWith("workspace:")) {
				errors.push(
					`${field}.${name} = "${version}" — workspace:* protocol not resolved.\n` +
					`  Use 'pnpm publish' (not 'npm publish') to resolve workspace:* to actual versions.`,
				);
			}
		}
	}
}

// 1. pi field exists
if (!pkg.pi) errors.push("Missing 'pi' field in package.json");
if (!pkg.pi?.extensions?.length) errors.push("Missing pi.extensions");
if (!pkg.pi?.skills?.length) errors.push("Missing pi.skills");

// 2. Extension entry exists
for (const ext of pkg.pi?.extensions ?? []) {
	if (!existsSync(resolve(root, ext))) {
		errors.push(`Extension entry not found: ${ext}`);
	}
}

// 3. Skills directory exists
for (const skillDir of pkg.pi?.skills ?? []) {
	const dir = resolve(root, skillDir);
	if (!existsSync(dir)) {
		errors.push(`Skills directory not found: ${skillDir}`);
	}
}

// 4. Required docs
for (const f of ["README.md", "CHANGELOG.md", "LICENSE"]) {
	if (!existsSync(resolve(root, f))) {
		errors.push(`Missing required file: ${f}`);
	}
}

// 5. Keywords
if (!pkg.keywords?.includes("pi-package")) {
	errors.push("Missing 'pi-package' keyword");
}

// 6. Version format
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) {
	errors.push(`Invalid semver: ${pkg.version}`);
}

if (errors.length > 0) {
	console.error("❌ Prepack validation failed:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(`✅ Prepack validation passed (v${pkg.version})`);
