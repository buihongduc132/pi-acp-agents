#!/usr/bin/env node
/**
 * version-sync.mjs — Sync version from package.json to other manifest files.
 * Runs automatically on `npm version` via the "version" script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const newVersion = pkg.version;

console.log(`Syncing version ${newVersion}...`);

// Add more manifest syncs here as needed
const files = [];

for (const file of files) {
	console.log(`  → ${file}`);
}

console.log("Version sync complete.");
