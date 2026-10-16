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

import { SEARLO_DASHBOARD_URL, type SearchVertical, type SearloSettings, verticalSpec } from "./config.ts";

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
	/** Scholar vertical. */
	scholar?: SearchScholarItem;
	/** Patents vertical. */
	patents?: SearchPatentItem;
	/** Maps/Places vertical. */
	maps?: SearchMapsItem;
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

export interface SearchScholarItem {
	/** Paper title. */
	title: string;
	/** Direct URL to the paper or landing page. */
	url: string;
	/** Authors as a comma-separated string or an array joined with ", ". */
	authors?: string;
	/** Venue or journal name, e.g. "NeurIPS 2024". */
	venue?: string;
	/** Publication year. */
	year?: string;
	/** Number of citations, if reported. */
	citations?: number;
	/** Short abstract or summary. */
	abstract?: string;
	/** The endpoint's own snippet field, kept for fallback. */
	snippet?: string;
	/** Source domain, e.g. "arxiv.org". */
	source?: string;
}

export interface SearchPatentItem {
	/** Patent number, e.g. "US11234567B2". */
	patentNumber?: string;
	/** Patent title. */
	title: string;
	/** Direct URL to the patent page. */
	url: string;
	/** Inventors as a comma-separated string. */
	inventors?: string;
	/** Assignee / owner company or institution. */
	assignee?: string;
	/** Filing or grant date. */
	date?: string;
	/** Abstract or summary. */
	abstract?: string;
	/** The endpoint's own snippet field, kept for fallback. */
	snippet?: string;
	/** Source domain. */
	source?: string;
}

export interface SearchMapsItem {
	/** Business or place name. */
	title: string;
	/** Direct URL to the Google Maps listing. */
	url: string;
	/** Full street address. */
	address?: string;
	/** Average rating (e.g. 4.5). */
	rating?: number;
	/** Number of reviews. */
	reviewCount?: number;
	/** Price level: 1-4 ($ to $$$$). */
	priceLevel?: number;
	/** Business category, e.g. "Italian restaurant". */
	category?: string;
	/** Phone number. */
	phone?: string;
	/** Business hours, e.g. "Open · Closes 10 PM". */
	hours?: string;
	/** Whether the place is currently open. */
	isOpen?: boolean;
	/** The endpoint's own snippet field, kept for fallback. */
	snippet?: string;
	/** Source domain. */
	source?: string;
}

export interface WebpageResult {
	/** The URL that was fetched. */
	url: string;
	/** Extracted page title. */
	title?: string;
	/** Main body text, stripped of HTML and navigation. */
	content: string;
	/** Word count of the extracted content. */
	wordCount?: number;
	/** Read time in minutes (approximate). */
	readTime?: number;
	/** Source domain. */
	source?: string;
}

