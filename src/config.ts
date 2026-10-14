/**
 * Searlo extension settings: `~/.pi/agent/searlo.json`.
 *
 * Secret resolution order (first hit wins, never silently missing):
 *   1. process.env[apiKeyEnv]                 (default SEARLO_API_KEY)
 *   2. settings.apiKey                        (literal value, or "env:VAR" indirection)
 *   3. pi's auth.json via readStoredCredential (populated by /searlo login)
 *
 * Layer 3 needs a pi import, so it is injected by index.ts as `authLookup`.
 */

import { existsSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CONFIG_BASENAME = "searlo.json";
export const DEFAULT_API_KEY_ENV = "SEARLO_API_KEY";

export type SearloMode = "manual" | "tool" | "auto";

export interface SearloSettings {
	/** Searlo API root, no trailing slash, e.g. https://api.searlo.tech */
	baseUrl: string;
	/** Search path appended to baseUrl. */
	endpoint: string;
	/** Environment variable holding the API key. */
	apiKeyEnv: string;
	/** Key literal, or "env:VARNAME" to read process.env.VARNAME. */
	apiKey?: string;
	/** Header carrying the key. */
	apiKeyHeader: string;
	/** Result count requested from the API (1-50). */
	limit: number;
	/** 1-based page for the documented `page` parameter; 1 is never sent. */
	page?: number;
	/** Extra query parameters passed through verbatim. */
	params: Record<string, string>;
	/** Request timeout in milliseconds. */
	timeoutMs: number;
	/** Tool activation policy for this session. */
	mode: SearloMode;
	/** Max characters of snippet text handed to the model per search. */
	contentBudgetChars: number;
	/** Emit the citation/rules preamble in search context blocks. */
	includeCitations: boolean;
	/** Regex/validation problems found while loading. Never contains secrets. */
	errors?: string[];
	/** Only used when mode is "auto". */
	auto: {
		/** Inject only when the prompt matches one of these regexes. */
		triggerPatterns: string[];
		/** Never inject when the prompt matches one of these regexes. */
		skipPatterns: string[];
		/** Skip trivially short prompts (characters). */
		minPromptChars: number;
	};
}

export const DEFAULT_SETTINGS: SearloSettings = {
	baseUrl: "https://api.searlo.tech",
	endpoint: "/api/v1/search/web",
	apiKeyEnv: DEFAULT_API_KEY_ENV,
	apiKeyHeader: "x-api-key",
	limit: 5,
	page: 1,
	params: {},
	timeoutMs: 8000,
	mode: "tool",
	contentBudgetChars: 6000,
	includeCitations: true,
	auto: {
		triggerPatterns: [
			"\\b(latest|recent|currently|today|yesterday|this (week|month|year))\\b",
			"\\b(new|release|changelog|news|version|breaking|announced?)\\b",
			"\\b(as of|in)\\s+(20\\d\\d)\\b",
			"\\b(search|look up|google|find online)\\b",
		],
		skipPatterns: ["^\\s*/", "\\b(hi|hello|hey|thanks|thank you)\\b"],
		minPromptChars: 24,
	},
};

/** Same shape as pi's getAgentDir(), without importing pi (keeps this testable). */
export function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	return fromEnv ? resolve(fromEnv.replace(/^~/, homedir())) : join(homedir(), ".pi", "agent");
}

export function userConfigPath(): string {
	return join(agentDir(), CONFIG_BASENAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_BASENAME);
}

export interface LoadedConfig {
	settings: SearloSettings;
	/** Paths that contributed to the merged settings. */
	sources: string[];
	/** Load/validation problems, human readable. */
	errors: string[];
	/** True when no config file was found anywhere. */
	usingDefaults: boolean;
}

let cache: { key: string; config: LoadedConfig } | undefined;

function fileStamp(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return undefined;
	}
}

function readJson(path: string, errors: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	const stamp = fileStamp(path);
	if (!stamp) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push(`${path}: expected a JSON object, ignored`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		errors.push(`${path}: ${(error as Error).message}`);
		return undefined;
	}
}

