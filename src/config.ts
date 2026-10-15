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
import type { CreditBalance } from "./client.ts";

export const CONFIG_BASENAME = "searlo.json";
export const DEFAULT_API_KEY_ENV = "SEARLO_API_KEY";
/** Path overrides from searlo.json, e.g. if Searlo renames an endpoint. */
export function defaultEndpoints(): Record<SearchVertical, string> {
	const paths = {} as Record<SearchVertical, string>;
	for (const name of VERTICAL_NAMES) paths[name] = VERTICALS[name].path;
	return paths;
}

/** The API rejects limit above the vertical ceiling with HTTP 400 VALIDATION_ERROR. */
export const MAX_LIMIT = 10;

/**
 * `off` refuses every search, including the ones you ask for by hand; `manual` hides the tool and
 * answers only to `/searlo` commands. `tool` lets the model search, `auto` also injects per prompt.
 */
export type SearloMode = "off" | "manual" | "tool" | "auto";

/** The nine Searlo search endpoints. */
export type SearchVertical = "web" | "images" | "news" | "videos" | "shopping" | "scholar" | "patents" | "site" | "maps";

export interface VerticalSpec {
	/** Default path appended to baseUrl. */
	readonly path: string;
	readonly minLimit: number;
	/** Each endpoint publishes its own ceiling: shopping accepts 55, the rest 10. */
	readonly maxLimit: number;
	/** What we ask for when the user configured no limit for this vertical. */
	readonly defaultLimit: number;
	/** Only this endpoint documents a page parameter. */
	readonly paginated: boolean;
	/** Envelope keys that may hold the list, in preference order. */
	readonly listKeys: readonly string[];
	/** Singular label used in model-facing output, e.g. "product listing". */
	readonly itemLabel: string;
}

export const VERTICALS: Record<SearchVertical, VerticalSpec> = {
	web: {
		path: "/api/v1/search/web",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 5,
		paginated: true,
		listKeys: ["items", "results", "organic", "web", "data"],
		itemLabel: "result",
	},
	images: {
		path: "/api/v1/search/images",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 8,
		paginated: true,
		listKeys: ["items", "results", "images"],
		itemLabel: "image",
	},
	news: {
		path: "/api/v1/search/news",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 8,
		paginated: true,
		listKeys: ["items", "results", "news"],
		itemLabel: "article",
	},
	videos: {
		path: "/api/v1/search/videos",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 8,
		paginated: true,
		listKeys: ["items", "results", "videos"],
		itemLabel: "video",
	},
	shopping: {
		path: "/api/v1/search/shopping",
		minLimit: 1,
		maxLimit: 55,
		defaultLimit: 12,
		paginated: false,
		listKeys: ["shopping", "items", "results"],
		itemLabel: "product",
	},
	scholar: {
		path: "/api/v1/search/scholar",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 5,
		paginated: true,
		listKeys: ["items", "results", "papers", "scholar"],
		itemLabel: "paper",
	},
	patents: {
		path: "/api/v1/search/patents",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 5,
		paginated: true,
		listKeys: ["items", "results", "patents"],
		itemLabel: "patent",
	},
	site: {
		path: "/api/v1/search/site",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 5,
		paginated: true,
		listKeys: ["items", "results", "site"],
		itemLabel: "result",
	},
	maps: {
		path: "/api/v1/search/maps",
		minLimit: 1,
		maxLimit: 10,
		defaultLimit: 5,
		paginated: false,
		listKeys: ["items", "results", "places", "local"],
		itemLabel: "place",
	},
};

export const VERTICAL_NAMES = Object.keys(VERTICALS) as SearchVertical[];

export function isVertical(value: unknown): value is SearchVertical {
	return typeof value === "string" && Object.hasOwn(VERTICALS, value);
}

export function verticalSpec(vertical: SearchVertical): VerticalSpec {
	return VERTICALS[vertical];
}

