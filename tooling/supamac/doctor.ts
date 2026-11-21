import { spawnSync } from "node:child_process";
import { cpus, platform, totalmem } from "node:os";

type Check = {
	check: string;
	result: "pass" | "missing" | "note";
	detail: string;
};
const checks: Check[] = [];

function command(check: string, executable: string, args: string[]): void {
	const result = spawnSync(executable, args, {
		timeout: 10_000,
		stdio: "ignore",
	});
	checks.push({
		check,
		result: result.status === 0 ? "pass" : "missing",
		detail: executable,
	});
}

checks.push({
	check: "Linux host",
	result: platform() === "linux" ? "pass" : "missing",
	detail: platform(),
});
command("Nix with flakes", "nix", [
	"--extra-experimental-features",
	"nix-command flakes",
	"eval",
	"--expr",
	"builtins.nixVersion",
]);
command("Docker daemon", "docker", ["info"]);
command("Bun", "bun", ["--version"]);
command("Git", "git", ["--version"]);
checks.push({
	check: "Build resources",
	result: "note",
	detail: `${cpus().length} CPUs, ${Math.round(totalmem() / 1024 ** 3)} GiB RAM; full Rust/Nix builds need substantial RAM and disk`,
});
checks.push({
	check: "OpenAI credential",
	result: process.env.OPENAI_API_KEY?.trim() ? "pass" : "missing",
	detail: "Presence only; no credential value is printed or sent",
});
console.table(checks);
process.exitCode = checks.some((check) => check.result === "missing") ? 1 : 0;