function isCliArg(value: unknown): value is Partial<SearloSettings> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coercion is deliberate: a malformed searlo.json must degrade to defaults, never crash the session. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? Math.trunc(value) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed === 0) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function stringList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function toStringParams(value: unknown): Record<string, string> {
	const params: Record<string, string> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return params;
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") params[key] = String(raw);
	}
	return params;
}

function normalize(settings: SearloSettings): SearloSettings {
	const baseUrl = String(settings.baseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.baseUrl;
	const endpointRaw = String(settings.endpoint ?? "").trim() || DEFAULT_SETTINGS.endpoint;
	const errors = settings.errors ?? [];
	const check = validPattern(errors);
	const mode = settings.mode;
	return {
		...settings,
		errors,
		baseUrl,
		endpoint: endpointRaw.startsWith("/") ? endpointRaw : `/${endpointRaw}`,
		apiKeyEnv: String(settings.apiKeyEnv ?? "").trim() || DEFAULT_SETTINGS.apiKeyEnv,
		apiKeyHeader: String(settings.apiKeyHeader ?? "").trim() || DEFAULT_SETTINGS.apiKeyHeader,
		limit: clampInt(settings.limit, DEFAULT_SETTINGS.limit, 1, 50),
		timeoutMs: clampInt(settings.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 500, 120000),
		contentBudgetChars: clampInt(settings.contentBudgetChars, DEFAULT_SETTINGS.contentBudgetChars, 500, 200000),
		params: toStringParams(settings.params),
		page: clampInt(settings.page, 1, 1, 100),
		mode: mode === "manual" || mode === "tool" || mode === "auto" ? mode : DEFAULT_SETTINGS.mode,
		includeCitations: settings.includeCitations !== false,
		auto: {
			triggerPatterns: stringList(settings.auto?.triggerPatterns, DEFAULT_SETTINGS.auto.triggerPatterns).filter(check),
			skipPatterns: stringList(settings.auto?.skipPatterns, DEFAULT_SETTINGS.auto.skipPatterns).filter(check),
			minPromptChars: clampInt(settings.auto?.minPromptChars, DEFAULT_SETTINGS.auto.minPromptChars, 1, 4000),
		},
	};
}

function validPattern(errors: string[]): (pattern: string) => boolean {
	return (pattern: string) => {
		try {
			new RegExp(pattern, "i");
			return true;
		} catch {
			errors.push(`invalid regex skipped: ${pattern}`);
			return false;
		}
	};
}

function merge(base: SearloSettings, layer: Record<string, unknown> | undefined): SearloSettings {
	if (!layer) return base;
	const { auto: autoLayer, params: paramsLayer, ...scalarLayer } = layer;
	const merged: SearloSettings = {
		...base,
		...(scalarLayer as Partial<SearloSettings>),
		params: isCliArg(paramsLayer) ? { ...base.params, ...(paramsLayer as Record<string, string>) } : base.params,
		auto: isCliArg(autoLayer)
			? { ...base.auto, ...(autoLayer as Partial<SearloSettings["auto"]>) }
			: base.auto,
	};
	if (typeof merged.baseUrl === "string") merged.baseUrl = merged.baseUrl.trim().replace(/\/+$/, "");
	return merged;
}

export interface LoadOptions {
	/** Project directory enabling `.pi/searlo.json`. Omit to load user config only. */
	cwd?: string;
	/** `pi.getSettings().searlo`, trusted local overrides. */
	overrides?: unknown;
	/** Force a re-read of the files, bypassing the mtime cache. */
	force?: boolean;
}

/** Settings layer that must never come from a project directory. */
const SECRET_KEYS = new Set(["apiKey", "apiKeyEnv", "apiKeyHeader"]);

function stripSecrets(layer: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!layer) return undefined;
	const copy: Record<string, unknown> = { ...layer };
	for (const key of SECRET_KEYS) delete copy[key];
	return copy;
}

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
	const paths = [userConfigPath()];
	if (options.cwd) paths.push(projectConfigPath(resolve(options.cwd)));
	const stamp = paths.map((p) => fileStamp(p) ?? "-").join("|");

	if (!options.force && cache && cache.key === stamp) {
		return applyOverrides(cache.config, options.overrides);
	}

	const errors: string[] = [];
	const sources: string[] = [];
	let settings = normalize({ ...DEFAULT_SETTINGS, params: { ...DEFAULT_SETTINGS.params }, auto: { ...DEFAULT_SETTINGS.auto }, errors });

	for (const [index, path] of paths.entries()) {
		const raw = readJson(path, errors);
		if (!raw) continue;
		sources.push(path);
		// Project layer (index > 0) may not supply credentials.
		settings = normalize(merge({ ...settings, errors }, index === 0 ? raw : stripSecrets(raw)));
	}

	const config: LoadedConfig = { settings, sources, errors, usingDefaults: sources.length === 0 };
	cache = { key: stamp ?? "-", config };
	return applyOverrides(config, options.overrides);
}