export interface SearloSettings {
	/** Searlo API root, no trailing slash, e.g. https://api.searlo.tech */
	baseUrl: string;
	/** Endpoint path per vertical. */
	endpoints: Record<SearchVertical, string>;
	/** Deprecated single-path form; still accepted and applied to the vertical it names. */
	endpoint?: string;
	/** Vertical used when a search does not name one. */
	vertical: SearchVertical;
	/** Environment variable holding the API key. */
	apiKeyEnv: string;
	/** Key literal, or "env:VARNAME" to read process.env.VARNAME. */
	apiKey?: string;
	/** Header carrying the key. */
	apiKeyHeader: string;
	/** Result count requested from the API, clamped to the vertical's ceiling. */
	limit: number;
	/** 1-based page for the documented `page` parameter; 1 is never sent. */
	page?: number;
	/** Extra query parameters passed through verbatim. */
	params: Record<string, string>;
	/** Request timeout in milliseconds. */
	timeoutMs: number;
	/** Search policy for this session: off | manual | tool | auto. */
	mode: SearloMode;
	/**
	 * Ask Searlo for TOON (`format=toon`) and hand the model a TOON block instead of the text list:
	 * one header line naming the columns, then one row per result, so the same results cost fewer
	 * tokens. Off by default because the citation list format is the one pi users see in logs.
	 */
	toon: boolean;
	/** Max characters of snippet text handed to the model per search. */
	contentBudgetChars: number;
	/** Emit the citation/rules preamble in search context blocks. */
	includeCitations: boolean;
	/** Shortcut that opens the Searlo picker. Any pi KeyId, e.g. "f3", "ctrl+g", "alt+s". */
	shortcut: string;
	/** Show "Searlo: <vertical>" in the bottom bar whenever searching is enabled. */
	showStatus: boolean;
	/** Domain restriction for site-restricted search (e.g. "arxiv.org"). */
	site?: string;
	/** Location for maps search: "lat,lng,radius" (e.g. "40.7128,-74.0060,5000") or a named place. */
	mapsLocation?: string;
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

/** Where the account can be topped up, for messages that need to point there. */
export const SEARLO_DASHBOARD_URL = "https://dashboard.searlo.tech";

export const DEFAULT_SETTINGS: SearloSettings = {
	baseUrl: "https://api.searlo.tech",
	endpoints: defaultEndpoints(),
	vertical: "web",
	apiKeyEnv: DEFAULT_API_KEY_ENV,
	apiKeyHeader: "x-api-key",
	limit: 5,
	page: 1,
	params: {},
	timeoutMs: 8000,
	mode: "tool",
	toon: false,
	contentBudgetChars: 6000,
	includeCitations: true,
	shortcut: "f3",
	showStatus: true,
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

/** Normalise a site domain: strip protocol, trailing slash, and leading www. */
export function normaliseSite(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let cleaned = value.trim();
	if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
		try {
			const url = new URL(cleaned);
			cleaned = url.hostname.replace(/^www\./, "");
		} catch {
			// Fall through — keep the raw value if URL parsing fails.
		}
	}
	return cleaned.replace(/\/+$/, "");
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

/** Endpoint paths per vertical, with the documented defaults, tolerating junk or legacy `endpoint`. */
function normalizeEndpoints(
	value: unknown,
	legacy: unknown,
	vertical: SearchVertical,
	errors: string[],
): Record<SearchVertical, string> {
	const endpoints = defaultEndpoints();
	const layer = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	for (const name of VERTICAL_NAMES) {
		const raw = layer[name];
		if (typeof raw !== "string" || !raw.trim()) continue;
		const path = raw.trim();
		endpoints[name] = path.startsWith("/") ? path : `/${path}`;
	}
	// searlo.json written before verticals used a single `endpoint`, which applied to the active vertical.
	if (typeof legacy === "string" && legacy.trim() && layer[vertical] === undefined) {
		const path = legacy.trim();
		endpoints[vertical] = path.startsWith("/") ? path : `/${path}`;
	}
	for (const key of Object.keys(layer)) {
		if (!isVertical(key)) errors.push(`endpoints.${key} is not a known search vertical, ignored`);
	}
	return endpoints;
}

/** In picker order: the modes a user can be in, from most to least searching. */
export const MODE_NAMES: readonly SearloMode[] = ["off", "manual", "tool", "auto"];

export function isMode(value: unknown): value is SearloMode {
	return typeof value === "string" && (MODE_NAMES as readonly string[]).includes(value);
}

function normalizeVertical(value: unknown, errors: string[]): SearchVertical {
	if (value === undefined) return DEFAULT_SETTINGS.vertical;
	if (isVertical(value)) return value;
	errors.push(`vertical "${String(value)}" is not one of ${VERTICAL_NAMES.join("|")}, using "${DEFAULT_SETTINGS.vertical}"`);
	return DEFAULT_SETTINGS.vertical;
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

/**
 * Loose KeyId validation: pi owns the real grammar (and terminal support varies), so we only
 * reject obvious junk and let a bad binding surface as a registration error at startup.
 */
function normalizeShortcut(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_SETTINGS.shortcut;
	const trimmed = value.trim().toLowerCase();
	if (!/^(?:(?:ctrl|shift|alt|cmd|super|meta)(?:[-+][a-z0-9]+|\+[a-z]+)|f(?:1[0-2]|[1-9])|[a-z0-9]|escape|esc|enter|tab|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right)(?:[-+][a-z0-9]+)*$/i.test(trimmed)) {
		return DEFAULT_SETTINGS.shortcut;
	}
	return trimmed;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalize(settings: SearloSettings): SearloSettings {
	const baseUrl = String(settings.baseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.baseUrl;
	const errors = settings.errors ?? [];
	const check = validPattern(errors);
	const mode = settings.mode;
	const vertical = normalizeVertical(settings.vertical, errors);
	const endpoints = normalizeEndpoints(settings.endpoints, settings.endpoint, settings.vertical ?? DEFAULT_SETTINGS.vertical, errors);
	const spec = verticalSpec(vertical);
	const limit = clampInt(settings.limit, spec.defaultLimit, spec.minLimit, spec.maxLimit);
	return {
		...settings,
		errors,
		baseUrl,
		endpoints,
		vertical,
		apiKeyEnv: String(settings.apiKeyEnv ?? "").trim() || DEFAULT_SETTINGS.apiKeyEnv,
		apiKeyHeader: String(settings.apiKeyHeader ?? "").trim() || DEFAULT_SETTINGS.apiKeyHeader,
		limit,
		timeoutMs: clampInt(settings.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 500, 120000),
		contentBudgetChars: clampInt(settings.contentBudgetChars, DEFAULT_SETTINGS.contentBudgetChars, 500, 200000),
		params: toStringParams(settings.params),
		page: clampInt(settings.page, 1, 1, 100),
		mode: isMode(mode) ? mode : DEFAULT_SETTINGS.mode,
		toon: normalizeBool(settings.toon, DEFAULT_SETTINGS.toon),
		includeCitations: settings.includeCitations !== false,
		shortcut: normalizeShortcut(settings.shortcut),
		showStatus: normalizeBool(settings.showStatus, true),
		site: normaliseSite(settings.site),
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
	if (typeof merged.site === "string") merged.site = normaliseSite(merged.site);
	return merged;
}

export interface LoadOptions {
	/** Project directory enabling `.pi/searlo.json`. Omit to load user config only. */
	cwd?: string;
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
		return cache.config;
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
	return config;
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

/**
 * Below this length the "masked" form is not masked: five characters plus four would be most of a
 * short key, and nine of them reproduce a nine-character key in full. That string ends up in
 * notifications and in `/searlo config`, both of which pi records in the transcript.
 */
const MASK_REVEAL_MIN_LENGTH = 16;

/** A key reduced to something safe to print: stars, or a prefix and suffix of a long key. */
export function maskKey(key: string): string {
	if (key.length <= MASK_REVEAL_MIN_LENGTH) return "*".repeat(key.length);
	return `${key.slice(0, 5)}…${key.slice(-4)} (${key.length} chars)`;
}

/**
 * A one-shot low-balance warning for session start. Returns undefined when there is nothing to
 * say: no balance reported, the account itself does not flag the balance as low, or the balance is
 * comfortably above the threshold. The threshold is deliberately high (100) because a web search
 * costs one credit and a session can burn dozens before the user notices.
 */
export function warnLowCredits(balance: CreditBalance, threshold = 100): string | undefined {
	const available = balance.available;
	if (available === undefined) return balance.isLowBalance ? lowBalanceMessage(undefined) : undefined;
	if (!balance.isLowBalance && available >= threshold) return undefined;
	return lowBalanceMessage(available);
}

function lowBalanceMessage(available: number | undefined): string {
	const shown = available !== undefined ? `${available} credit(s)` : "a low balance";
	return `Searlo credits are low (${shown}) — searches will start failing with HTTP 402. Top up at ${SEARLO_DASHBOARD_URL} or check the balance with /searlo credits`;
}

export function defaultConfigTemplate(): string {
	const template: Record<string, unknown> = {
		baseUrl: DEFAULT_SETTINGS.baseUrl,
		apiKey: `env:${DEFAULT_API_KEY_ENV}`,
		apiKeyHeader: DEFAULT_SETTINGS.apiKeyHeader,
		// web | images | news | videos | shopping | scholar | patents | site — the vertical used when a search names none.
		vertical: DEFAULT_SETTINGS.vertical,
		// Per-vertical paths, only needed if Searlo renames an endpoint.
		endpoints: defaultEndpoints(),
		// "off" refuses every search, "manual" is /searlo only, "tool" lets the model search,
		// "auto" also injects into every matching prompt.
		mode: "tool",
		// true sends format=toon and gives the model a TOON table instead of the text list.
		toon: false,
		// Opens the mode/vertical picker; any pi KeyId works, e.g. "ctrl+g".
		shortcut: "f3",
		showStatus: true,
		limit: 5,
		timeoutMs: 8000,
		contentBudgetChars: 6000,
		// Passed through verbatim: gl/hl for locale, size for images,
		// safe for videos, site for domain-restricted search.
		params: { hl: "en", gl: "us" },
		// Restricts web/site searches to one domain, e.g. "arxiv.org".
		// site: "arxiv.org",
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
