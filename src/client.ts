/**
 * Searlo HTTP client.
 *
 *   GET {baseUrl}{endpoint}?q=…&limit=…&page=…   header: x-api-key: …
 *
 *   {
 *     "success": true,
 *     "searchInformation": { "totalResults": "1250000", "searchTime": 0.42,
 *                            "query": "…", "currentPage": 1, "hasNextPage": true },
 *     "items": [ { "rank": 1, "title": "…", "link": "…", "snippet": "…",
 *                  "domain": "…", "displayLink": "…" } ]
 *   }
 *
 *   Response headers: X-Cache (HIT|MISS), X-Credits-Deducted, X-Credits-Remaining.
 *
 * Item and envelope fields are read through alias lists so a renamed field or a
 * different backend shape degrades gracefully; `/searlo raw` reports the keys of the
 * first item so a surprise shape is a one-command diagnosis.
 */

import type { SearloSettings } from "./config.ts";

export interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	source?: string;
	published?: string;
	rank?: number;
	score?: number;
}

export interface SearchInformation {
	totalResults?: string;
	/** Seconds reported by the API, normalised to milliseconds. */
	searchTimeMs?: number;
	query?: string;
	currentPage?: number;
	hasNextPage?: boolean;
}

export interface SearchAccount {
	/** "HIT" or "MISS": a hit means this search cost no credits. */
	cache?: string;
	creditsDeducted?: number;
	creditsRemaining?: number;
}

export interface SearchResponse {
	query: string;
	url: string;
	status: number;
	elapsedMs: number;
	items: SearchResultItem[];
	information: SearchInformation;
	account: SearchAccount;
	/** Diagnostics for /searlo raw. */
	raw: { keys: string[]; first: unknown; total: number };
}

export type SearloErrorKind = "no-key" | "auth" | "http" | "network" | "shape" | "timeout" | "api";

export class SearloError extends Error {
	readonly kind: SearloErrorKind;
	/** HTTP status when the failure came from a response. */
	readonly status?: number;
	constructor(kind: SearloErrorKind, message: string, status?: number) {
		super(message);
		this.name = "SearloError";
		this.kind = kind;
		this.status = status;
	}
}

const TITLE_KEYS = ["title", "name", "headline"];
const URL_KEYS = ["link", "url", "href", "display_url", "displayUrl"];
const SNIPPET_KEYS = ["snippet", "content", "description", "text", "body", "summary"];
const SOURCE_KEYS = ["domain", "displayLink", "display_link", "source", "hostname", "host", "site"];
const DATE_KEYS = ["published", "published_date", "publishedDate", "date", "time", "age", "timestamp"];
const RANK_KEYS = ["rank", "position", "index"];
const SCORE_KEYS = ["score", "ranking"];

interface RecordLike {
	[key: string]: unknown;
}

function asRecord(value: unknown): RecordLike {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : {};
}

function readString(record: RecordLike, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number") return String(value);
	}
	return undefined;
}

function readNumber(record: RecordLike, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	}
	return undefined;
}