function applyOverrides(config: LoadedConfig, overrides: unknown): LoadedConfig {
	if (!isCliArg(overrides)) return config;
	const settings = normalize(merge({ ...config.settings, errors: config.errors }, overrides as Record<string, unknown>));
	return { settings, sources: [...config.sources], errors: config.errors, usingDefaults: config.usingDefaults };
}

export type KeySource = "env" | "config" | "auth" | "none";

export interface ResolvedKey {
	key?: string;
	source: KeySource;
	/** env var name or file path the key came from, for `/searlo` status output. */
	detail?: string;
}

/** Missing here only means "not in env or config"; index.ts adds the auth.json step. */
export function resolveKeyFromLocal(settings: SearloSettings): ResolvedKey {
	const fromEnv = process.env[settings.apiKeyEnv];
	if (fromEnv?.trim()) return { key: fromEnv.trim(), source: "env", detail: settings.apiKeyEnv };

	const configured = settings.apiKey?.trim();
	if (configured) {
		const match = /^env:(.+)$/.exec(configured);
		if (match) {
			const value = process.env[match[1]]?.trim();
			if (value) return { key: value, source: "env", detail: match[1] };
			return { source: "none", detail: `apiKey is "env:${match[1]}" but that variable is unset` };
		}
		return { key: configured, source: "config", detail: "searlo.json" };
	}
	return { source: "none" };
}

export function maskKey(key: string): string {
	if (key.length <= 8) return "*".repeat(key.length);
	return `${key.slice(0, 5)}…${key.slice(-4)} (${key.length} chars)`;
}

export function defaultConfigTemplate(): string {
	const template: Record<string, unknown> = {
		baseUrl: DEFAULT_SETTINGS.baseUrl,
		apiKey: `env:${DEFAULT_API_KEY_ENV}`,
		apiKeyHeader: DEFAULT_SETTINGS.apiKeyHeader,
		endpoint: DEFAULT_SETTINGS.endpoint,
		limit: 5,
		timeoutMs: 8000,
		mode: "tool",
		contentBudgetChars: 6000,
		params: { language: "en", safesearch: "1" },
	};
	return `${JSON.stringify(template, null, "\t")}\n`;
}

export function writeConfigTemplate(path = userConfigPath(), force = false): string {
	if (!force && existsSync(path)) {
		throw new Error(`config already exists: ${path} (pass force to overwrite)`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, defaultConfigTemplate(), { encoding: "utf8", mode: 0o600 });
	return path;
}

/**
 * Stores the key (or an `env:VAR` indirection) in the user config file, preserving every
 * other setting, with 0600 so it is not world-readable. Never call this with a key that
 * came from command arguments, which pi records in the session transcript.
 */
export function setConfigValue(key: string, value: unknown, path = userConfigPath()): { path: string; created: boolean } {
	const errors: string[] = [];
	const existing = readJson(path, errors);
	if (errors.length) throw new Error(`refusing to overwrite an unreadable config: ${errors.join("; ")}`);
	const created = existing === undefined;

	const next: Record<string, unknown> = { ...(existing ?? {}) };
	next[key] = value;

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Some filesystems ignore the mode; the write itself already succeeded.
	}
	return { path, created };
}

/** Stores the key, or an `env:VAR` indirection. Never pass a key that came from command arguments. */
export function storeApiKey(key: string, path = userConfigPath()): { path: string; created: boolean } {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("empty key");
	return setConfigValue("apiKey", trimmed, path);
}
