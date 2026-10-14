import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_SETTINGS, loadConfig, maskKey, resolveKeyFromLocal, storeApiKey, userConfigPath, warnLowCredits, type SearloSettings } from "../src/config.ts";

/** Points PI_CODING_AGENT_DIR at a scratch dir so userConfigPath() is hermetic. */
function withAgentDir(run: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "pi-searlo-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		run(dir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeAgentConfig(dir: string, value: unknown, name = "searlo.json") {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}

const envBackup: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined) {
	envBackup[name] ??= process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("defaults to the searlo api without any config file", () => {
	withAgentDir((dir) => {
		const loaded = loadConfig({ force: true });
		assert.equal(loaded.usingDefaults, true);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.settings.baseUrl, "https://api.searlo.tech");
		assert.equal(loaded.settings.vertical, "web");
		assert.equal(loaded.settings.endpoints.web, "/api/v1/search/web");
		assert.equal(loaded.settings.endpoints.shopping, "/api/v1/search/shopping");
		assert.equal(loaded.settings.apiKeyHeader, "x-api-key");
		assert.equal(loaded.settings.mode, DEFAULT_SETTINGS.mode);
		assert.ok(dir);
	});
});

test("normalizes user config and clamps out-of-range numbers", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, {
			baseUrl: "https://search.example.test/",
			endpoint: "api/v1/search/web",
			limit: 900,
			timeoutMs: 1,
			contentBudgetChars: -5,
			mode: "tool",
			params: { language: "en", safesearch: 1, nested: { no: "keep" } },
		});
		const { settings } = loadConfig({ force: true });
		assert.equal(settings.baseUrl, "https://search.example.test");
		assert.equal(settings.endpoints.web, "/api/v1/search/web", "the legacy single endpoint gains a leading slash");
		assert.equal(settings.limit, 10, "the API rejects limit > 10, so config clamps to its maximum");
		assert.equal(settings.timeoutMs, 500);
		assert.equal(settings.contentBudgetChars, 500);
		assert.deepEqual(settings.params, { language: "en", safesearch: "1" });
	});
});

test("a malformed config degrades to defaults with a reported error", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, "{ not json");
		const loaded = loadConfig({ force: true });
		assert.equal(loaded.usingDefaults, true);
		assert.equal(loaded.settings.baseUrl, DEFAULT_SETTINGS.baseUrl);
		assert.equal(loaded.errors.length, 1);
		assert.match(loaded.errors[0], /searlo\.json/);
	});
});

test("every mode is accepted and junk falls back to the default", () => {
	withAgentDir((dir) => {
		for (const mode of ["off", "manual", "tool", "auto"]) {
			writeAgentConfig(dir, { mode });
			assert.equal(loadConfig({ force: true }).settings.mode, mode);
		}
		writeAgentConfig(dir, { mode: "nope" });
		assert.equal(loadConfig({ force: true }).settings.mode, DEFAULT_SETTINGS.mode, "an unknown mode must not disable searching");
	});
});

test("junk types in config do not crash loading", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, { limit: "ten", mode: "yolo", params: "nope", auto: { triggerPatterns: "latest" } });
		const { settings } = loadConfig({ force: true });
		assert.equal(settings.limit, DEFAULT_SETTINGS.limit);
		assert.equal(settings.mode, DEFAULT_SETTINGS.mode);
		assert.deepEqual(settings.params, {});
		assert.deepEqual(settings.auto.triggerPatterns, DEFAULT_SETTINGS.auto.triggerPatterns);
	});
});

test("invalid auto regexes are skipped and reported", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, { auto: { triggerPatterns: ["latest", "(unbalanced"], skipPatterns: [42] } });
		const { settings, errors } = loadConfig({ force: true });
		assert.deepEqual(settings.auto.triggerPatterns, ["latest"]);
		// An explicit array is respected even when every entry is junk: it means "no patterns".
		assert.deepEqual(settings.auto.skipPatterns, []);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /invalid regex skipped: \(unbalanced/);
	});
});

test("project config tunes search behaviour but cannot supply credentials", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, { apiKey: "sk_user_secret", limit: 3 });
		const cwd = mkdtempSync(join(tmpdir(), "pi-searlo-project-"));
		try {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "searlo.json"),
				JSON.stringify({ apiKey: "sk_project_secret", apiKeyHeader: "x-evil", baseUrl: "https://evil.test", limit: 9 }),
			);
			setEnv("SEARLO_API_KEY", "sk_from_env");
			const loaded = loadConfig({ cwd, force: true });
			assert.equal(loaded.settings.baseUrl, "https://evil.test", "project may retarget the endpoint");
			assert.equal(loaded.settings.limit, 9);
			assert.equal(loaded.settings.apiKeyHeader, "x-api-key", "project may not change the auth header");
			assert.equal(loaded.settings.apiKey, "sk_user_secret", "project may not inject a key");
			assert.equal(resolveKeyFromLocal(loaded.settings).key, "sk_from_env", "env wins regardless");
			setEnv("SEARLO_API_KEY", undefined);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("key resolution prefers env, then literal, then env: indirection", () => {
	const settings: SearloSettings = { ...DEFAULT_SETTINGS };

	setEnv("SEARLO_API_KEY", "sk_env");
	assert.deepEqual(resolveKeyFromLocal(settings), { key: "sk_env", source: "env", detail: "SEARLO_API_KEY" });

	setEnv("SEARLO_API_KEY", undefined);
	assert.deepEqual(resolveKeyFromLocal({ ...settings, apiKey: "sk_literal" }), {
		key: "sk_literal",
		source: "config",
		detail: "searlo.json",
	});

	setEnv("MY_SEARLO", "sk_indirect");
	assert.deepEqual(resolveKeyFromLocal({ ...settings, apiKey: "env:MY_SEARLO" }), {
		key: "sk_indirect",
		source: "env",
		detail: "MY_SEARLO",
	});

	const missing = resolveKeyFromLocal({ ...settings, apiKey: "env:NOT_SET_ANYWHERE" });
	assert.equal(missing.key, undefined);
	assert.equal(missing.source, "none");
	assert.match(missing.detail ?? "", /unset/);
	setEnv("MY_SEARLO", undefined);
});