export interface SearchInformation {
	totalResults?: string;
	/** Seconds reported by the API, normalised to milliseconds. */
	searchTimeMs?: number;
	query?: string;
	currentPage?: number;
	hasNextPage?: boolean;
	/** Domain restricted to this site for /search/site results. */
	site?: string;
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
	/** Searlo throttled the account (HTTP 429). */
	| "rate-limit"
	/**
	 * The account's credits are exhausted (HTTP 402, code `INSUFFICIENT_CREDITS`).
	 * Every paid endpoint fails with this until the balance is topped up.
	 */
	| "insufficient-credits"
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

/** Error kind specific to the webpage reader. */
export type WebpageErrorKind = "no-key" | "auth" | "http" | "network" | "shape" | "timeout" | "url" | "api" | "rate-limit" | "insufficient-credits";

export class WebpageError extends Error {
	readonly kind: WebpageErrorKind;
	readonly status?: number;
	constructor(kind: WebpageErrorKind, message: string, status?: number) {
		super(message);
		this.name = "WebpageError";
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

function readScholar(record: RecordLike): SearchScholarItem | undefined {
	const nested = asRecord(record["scholar"]);
	// Only create a scholar object when we find scholar-specific fields.
	const hasScholarFields =
		record["authors"] !== undefined ||
		record["venue"] !== undefined ||
		record["citations"] !== undefined ||
		record["citationCount"] !== undefined ||
		record["cited_by"] !== undefined ||
		record["journal"] !== undefined ||
		record["conference"] !== undefined ||
		record["publicationYear"] !== undefined ||
		record["abstract"] !== undefined ||
		nested["authors"] !== undefined ||
		nested["venue"] !== undefined ||
		nested["citations"] !== undefined ||
		nested["journal"] !== undefined ||
		nested["conference"] !== undefined ||
		nested["publicationYear"] !== undefined ||
		nested["abstract"] !== undefined;
	if (!hasScholarFields) return undefined;
	const title = readString(record, TITLE_KEYS) ?? readString(nested, ["title"]); 
	const url = readString(record, URL_KEYS) ?? readString(nested, ["url", "link"]); 
	const authors = readString(record, ["authors", "author"]) ?? readString(nested, ["authors", "author"]);
	const venue = readString(record, ["venue", "journal", "conference", "publication"]) ?? readString(nested, ["venue", "journal", "conference"]);
	const year = readString(record, ["year", "publicationYear", "date"]) ?? readString(nested, ["year", "publicationYear"]);
	const citations = readNumber(record, ["citations", "citationCount", "cited_by"]) ?? readNumber(nested, ["citations", "citationCount"]);
	const abstract = readString(record, ["abstract", "summary", "description"]) ?? readString(nested, ["abstract", "summary"]);
	const snippet = readString(record, SNIPPET_KEYS) ?? readString(nested, SNIPPET_KEYS);
	const source = readString(record, SOURCE_KEYS) ?? readString(nested, SOURCE_KEYS);
	if (!title && !url) return undefined;
	return { title: title ?? "Untitled", url: url ?? "", authors, venue, year, citations, abstract, snippet, source };
}

function readPatents(record: RecordLike): SearchPatentItem | undefined {
	const nested = asRecord(record["patents"]);
	// Only create a patents object when we find patent-specific fields.
	const hasPatentFields =
		record["patentNumber"] !== undefined ||
		record["patent_id"] !== undefined ||
		record["publicationNumber"] !== undefined ||
		record["inventors"] !== undefined ||
		record["inventor"] !== undefined ||
		record["assignee"] !== undefined ||
		record["owner"] !== undefined ||
		record["applicant"] !== undefined ||
		record["filingDate"] !== undefined ||
		record["grantDate"] !== undefined ||
		record["fullTextUrl"] !== undefined ||
		nested["patentNumber"] !== undefined ||
		nested["patent_id"] !== undefined ||
		nested["inventors"] !== undefined ||
		nested["assignee"] !== undefined ||
		nested["owner"] !== undefined ||
		nested["applicant"] !== undefined ||
		nested["filingDate"] !== undefined ||
		nested["grantDate"] !== undefined;
	if (!hasPatentFields) return undefined;
	const title = readString(record, TITLE_KEYS) ?? readString(nested, ["title"]); 
	const url = readString(record, URL_KEYS) ?? readString(nested, ["url", "link", "fullTextUrl"]); 
	const patentNumber = readString(record, ["patentNumber", "number", "patent_id", "publicationNumber"]) ?? readString(nested, ["patentNumber", "number", "patent_id"]);
	const inventors = readString(record, ["inventors", "inventor"]) ?? readString(nested, ["inventors", "inventor"]);
	const assignee = readString(record, ["assignee", "owner", "applicant", "company"]) ?? readString(nested, ["assignee", "owner", "applicant"]);
	const date = readString(record, ["date", "filingDate", "grantDate", "publicationDate", "year"]) ?? readString(nested, ["date", "filingDate", "grantDate", "publicationDate"]);
	const abstract = readString(record, ["abstract", "summary", "description"]) ?? readString(nested, ["abstract", "summary"]);
	const snippet = readString(record, SNIPPET_KEYS) ?? readString(nested, SNIPPET_KEYS);
	const source = readString(record, SOURCE_KEYS) ?? readString(nested, SOURCE_KEYS);
	if (!title && !url) return undefined;
	return { title: title ?? "Untitled", url: url ?? "", patentNumber, inventors, assignee, date, abstract, snippet, source };
}

function readMaps(record: RecordLike): SearchMapsItem | undefined {
	const nested = asRecord(record["maps"]);
	// Only create a maps object when we find maps-specific fields.
	const hasMapsFields =
		record["address"] !== undefined ||
		record["rating"] !== undefined ||
		record["reviewCount"] !== undefined ||
		record["priceLevel"] !== undefined ||
		record["category"] !== undefined ||
		record["phone"] !== undefined ||
		record["hours"] !== undefined ||
		record["isOpen"] !== undefined ||
		record["businessStatus"] !== undefined ||
		record["latitude"] !== undefined ||
		record["longitude"] !== undefined ||
		nested["address"] !== undefined ||
		nested["rating"] !== undefined ||
		nested["reviewCount"] !== undefined ||
		nested["hours"] !== undefined ||
		nested["isOpen"] !== undefined;
	if (!hasMapsFields) return undefined;
	const title = readString(record, TITLE_KEYS) ?? readString(nested, ["title", "name"]);
	const url = readString(record, URL_KEYS) ?? readString(nested, ["url", "link", "website"]); 
	const address = readString(record, ["address", "formattedAddress", "address_text"]) ?? readString(nested, ["address", "formattedAddress"]);
	const rating = readNumber(record, ["rating", "averageRating", "ratingValue"]) ?? readNumber(nested, ["rating", "averageRating"]);
	const reviewCount = readNumber(record, ["reviewCount", "reviews", "reviewCountInt"]) ?? readNumber(nested, ["reviewCount", "reviews"]);
	const priceLevel = readNumber(record, ["priceLevel", "price_level", "priceRange"]) ?? readNumber(nested, ["priceLevel", "price_level"]);
	const category = readString(record, ["category", "type", "businessType", "plusCode"]) ?? readString(nested, ["category", "type"]);
	const phone = readString(record, ["phone", "phoneNumber", "telephone"]) ?? readString(nested, ["phone", "phoneNumber"]);
	const hours = readString(record, ["hours", "openingHours", "businessHours"]) ?? readString(nested, ["hours", "openingHours"]);
	const isOpen = record["isOpen"] !== undefined ? Boolean(record["isOpen"]) : undefined;
	const snippet = readString(record, SNIPPET_KEYS) ?? readString(nested, SNIPPET_KEYS);
	const source = readString(record, SOURCE_KEYS) ?? readString(nested, SOURCE_KEYS);
	if (!title && !url) return undefined;
	return { title: title ?? "Untitled", url: url ?? "", address, rating, reviewCount, priceLevel, category, phone, hours, isOpen, snippet, source };
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
		const scholar = readScholar(record);
		const patents = readPatents(record);
		const maps = readMaps(record);
		const url = readString(record, URL_KEYS) ?? image?.contextLink ?? image?.src ?? "";
		const title = readString(record, TITLE_KEYS) ?? url ?? "Untitled result";
		const dedupeKey = url || title;
		if (dedupeKey) {
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
		}
		const item: SearchResultItem = {
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
		};
		// Only add scholar/patents/maps when they have actual data.
		if (scholar) item.scholar = scholar;
		if (patents) item.patents = patents;
		if (maps) item.maps = maps;
		items.push(item);
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
	const parsed = parseJson(text);
	if (!response.ok) {
		throw apiFailure(response.status, text, parsed);
	}
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
 * The account's credit balance (GET /api/v1/credit/balance). The call is free: it reads the
 * balance, it does not spend anything. Fields are optional because the endpoint documents them
 * individually, and an account may report no upcoming expiry at all.
 */
export interface CreditBalance {
	/** Credits available to spend now. */
	available?: number;
	/** True when the balance is below the account's low-balance threshold (100 by default). */
	isLowBalance?: boolean;
	/** When the next credit batch expires, if the account reports one. */
	nextExpiryAt?: string;
	/** How many credits expire then. */
	nextExpiryAmount?: number;
	/** Days until the next expiry. */
	daysUntilNextExpiry?: number;
	/** Elapsed time of the request, for /searlo credits output. */
	elapsedMs: number;
}

/**
 * Fetch the account's credit balance. Free — no credits are spent — but the key is still
 * required, and failures map to the same SearloError kinds as search (including 402 as
 * `insufficient-credits`, should the endpoint ever report a dead account).
 */
export async function creditBalance(settings: SearloSettings, key: string, options: { signal?: AbortSignal } = {}): Promise<CreditBalance> {
	if (!key) {
		throw new SearloError("no-key", "no Searlo API key configured — run /searlo login or set the key in searlo.json");
	}

	let url: URL;
	try {
		url = new URL(`${settings.baseUrl}${CREDIT_BALANCE_PATH}`);
	} catch {
		throw new SearloError(
			"shape",
			`invalid Searlo endpoint config: baseUrl="${settings.baseUrl}" ${CREDIT_BALANCE_PATH} must combine into a valid URL`,
		);
	}

	const started = Date.now();
	const timeout = AbortSignal.timeout(settings.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { [settings.apiKeyHeader]: key, accept: "application/json" },
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
	// The failing call IS the credits check, so this path keeps the top-up link but not the pointer back to /searlo credits.
	if (!response.ok) throw httpFailure(response.status, text);

	const parsed = parseJson(text);
	if (!parsed.parsed) {
		throw new SearloError("shape", `expected JSON from ${settings.baseUrl}${CREDIT_BALANCE_PATH}, got ${excerpt(text)}`, response.status);
	}

	const payload = asRecord(parsed.value);
	// success:false with a 200 is the documented failure envelope.
	if (payload["success"] === false) {
		const message = readString(payload, ["error", "message", "detail"]) ?? "unspecified error";
		throw new SearloError("api", `Searlo reported success:false — ${message}`, response.status);
	}

	// The documented shape nests the fields under `data`; a flat body is tolerated too.
	const data = asRecord(payload["data"]);
	const record = Object.keys(data).length > 0 ? data : payload;
	const expiry = asRecord(record["expiry"]);

	return {
		available: readNumber(record, ["available", "balance"]),
		isLowBalance: readBoolean(record, "isLowBalance"),
		nextExpiryAt: readString(expiry, ["nextExpiryAt"]),
		nextExpiryAmount: readNumber(expiry, ["nextExpiryAmount"]),
		daysUntilNextExpiry: readNumber(expiry, ["daysUntilNextExpiry"]),
		elapsedMs,
	};
}

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
	402: "insufficient-credits",
};

/** The free account endpoint: it reads the balance, it never spends credits. */
const CREDIT_BALANCE_PATH = "/api/v1/credit/balance";

/** Map a non-OK HTTP response to the matching SearloError: the core mapping, with no credits pointer. */
function httpFailure(status: number, body: string, parsed?: JsonPayload): SearloError {
	const kind = ERROR_KIND_BY_STATUS[status] ?? "http";
	const resolved = parsed ?? parseJson(body);
	const detail = resolved.parsed ? describeErrorBody(asRecord(resolved.value)) : undefined;
	const message = detail ?? excerpt(body);
	// A 402 is not an outage: the account has run out of credits, and the fix is an action, not a retry.
	const hint = status === 402 ? ` — the account has run out of credits: top up at ${SEARLO_DASHBOARD_URL}` : "";
	return new SearloError(kind, `Searlo returned HTTP ${status}: ${message}${hint}`, status);
}

/** A failed paid call: same mapping, plus the pointer to the free balance command. */
function apiFailure(status: number, body: string, parsed?: JsonPayload): SearloError {
	const error = httpFailure(status, body, parsed);
	if (status !== 402) return error;
	return new SearloError(error.kind, `${error.message} (balance: /searlo credits)`, status);
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

/** The webpage reader endpoint: takes a URL and returns extracted text. */
const WEBPAGE_PATH = "/api/v1/search/webpage";

export interface ReadWebpageOptions {
	key: string;
	signal?: AbortSignal;
	/** When set, limits the extracted content to this many characters. */
	maxChars?: number;
}

/**
 * Extract text from a web page via the Searlo webpage reader.
 *
 *   GET {baseUrl}/api/v1/search/webpage?url=…&maxChars=…
 *
 *   {
 *     "success": true,
 *     "url": "https://example.com/article",
 *     "title": "Article Title",
 *     "content": "Extracted text…",
 *     "wordCount": 1234,
 *     "readTime": 5
 *   }
 */
export async function readWebpage(settings: SearloSettings, url: string, options: ReadWebpageOptions): Promise<WebpageResult> {
	if (!options.key) {
		throw new WebpageError("no-key", "no Searlo API key configured — run /searlo login or set the key in searlo.json");
	}

	// Validate the URL before sending.
	try {
		new URL(url);
	} catch {
		throw new WebpageError("url", `invalid URL: ${excerpt(url, 200)}`);
	}

	let requestUrl: URL;
	try {
		requestUrl = new URL(`${settings.baseUrl}${WEBPAGE_PATH}`);
	} catch {
		throw new WebpageError(
			"shape",
			`invalid Searlo endpoint config: baseUrl="${settings.baseUrl}" ${WEBPAGE_PATH} must combine into a valid URL`,
		);
	}

	requestUrl.searchParams.set("url", url);
	const maxChars = options.maxChars ?? settings.contentBudgetChars;
	requestUrl.searchParams.set("maxChars", String(maxChars));

	const timeout = AbortSignal.timeout(settings.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(requestUrl, {
			method: "GET",
			headers: { [settings.apiKeyHeader]: options.key, accept: "application/json" },
			signal,
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		if (timeout.aborted) throw new WebpageError("timeout", `webpage reader timed out after ${settings.timeoutMs}ms`);
		const message = error instanceof Error ? error.message : String(error);
		throw new WebpageError("network", `webpage reader failed: ${message}`);
	}

	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw new WebpageError("network", `failed to read response: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!response.ok) {
		const kind = (ERROR_KIND_BY_STATUS[response.status] ?? "http") as WebpageErrorKind;
		const parsed = parseJson(text);
		const detail = parsed.parsed ? describeErrorBody(asRecord(parsed.value)) : undefined;
		throw new WebpageError(kind, `webpage reader returned HTTP ${response.status}: ${detail ?? excerpt(text, 200)}`, response.status);
	}

	const parsed = parseJson(text);
	if (!parsed.parsed) {
		throw new WebpageError("shape", `expected JSON from ${settings.baseUrl}${WEBPAGE_PATH}, got ${excerpt(text, 200)}`);
	}

	const envelope = asRecord(parsed.value);
	if (envelope["success"] === false) {
		const message = readString(envelope, ["error", "message", "detail"]) ?? "unspecified error";
		throw new WebpageError("api", `webpage reader reported success:false — ${message}`);
	}

	// The documented shape nests fields under `data`; a flat body is tolerated too.
	const data = asRecord(envelope["data"]);
	const record = Object.keys(data).length > 0 ? data : envelope;

	return {
		url: readString(record, ["url"]) ?? url,
		title: readString(record, ["title", "heading"]),
		content: readString(record, ["content", "text", "body", "extracted"]) ?? "",
		wordCount: readNumber(record, ["wordCount", "word_count"]),
		readTime: readNumber(record, ["readTime", "read_time", "minutes"]),
		source: readString(record, ["source", "domain"]),
	};
}
