import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

type Audit = { directory: string; high: number; critical: number };
type AuditSummary = { high: number; critical: number; total: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject unreadable results rather than reporting a failed scanner as clean. */
export function summarizeBunAudit(output: string): AuditSummary {
	const value: unknown = JSON.parse(output);
	if (!isRecord(value) || "error" in value)
		throw new Error("Invalid Bun audit result");
	const summary = { high: 0, critical: 0, total: 0 };
	for (const advisories of Object.values(value)) {
		if (!Array.isArray(advisories) || advisories.length === 0)
			throw new Error("Invalid advisory list");
		for (const advisory of advisories) {
			if (
				!isRecord(advisory) ||
				typeof advisory.severity !== "string" ||
				!["info", "low", "moderate", "high", "critical"].includes(
					advisory.severity,
				)
			) {
				throw new Error("Invalid advisory");
			}
			summary.total++;
			if (advisory.severity === "high") summary.high++;
			if (advisory.severity === "critical") summary.critical++;
		}
	}
	return summary;
}

/** Enforce the scanner's status and result contract before using any counts. */
export function parseAuditResult(
	manager: "bun" | "npm",
	output: string,
	status: number | null,
): AuditSummary {
	if (status !== 0 && status !== 1) throw new Error("Scanner did not complete");
	let summary: AuditSummary;
	if (manager === "bun") {
		summary = summarizeBunAudit(output);
	} else {
		const value: unknown = JSON.parse(output);
		if (
			!isRecord(value) ||
			"error" in value ||
			!isRecord(value.metadata) ||
			!isRecord(value.metadata.vulnerabilities)
		)
			throw new Error("Invalid npm audit result");
		const counts = value.metadata.vulnerabilities;
		let severityTotal = 0;
		for (const key of [
			"info",
			"low",
			"moderate",
			"high",
			"critical",
			"total",
		]) {
			const count = counts[key];
			if (
				typeof count !== "number" ||
				!Number.isSafeInteger(count) ||
				count < 0
			)
				throw new Error("Invalid advisory count");
			if (key !== "total") severityTotal += count;
		}
		const { high, critical, total } = counts;
		if (
			typeof high !== "number" ||
			typeof critical !== "number" ||
			typeof total !== "number" ||
			total !== severityTotal
		)
			throw new Error("Inconsistent advisory counts");
		summary = { high, critical, total };
	}
	if (status === 1 && summary.total === 0)
		throw new Error("Scanner failed without advisory results");
	return summary;
}

export function auditDirectories(paths: string[]): Map<string, "bun" | "npm"> {
	const roots = new Map<string, "bun" | "npm">();
	for (const path of paths) {
		if (basename(path) === "bun.lock") roots.set(dirname(path), "bun");
		if (
			basename(path) === "package-lock.json" &&
			roots.get(dirname(path)) !== "bun"
		) {
			roots.set(dirname(path), "npm");
		}
	}
	return roots;
}

/** Keep a nested standalone lock from resolving to an ancestor Bun workspace. */
export function createAuditWorkspace(
	root: string,
	directory: string,
	manager: "bun" | "npm",
): string {
	const temporary = mkdtempSync(join(tmpdir(), "supamac-audit-"));
	try {
		const location = relative(root, temporary);
		if (
			!isAbsolute(location) &&
			location !== ".." &&
			!location.startsWith(`..${sep}`)
		)
			throw new Error(
				"Audit temporary directory must be outside the repository",
			);
		const source = resolve(root, directory);
		copyFileSync(join(source, "package.json"), join(temporary, "package.json"));
		const lock = manager === "bun" ? "bun.lock" : "package-lock.json";
		copyFileSync(join(source, lock), join(temporary, lock));
		return temporary;
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

function runAudits(): void {
	const root = resolve(import.meta.dir, "../..");
	const tracked = spawnSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (tracked.status !== 0)
		throw new Error("Cannot enumerate tracked lockfiles");
	const reports: Audit[] = [];
	let failed = false;

	for (const [directory, manager] of auditDirectories(
		tracked.stdout.split("\0"),
	)) {
		let temporary: string | undefined;
		try {
			temporary = createAuditWorkspace(root, directory, manager);
			const command = manager === "bun" ? process.execPath : "npm";
			const args =
				manager === "bun"
					? ["--no-env-file", "audit", "--json"]
					: ["audit", "--json", "--ignore-scripts"];
			const result = spawnSync(command, args, {
				cwd: temporary,
				encoding: "utf8",
				timeout: 120_000,
				maxBuffer: 16 * 1024 * 1024,
			});
			if (result.error) {
				throw new Error("Scanner did not complete");
			}
			const summary = parseAuditResult(manager, result.stdout, result.status);
			reports.push({
				directory,
				high: summary.high,
				critical: summary.critical,
			});
			failed ||= summary.high > 0 || summary.critical > 0;
		} catch {
			console.error(`${directory}: audit unavailable or malformed result`);
			failed = true;
		} finally {
			if (temporary) rmSync(temporary, { recursive: true, force: true });
		}
	}

	if (reports.length === 0) throw new Error("No lockfiles were audited");
	console.table(reports);
	process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) runAudits();
