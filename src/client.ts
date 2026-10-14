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

import { type SearchVertical, type SearloSettings, verticalSpec } from "./config.ts";

export interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	source?: string;
	published?: string;
	rank?: number;
	score?: number;
	/** `web`, `image`, `news`, `video`, `shopping` when the API labels it. */
	type?: string;
	/** Images vertical. */
	image?: SearchImage;
	/** News vertical. */
	news?: SearchNewsArticle;
	/** Shopping vertical, e.g. "$79.99". */
	price?: string;
}

export interface SearchImage {
	src?: string;
	thumbnail?: string;
	width?: number;
	height?: number;
	/** Page that hosts the image, usually a better link than the raw file. */
	contextLink?: string;
}

export interface SearchNewsArticle {
	source?: string;
	publishedDate?: string;
	author?: string;
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
	vertical: SearchVertical;
	url: string;
	status: number;
	elapsedMs: number;
	items: SearchResultItem[];
	information: SearchInformation;
	account: SearchAccount;
	/** Diagnostics for /searlo raw. */
	raw: { keys: string[]; first: unknown; total: number };
	/**
	 * TOON exactly as the endpoint returned it, when the body was TOON text rather than JSON.
	 * Searlo's REST search endpoints answer JSON even with format=toon, so this is normally unset and
	 * format.ts renders the TOON itself from the parsed items.
	 */
	toonText?: string;
}

/** How many results a response carries, whichever shape they arrived in: JSON items or TOON text. */
export function resultCount(response: SearchResponse): number {
	return response.items.length || response.raw.total;
}

export type SearloErrorKind =
	| "no-key"
	| "auth"
	| "http"
	| "network"
	| "shape"
	| "timeout"
	| "api"
	| "rate-limit"
	/** Mode "off" refused the search, so nothing was sent and nothing was billed. */
	| "disabled";

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

/** Reads the result list for a vertical: shopping uses its own key. */
export function extractItems(payload: unknown, vertical: SearchVertical = "web"): unknown[] {
	if (Array.isArray(payload)) return payload;
	const record = asRecord(payload);
	for (const key of verticalSpec(vertical).listKeys) {
		const value = record[key];
		if (Array.isArray(value)) return value;
		if (value && typeof value === "object") {
			const nested = asRecord(value);
			for (const inner of verticalSpec(vertical).listKeys) {
				if (Array.isArray(nested[inner])) return nested[inner] as unknown[];
			}
		}
	}
	return [];
}

function readImage(record: RecordLike): SearchImage | undefined {
	const nested = asRecord(record["image"]);
	const src = readString(nested, ["src", "url", "link"]) ?? readString(record, ["imageUrl", "image_url", "thumbnailUrl"]);
	const thumbnail = readString(nested, ["thumbnail", "thumb", "thumbnailUrl"]);
	const width = readNumber(nested, ["width"]);
	const height = readNumber(nested, ["height"]);
	const contextLink = readString(nested, ["contextLink", "context_link"]);
	if (!src && !thumbnail && !width && !height && !contextLink) return undefined;
	return { src, thumbnail, width, height, contextLink };
}

function readNews(record: RecordLike): SearchNewsArticle | undefined {
	const nested = asRecord(record["news"]);
	const source = readString(nested, ["source", "publisher"]);
	const publishedDate = readString(nested, ["publishedDate", "published_date", "date"]);
	const author = readString(nested, ["author", "by"]);
	if (!source && !publishedDate && !author) return undefined;
	return { source, publishedDate, author };
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
		const image = readImage(record);
		const news = readNews(record);
		const url = readString(record, URL_KEYS) ?? image?.contextLink ?? image?.src ?? "";
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
			source: news?.source ?? readString(record, SOURCE_KEYS),
			published: readString(record, DATE_KEYS) ?? news?.publishedDate,
			rank: readNumber(record, RANK_KEYS),
			score: readNumber(record, SCORE_KEYS),
			type: readString(record, ["type", "kind"]),
			image,
			news,
			price: readString(record, ["price", "productPrice", "priceFormated"]),
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
	vertical?: SearchVertical;
}

/** Resolves the endpoint for a vertical, falling back to the web path when misconfigured. */
export function endpointFor(settings: SearloSettings, vertical: SearchVertical): string {
	return settings.endpoints?.[vertical] || verticalSpec(vertical).path;
}

