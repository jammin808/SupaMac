import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditDirectories,
	createAuditWorkspace,
	parseAuditResult,
	summarizeBunAudit,
} from "./audit-dependencies";

describe("dependency auditing", () => {
	test("nested audit inputs are isolated without copying credentials or a parent lock", () => {
		const root = mkdtempSync(join(tmpdir(), "supamac-audit-test-"));
		let isolated: string | undefined;
		try {
			mkdirSync(join(root, "nested"));
			writeFileSync(join(root, "bun.lock"), "parent workspace lock");
			writeFileSync(
				join(root, "nested", "bun.lock"),
				"independent nested lock",
			);
			writeFileSync(join(root, "nested", "package.json"), '{"private":true}');
			writeFileSync(join(root, "nested", ".env.local"), "test sentinel");
			isolated = createAuditWorkspace(root, "nested", "bun");
			expect(isolated.startsWith(`${root}/`)).toBe(false);
			expect(readdirSync(isolated).sort()).toEqual([
				"bun.lock",
				"package.json",
			]);
			expect(readFileSync(join(isolated, "bun.lock"), "utf8")).toBe(
				"independent nested lock",
			);
		} finally {
			if (isolated) rmSync(isolated, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("scanner errors and malformed responses cannot become a clean report", () => {
		for (const output of [
			"",
			"Service unavailable",
			"null",
			"[]",
			'{"error":"denied"}',
			'{"error":[]}',
			'{"example":[{"severity":"HIGH"}]}',
			'{"example":[{"severity":""}]}',
			'{"x":[{}]}',
		]) {
			expect(() => summarizeBunAudit(output)).toThrow();
		}
	});

	test("counts blocking severities without treating moderate findings as high", () => {
		expect(
			summarizeBunAudit(
				JSON.stringify({
					example: [
						{ severity: "high" },
						{ severity: "critical" },
						{ severity: "moderate" },
					],
				}),
			),
		).toEqual({ high: 1, critical: 1, total: 3 });
		expect(summarizeBunAudit("{}")).toEqual({ high: 0, critical: 0, total: 0 });
	});

	test("scanner exit errors cannot pass as an empty clean result", () => {
		expect(() => parseAuditResult("bun", "{}", 1)).toThrow();
		expect(() => parseAuditResult("bun", "{}", 2)).toThrow();
		expect(() => parseAuditResult("bun", "{}", null)).toThrow();
		expect(
			parseAuditResult("bun", '{"example":[{"severity":"low"}]}', 1),
		).toEqual({ high: 0, critical: 0, total: 1 });
	});

	test("npm counts must be nonnegative safe integers with a consistent total", () => {
		const counts = {
			info: 0,
			low: 0,
			moderate: 0,
			high: 0,
			critical: 0,
			total: 0,
		};
		expect(() =>
			parseAuditResult(
				"npm",
				JSON.stringify({
					metadata: { vulnerabilities: { ...counts, total: 1 } },
				}),
				1,
			),
		).toThrow();
		for (const invalid of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
			const output = JSON.stringify({
				metadata: { vulnerabilities: { ...counts, high: invalid } },
			});
			expect(() => parseAuditResult("npm", output, 0)).toThrow();
		}
		expect(() =>
			parseAuditResult(
				"npm",
				JSON.stringify({
					metadata: { vulnerabilities: { ...counts, high: 1 } },
				}),
				0,
			),
		).toThrow();
		expect(() =>
			parseAuditResult(
				"npm",
				JSON.stringify({ metadata: { vulnerabilities: counts } }),
				1,
			),
		).toThrow();
		expect(
			parseAuditResult(
				"npm",
				JSON.stringify({ metadata: { vulnerabilities: counts } }),
				0,
			),
		).toEqual({ high: 0, critical: 0, total: 0 });
	});

	test("audits independent workspaces and prefers Bun when both locks exist", () => {
		for (const paths of [
			[
				"bun.lock",
				"services/sync-service/package-lock.json",
				"services/sync-service/bun.lock",
				"infra/bun.lock",
			],
			[
				"services/sync-service/bun.lock",
				"services/sync-service/package-lock.json",
				"bun.lock",
				"infra/bun.lock",
			],
		]) {
			expect(auditDirectories(paths).get("services/sync-service")).toBe("bun");
			expect(auditDirectories(paths).get("infra")).toBe("bun");
			expect(auditDirectories(paths).get(".")).toBe("bun");
			expect(auditDirectories(paths).size).toBe(3);
		}
	});
});