function readBoolean(record: RecordLike, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

/** Accepts the documented `items[]`, and common alternative shapes as fallbacks. */
export function extractItems(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	const record = asRecord(payload);
	for (const key of ["items", "results", "organic", "web", "data"]) {
		const value = record[key];
		if (Array.isArray(value)) return value;
		if (value && typeof value === "object") {
			const nested = asRecord(value);
			for (const inner of ["items", "results"]) {
				if (Array.isArray(nested[inner])) return nested[inner] as unknown[];
			}
		}
	}
	return [];
}

export function normalizeItems(rawItems: unknown[]): SearchResultItem[] {
	const seen = new Set<string>();
	const items: SearchResultItem[] = [];
	for (const entry of rawItems) {
		if (typeof entry === "string") {
			items.push({ title: entry, url: "", snippet: "" });
			continue;
		}
		const record = asRecord(entry);
		const url = readString(record, URL_KEYS) ?? "";
		const title = readString(record, TITLE_KEYS) ?? url ?? "Untitled result";
		const dedupeKey = url || title;
		if (dedupeKey) {
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
		}
		items.push({
			title,
			url,
			snippet: readString(record, SNIPPET_KEYS) ?? "",
			source: readString(record, SOURCE_KEYS),
			published: readString(record, DATE_KEYS),
			rank: readNumber(record, RANK_KEYS),
			score: readNumber(record, SCORE_KEYS),
		});
	}
	return items;
}

export function readInformation(payload: unknown): SearchInformation {
	const record = asRecord(asRecord(payload)["searchInformation"]);
	const seconds = readNumber(record, ["searchTime", "search_time", "time"]);
	return {
		totalResults: readString(record, ["totalResults", "total_results", "totalCount"]),
		searchTimeMs: seconds === undefined ? undefined : Math.round(seconds * 1000),
		query: readString(record, ["query"]),
		currentPage: readNumber(record, ["currentPage", "page"]),
		hasNextPage: readBoolean(record, "hasNextPage"),
	};
}

export function readAccount(headers: Headers): SearchAccount {
	return {
		cache: headers.get("x-cache") ?? undefined,
		creditsDeducted: readNumber({ deducted: headers.get("x-credits-deducted") }, ["deducted"]),
		creditsRemaining: readNumber({ remaining: headers.get("x-credits-remaining") }, ["remaining"]),
	};
}

export interface SearchOptions {
	key: string;
	signal?: AbortSignal;
	limit?: number;
	page?: number;
}

export function buildSearchUrl(settings: SearloSettings, query: string, options: Pick<SearchOptions, "limit" | "page"> = {}): string {
	let url: URL;
	try {
		url = new URL(`${settings.baseUrl}${settings.endpoint}`);
	} catch {
		throw new SearloError(
			"shape",
			`invalid Searlo endpoint config: baseUrl="${settings.baseUrl}" endpoint="${settings.endpoint}" must combine into a valid URL`,
		);
	}
	url.searchParams.set("q", query);
	url.searchParams.set("limit", String(options.limit ?? settings.limit));
	const page = options.page ?? settings.page ?? 1;
	if (page > 1) url.searchParams.set("page", String(page));
	for (const [key, value] of Object.entries(settings.params)) {
		if (!url.searchParams.has(key)) url.searchParams.set(key, value);
	}
	return url.toString();
}

export async function search(settings: SearloSettings, query: string, options: SearchOptions): Promise<SearchResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new SearloError("shape", "empty query");
	if (!options.key) {
		throw new SearloError("no-key", "no Searlo API key configured — run /searlo login or set the key in searlo.json");
	}

	const url = buildSearchUrl(settings, trimmed, options);
	const started = Date.now();
	const timeout = AbortSignal.timeout(settings.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { [settings.apiKeyHeader]: options.key, accept: "application/json" },
			signal,
		});
	} catch (error) {
		throw classifyFailure(error, timeout, settings.timeoutMs, options.signal);
	}

	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw classifyFailure(error, timeout, settings.timeoutMs, options.signal);
	}

	const elapsedMs = Date.now() - started;
	if (!response.ok) {
		const kind = response.status === 401 || response.status === 403 ? "auth" : "http";
		throw new SearloError(kind, `Searlo returned HTTP ${response.status}: ${excerpt(text)}`, response.status);
	}

	const parsed = parseJson(text);
	if (!parsed.parsed) {
		const head = text.trimStart().slice(0, 40);
		throw new SearloError(
			"shape",
			`expected JSON from ${settings.baseUrl}${settings.endpoint}, got ${head.startsWith("<") ? "HTML" : "non-JSON"}: ${excerpt(text)}`,
		);
	}
	const payload = parsed.value;

	// success:false with a 200 is the documented failure envelope.
	const envelope = asRecord(payload);
	if (envelope["success"] === false) {
		const message = readString(envelope, ["error", "message", "detail"]) ?? "unspecified error";
		throw new SearloError("api", `Searlo reported success:false — ${message}`, response.status);
	}

	const rawItems = extractItems(payload);
	const first = rawItems[0];
	return {
		query: trimmed,
		url,
		status: response.status,
		elapsedMs,
		items: normalizeItems(rawItems),
		information: readInformation(payload),
		account: readAccount(response.headers),
		raw: { keys: Object.keys(asRecord(first)), first, total: rawItems.length },
	};
}

type JsonPayload = { parsed: true; value: object | null } | { parsed: false };

function parseJson(text: string): JsonPayload {
	try {
		const decoded: unknown = JSON.parse(text);
		return { parsed: true, value: decoded !== null && typeof decoded === "object" ? (decoded as object) : null };
	} catch {
		return { parsed: false };
	}
}

function excerpt(text: string, max = 240): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat || "(empty body)";
}

/**
 * Decides what a fetch failure means by checking which signal fired, not the error name:
 * Node rejects with a TimeoutError on our timeout and with the caller's abort reason on a
 * cancelled turn, so the reason object itself is not a reliable discriminator.
 */
function classifyFailure(error: unknown, timeout: AbortSignal, timeoutMs: number, caller?: AbortSignal): SearloError {
	// A cancelled turn belongs to pi: report it as a plain error, not a Searlo outage.
	if (caller?.aborted) throw error;
	if (timeout.aborted) throw new SearloError("timeout", `Searlo request timed out after ${timeoutMs}ms`);
	const message = error instanceof Error ? error.message : String(error);
	throw new SearloError("network", `Searlo request failed: ${message}`);
}