test("maskKey never reproduces the whole key", () => {
	const masked = maskKey("sk_0123456789abcdef");
	assert.ok(!masked.includes("23456789abcde"), masked);
	assert.match(masked, /^sk_0/);
	assert.match(masked, /ef \(19 chars\)$/);
	assert.equal(maskKey("short"), "*****");
});

test("maskKey hides a short key completely instead of showing most of it", () => {
	const short: [number, string][] = [
		[8, "abcdefgh"],
		[9, "abcdefghi"],
		[12, "abcdefghijkl"],
		[16, "abcdefghijklmnop"],
	];
	for (const [length, key] of short) {
		// A 9-character key used to come back as "abcde…fghi": every character, in order.
		assert.equal(maskKey(key), "*".repeat(length), `${length} chars must be all stars`);
		assert.ok(!maskKey(key).includes(key.slice(0, 4)), "no fragment of the key may survive");
		assert.ok(!maskKey(key).includes(key.slice(-4)), "no fragment of the key may survive");
	}

	// Past the threshold a prefix and a suffix are a minority of the secret, and enough to recognise it.
	const long = `sk_live_${"a".repeat(32)}`;
	assert.equal(long.length, 40);
	assert.equal(maskKey(long), `${long.slice(0, 5)}…${long.slice(-4)} (40 chars)`);
	assert.ok(!maskKey(long).includes(long.slice(5, -4)), "the middle never appears");
});

test("storeApiKey keeps other settings and locks the file to 0600", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, { limit: 7, mode: "auto", baseUrl: "https://search.example.test" });
		const path = userConfigPath();
		const stored = storeApiKey("sk_written_value", path);

		assert.equal(stored.created, false);
		const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.equal(written["apiKey"], "sk_written_value");
		assert.equal(written["limit"], 7, "existing settings survive the write");
		assert.equal(written["mode"], "auto");
		assert.equal(statSync(path).mode & 0o777, 0o600);

		const state = resolveKeyFromLocal(loadConfig({ force: true }).settings);
		assert.equal(state.key, "sk_written_value");
		assert.equal(state.source, "config");
	});
});

test("storeApiKey creates the file when nothing exists yet", () => {
	withAgentDir(() => {
		const path = userConfigPath();
		const stored = storeApiKey("env:MY_SEARLO_KEY", path);
		assert.equal(stored.created, true);
		assert.match(readFileSync(path, "utf8"), /"apiKey": "env:MY_SEARLO_KEY"/);
	});
});

test("storeApiKey refuses to clobber a config it cannot parse", () => {
	withAgentDir((dir) => {
		writeAgentConfig(dir, "{ broken");
		assert.throws(() => storeApiKey("sk_x", userConfigPath()), /unreadable config/);
	});
});

test("storeApiKey rejects an empty key", () => {
	withAgentDir(() => {
		assert.throws(() => storeApiKey("   ", userConfigPath()), /empty key/);
	});
});

test("warnLowCredits flags low balances and stays quiet otherwise", () => {
	assert.equal(warnLowCredits({ available: 5000, isLowBalance: false, elapsedMs: 10 }), undefined, "a healthy balance is no news");
	assert.equal(warnLowCredits({ available: 100, isLowBalance: false, elapsedMs: 10 }), undefined, "the threshold itself is not low");

	const below = warnLowCredits({ available: 80, isLowBalance: false, elapsedMs: 10 });
	assert.match(below ?? "", /80 credit\(s\)/);
	assert.match(below ?? "", /top up/i);
	assert.match(below ?? "", /\/searlo credits/);

	const flagged = warnLowCredits({ available: 3, isLowBalance: true, elapsedMs: 10 });
	assert.match(flagged ?? "", /3 credit\(s\)/);

	// The account flags a low balance without a number: still worth one warning.
	assert.match(warnLowCredits({ isLowBalance: true, elapsedMs: 10 }) ?? "", /low balance/);

	assert.equal(warnLowCredits({ elapsedMs: 10 }), undefined, "nothing reported means nothing to warn about");
});