export function buildSearchUrl(
	settings: SearloSettings,
	query: string,
	options: Pick<SearchOptions, "limit" | "page" | "vertical"> = {},
): string {
	const vertical = options.vertical ?? settings.vertical ?? "web";
	const spec = verticalSpec(vertical);
	const path = endpointFor(settings, vertical);
	let url: URL;
	try {
		url = new URL(`${settings.baseUrl}${path}`);
	} catch {
		throw new SearloError(
			"shape",
			`invalid Searlo endpoint config: baseUrl="${settings.baseUrl}" ${vertical} endpoint="${path}" must combine into a valid URL`,
		);
	}
	url.searchParams.set("q", query);
	// Each endpoint publishes its own ceiling (10 for web/images/news/videos, 55 for shopping) and
	// answers an over-large limit with HTTP 400 VALIDATION_ERROR, so clamp the request itself rather
	// than trusting whatever a caller passed.
	const requested = Math.trunc(options.limit ?? settings.limit);
	const fallback = Number.isFinite(Math.trunc(settings.limit)) && settings.limit >= 1 ? settings.limit : spec.defaultLimit;
	const limit = Number.isFinite(requested) && requested >= 1 ? Math.min(spec.maxLimit, requested) : Math.min(spec.maxLimit, fallback);
	url.searchParams.set("limit", String(limit));
	const page = options.page ?? settings.page ?? 1;
	// Only the paginated endpoints document `page`; shopping would reject it.
	if (spec.paginated && page > 1) url.searchParams.set("page", String(page));
	for (const [key, value] of Object.entries(settings.params)) {
		if (!url.searchParams.has(key)) url.searchParams.set(key, value);
	}
	// Set last, so an explicit `params.format` still wins: Searlo also documents `enhanced`.
	if (settings.toon && !url.searchParams.has("format")) url.searchParams.set("format", "toon");
	return url.toString();
}

export async function search(settings: SearloSettings, query: string, options: SearchOptions): Promise<SearchResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new SearloError("shape", "empty query");
	if (!options.key) {
		throw new SearloError("no-key", "no Searlo API key configured — run /searlo login or set the key in searlo.json");
	}

	const vertical = options.vertical ?? settings.vertical ?? "web";
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
		throw apiFailure(response.status, text);
	}

	const parsed = parseJson(text);
	if (!parsed.parsed) {
		// A server that honours format=toon answers TOON text, not JSON. Hand it to the model exactly
		// as it arrived instead of reporting a shape failure: that text is the point of the option.
		const toon = settings.toon ? asToonText(text) : undefined;
		if (!toon) {
			const head = text.trimStart().slice(0, 40);
			throw new SearloError(
				"shape",
				`expected JSON from ${settings.baseUrl}${endpointFor(settings, vertical)}, got ${head.startsWith("<") ? "HTML" : "non-JSON"}: ${excerpt(text)}`,
			);
		}
		return {
			query: trimmed,
			vertical,
			url,
			status: response.status,
			elapsedMs,
			items: [],
			information: readInformation({}),
			account: readAccount(response.headers),
			raw: { keys: [], first: toon.head, total: toon.rows },
			toonText: toon.text,
		};
	}
	const payload = parsed.value;

	// success:false with a 200 is the documented failure envelope.
	const envelope = asRecord(payload);
	if (envelope["success"] === false) {
		const message = readString(envelope, ["error", "message", "detail"]) ?? "unspecified error";
		throw new SearloError("api", `Searlo reported success:false — ${message}`, response.status);
	}

	const rawItems = extractItems(payload, vertical);
	const first = rawItems[0];
	return {
		query: trimmed,
		vertical,
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

/**
 * A TOON array header: `results[2]{rank,title}:`, `items[0]:`, a root `[3]:`, or the same on a
 * list-item line (`- users[2]{id}:`). Requiring it is what keeps a plain-text upstream error —
 * `error: rate limited` reads as a TOON field line — from being served to the model as a result.
 */
const TOON_ARRAY_HEADER = /^[ \t]*(?:-[ \t]*)?(?:[A-Za-z_][\w.-]*)?\[(\d+)\](?:\{[^}\n]*\})?:[ \t]*$/m;

/**
 * Accepts a body only if it reads as a TOON document: not HTML, not empty, and carrying an array
 * header. That header is also where the row count comes from, since the rows themselves stay in the
 * text the model reads. Anything else is left to the caller's `shape` error.
 */
function asToonText(text: string): { text: string; head: string; rows: number } | undefined {
	const body = text.trim();
	if (!body || body.startsWith("<") || body.startsWith("{")) return undefined;
	const header = TOON_ARRAY_HEADER.exec(body);
	if (!header) return undefined;
	return { text: body, head: body.slice(0, 240), rows: Number(header[1]) };
}

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
 * Turns a non-2xx response into a SearloError. Searlo reports failures as
 * `{ success:false, code:"VALIDATION_ERROR", message, errors:[{field,message}] }`, so the
 * message quotes the offending field instead of dumping the raw JSON body at the model.
 */
const ERROR_KIND_BY_STATUS: Record<number, SearloErrorKind> = {
	400: "api",
	401: "auth",
	403: "auth",
	429: "rate-limit",
};

function apiFailure(status: number, body: string): SearloError {
	const kind = ERROR_KIND_BY_STATUS[status] ?? "http";
	const parsed = parseJson(body);
	const detail = parsed.parsed ? describeErrorBody(asRecord(parsed.value)) : undefined;
	const message = detail ?? excerpt(body);
	return new SearloError(kind, `Searlo returned HTTP ${status}: ${message}`, status);
}

function describeErrorBody(envelope: RecordLike): string | undefined {
	const code = readString(envelope, ["code", "error_code", "errorCode"]);
	const message = readString(envelope, ["message", "error", "detail"]);
	const errors = Array.isArray(envelope["errors"]) ? (envelope["errors"] as unknown[]).map((entry) => readString(asRecord(entry), ["field", "message"])) : [];
	const fields = errors.filter((value): value is string => Boolean(value)).join(", ");
	if (!code && !message) return undefined;
	return [code, message, fields ? `(${fields})` : ""].filter(Boolean).join(" ");
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
