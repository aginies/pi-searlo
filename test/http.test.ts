import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { creditBalance, resultCount, SearloError, search, buildSearchUrl } from "../src/client.ts";
import { DEFAULT_SETTINGS, type SearloSettings } from "../src/config.ts";

/** Query strings that select a mock behaviour, so each test drives exactly one path. */
const MODE_BY_QUERY: Record<string, string> = {
	"401": "auth",
	"402": "insufficient",
	"400": "400",
	"500": "http",
	html: "html",
	badjson: "badjson",
	empty: "empty",
	fail: "fail",
	hang: "hang",
	/** A server that honours format=toon answers this instead of JSON. */
	toon: "toon",
	/** Plain text that merely looks like TOON: an upstream error, and a fields-only document. */
	texterror: "texterror",
	toonfields: "toonfields",
};

/** The body a TOON-honouring endpoint returns: header line, then one row per result. */
const TOON_BODY = [
	"vertical: web",
	"query: toon",
	"showing: 2",
	"results[2]{rank,title,url,snippet}:",
	'  1,First,"https://a.test/1",alpha',
	'  2,Second,"https://b.test/2",beta',
].join("\n");

let server: Server;
let baseUrl: string;
const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
/** Selects the /credit/balance mock behaviour; tests set it before each call. */
let balanceMode = "ok";

/** The mock answers whatever the `q` parameter asks for, so each test drives one behaviour. */
function reply(mode: string, res: ServerResponse) {
	switch (mode) {
		case "auth":
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "invalid api key" }));
			return;
		case "insufficient":
			res.writeHead(402, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					success: false,
					code: "INSUFFICIENT_CREDITS",
					message: "Your credits have run out. Top up to continue using the API.",
				}),
			);
			return;
		case "http":
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("upstream exploded");
			return;
		case "html":
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<!doctype html><html><body>login required</body></html>");
			return;
		case "badjson":
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{truncated");
			return;
		case "400":
			res.writeHead(400, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					success: false,
					code: "VALIDATION_ERROR",
					message: 'Query validation failed: "limit" must be less than or equal to 10',
					errors: [{ field: "limit", message: '"limit" must be less than or equal to 10' }],
				}),
			);
			return;
		case "empty":
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: true, items: [] }));
			return;
		case "fail":
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: false, error: "insufficient credits" }));
			return;
		case "texterror":
			// A 200 whose body is a plain-text error: `error: …` parses as a TOON field line, so
			// accepting it would hand the model an outage notice dressed up as a search result.
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("error: rate limited\n");
			return;
		case "toonfields":
			// Valid TOON fields, but no array: nothing was found, and there is no row count to trust.
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("vertical: web\nshowing: 0\n");
			return;
		case "hang":
			// Never respond: the client timeout must fire.
			return;
		case "toon":
			res.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"x-cache": "MISS",
				"x-credits-deducted": "1",
				"x-credits-remaining": "4999",
			});
			res.end(TOON_BODY);
			return;
		default:
			res.writeHead(200, {
				"content-type": "application/json",
				"x-cache": "MISS",
				"x-credits-deducted": "1",
				"x-credits-remaining": "4999",
			});
			res.end(
				JSON.stringify({
					success: true,
					searchInformation: {
						totalResults: "1250000",
						searchTime: 0.42,
						query: "hello world",
						currentPage: 1,
						hasNextPage: true,
					},
					items: [
						{ rank: 1, title: "First", link: "https://a.test/1", snippet: "alpha", domain: "a.test", displayLink: "a.test" },
						{ rank: 2, title: "Second", link: "https://b.test/2", snippet: "beta", domain: "b.test" },
					],
				}),
			);
	}
}

/** The credit-balance endpoint answers by `balanceMode`, so each test drives one shape. */
function replyBalance(res: ServerResponse) {
	switch (balanceMode) {
		case "flat":
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: true, available: 7, isLowBalance: true }));
			return;
		case "auth":
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "invalid api key" }));
			return;
		case "402":
			res.writeHead(402, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: false, code: "INSUFFICIENT_CREDITS", message: "credits exhausted" }));
			return;
		case "plain":
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("nope");
			return;
		default:
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					success: true,
					data: {
						available: 4200,
						isLowBalance: false,
						expiry: { nextExpiryAt: "2026-12-31T00:00:00Z", nextExpiryAmount: 500, daysUntilNextExpiry: 170 },
					},
				}),
			);
	}
}

before(async () => {
	server = createServer((req, res) => {
		seen.push({ url: req.url ?? "", headers: req.headers });
		if ((req.url ?? "").startsWith("/api/v1/credit/balance")) {
			replyBalance(res);
			return;
		}
		const query = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
		reply(MODE_BY_QUERY[query] ?? "ok", res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function settings(overrides: Partial<SearloSettings> = {}): SearloSettings {
	return { ...DEFAULT_SETTINGS, baseUrl, endpoint: "/api/v1/search/web", ...overrides };
}

test("sends the documented request and maps the documented envelope", async () => {
	seen.length = 0;
	const response = await search(settings(), "hello world", { key: "sk_test_1234567890", limit: 5 });

	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "/api/v1/search/web?q=hello+world&limit=5");
	assert.equal(seen[0].headers["x-api-key"], "sk_test_1234567890");
	assert.equal(seen[0].headers.accept, "application/json");

	assert.equal(response.status, 200);
	assert.equal(response.items.length, 2);
	assert.deepEqual(response.items[0], {
		title: "First",
		url: "https://a.test/1",
		snippet: "alpha",
		source: "a.test",
		published: undefined,
		rank: 1,
		score: undefined,
		type: undefined,
		image: undefined,
		news: undefined,
		price: undefined,
	});
	assert.deepEqual(response.information, {
		totalResults: "1250000",
		searchTimeMs: 420,
		query: "hello world",
		currentPage: 1,
		hasNextPage: true,
	});
	assert.deepEqual(response.account, { cache: "MISS", creditsDeducted: 1, creditsRemaining: 4999 });
	assert.deepEqual(response.raw.keys, ["rank", "title", "link", "snippet", "domain", "displayLink"]);
});

test("success:false in a 200 body is an api error, not zero results", async () => {
	await assert.rejects(
		search(settings(), "fail", { key: "k" }),
		(error) => error instanceof SearloError && error.kind === "api" && /insufficient credits/.test(error.message),
	);
});

test("sends page only when it is past the first page", async () => {
	seen.length = 0;
	await search(settings({ page: 3 }), "hello world", { key: "k" });
	assert.match(seen[0].url, /[?&]page=3/);
	assert.equal(new URLSearchParams(new URL(seen[0].url, baseUrl).search).get("limit"), "5");
});

test("clamps limit to the API maximum instead of sending a 400", () => {
	assert.match(buildSearchUrl(settings(), "q", { limit: 15 }), /limit=10/);
	assert.match(buildSearchUrl(settings(), "q", { limit: 0 }), /limit=5/, "a junk limit falls back to the configured one");
	assert.match(buildSearchUrl({ ...settings(), limit: 99 }, "q"), /limit=10/);
	assert.match(buildSearchUrl(settings(), "q", { limit: 3 }), /limit=3/);
});

test("an HTTP 400 validation body becomes a readable message, not raw JSON", async () => {
	await assert.rejects(
		search(settings(), "400", { key: "k" }),
		(error) => {
			if (!(error instanceof SearloError) || error.kind !== "api" || error.status !== 400) return false;
			assert.match(error.message, /VALIDATION_ERROR/);
			assert.match(error.message, /limit/);
			assert.doesNotMatch(error.message, /\{\s*"success/, "must not dump the raw JSON body at the model");
			return true;
		},
	);
});

test("passes configured params through", async () => {
	seen.length = 0;
	await search(settings({ params: { language: "fr", tokens: "1" } }), "hello world", { key: "k" });
	assert.match(seen[0].url, /language=fr/);
	assert.match(seen[0].url, /tokens=1/);
});

test("reports the auth failure without echoing the key", async () => {
	await assert.rejects(
		search(settings(), "401", { key: "sk_secret_value" }),
		(error) => error instanceof SearloError && error.kind === "auth" && !error.message.includes("sk_secret_value"),
	);
});

test("HTTP 402 is an insufficient-credits error with an actionable message", async () => {
	await assert.rejects(
		search(settings(), "402", { key: "k" }),
		(error) => {
			if (!(error instanceof SearloError) || error.kind !== "insufficient-credits" || error.status !== 402) return false;
			assert.match(error.message, /INSUFFICIENT_CREDITS/);
			assert.match(error.message, /top up/i, "the message points at the fix, not at a retry");
			assert.match(error.message, /\/searlo credits/, "the message names the balance command");
			return true;
		},
	);
});

test("creditBalance reads the documented balance shape", async () => {
	seen.length = 0;
	balanceMode = "ok";
	const balance = await creditBalance(settings(), "sk_test_1234567890");

	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "/api/v1/credit/balance");
	assert.equal(seen[0].headers["x-api-key"], "sk_test_1234567890");
	assert.equal(balance.available, 4200);
	assert.equal(balance.isLowBalance, false);
	assert.equal(balance.nextExpiryAt, "2026-12-31T00:00:00Z");
	assert.equal(balance.nextExpiryAmount, 500);
	assert.equal(balance.daysUntilNextExpiry, 170);
	assert.ok(balance.elapsedMs >= 0);
});

test("creditBalance tolerates a flat body without the data wrapper", async () => {
	balanceMode = "flat";
	const balance = await creditBalance(settings(), "k");
	assert.equal(balance.available, 7);
	assert.equal(balance.isLowBalance, true);
	balanceMode = "ok";
});

test("creditBalance maps 401 to auth and a non-JSON body to shape", async () => {
	balanceMode = "auth";
	await assert.rejects(
		creditBalance(settings(), "k"),
		(error) => error instanceof SearloError && error.kind === "auth" && error.status === 401,
	);
	balanceMode = "plain";
	await assert.rejects(creditBalance(settings(), "k"), (error) => error instanceof SearloError && error.kind === "shape");
	balanceMode = "ok";
});

test("creditBalance without a key fails before any request is sent", async () => {
	seen.length = 0;
	await assert.rejects(creditBalance(settings(), ""), (error) => error instanceof SearloError && error.kind === "no-key");
	assert.equal(seen.length, 0);
});

test("a 402 from the balance endpoint does not point back at /searlo credits", async () => {
	balanceMode = "402";
	await assert.rejects(
		creditBalance(settings(), "k"),
		(error) => {
			if (!(error instanceof SearloError) || error.kind !== "insufficient-credits" || error.status !== 402) return false;
			assert.match(error.message, /INSUFFICIENT_CREDITS/);
			assert.match(error.message, /top up/i, "the actionable part stays: this call failing is the news itself");
			assert.doesNotMatch(error.message, /\/searlo credits/, "the failing call already IS the credits check");
			return true;
		},
	);
	balanceMode = "ok";
});

test("classifies server errors, html bodies and broken json", async () => {
	const cases: [string, SearloError["kind"]][] = [
		["500", "http"],
		["html", "shape"],
		["badjson", "shape"],
	];
	for (const [query, kind] of cases) {
		await assert.rejects(
			search(settings(), query, { key: "k" }),
			(error) => error instanceof SearloError && error.kind === kind,
			`${query} should surface as ${kind}`,
		);
	}
});

test("an empty result set is a success, not an error", async () => {
	const response = await search(settings(), "empty", { key: "k" });
	assert.deepEqual(response.items, []);
	assert.equal(response.raw.total, 0);
});

test("toon on the wire only when the option is on", () => {
	assert.doesNotMatch(buildSearchUrl(settings(), "q"), /format=/, "default asks for JSON");
	assert.match(buildSearchUrl(settings({ toon: true }), "q"), /[?&]format=toon/);
	assert.match(
		buildSearchUrl(settings({ toon: true, params: { format: "enhanced" } }), "q"),
		/format=enhanced/,
		"an explicit params.format is what goes on the wire",
	);
	assert.doesNotMatch(buildSearchUrl(settings({ toon: true, params: { format: "enhanced" } }), "q"), /format=toon/);
});

test("a TOON body passes through exactly as it arrived", async () => {
	const response = await search(settings({ toon: true }), "toon", { key: "k" });

	assert.equal(response.toonText, TOON_BODY, "the text is not rewritten, re-indented or re-encoded");
	assert.equal(resultCount(response), 2, "the row count comes from the [N] header");
	assert.deepEqual(response.items, [], "nothing is decoded out of the text");
	assert.equal(response.account.creditsRemaining, 4999, "the credit headers still apply to a text body");
});

test("a text body is still a shape error while toon is off", async () => {
	await assert.rejects(
		search(settings(), "toon", { key: "k" }),
		(error) => error instanceof SearloError && error.kind === "shape",
	);
	// …and an HTML page is refused even when toon is on.
	await assert.rejects(
		search(settings({ toon: true }), "html", { key: "k" }),
		(error) => error instanceof SearloError && error.kind === "shape",
	);
});

test("text that only looks like TOON is still a shape error", async () => {
	for (const query of ["texterror", "toonfields"]) {
		await assert.rejects(
			search(settings({ toon: true }), query, { key: "k" }),
			(error) => error instanceof SearloError && error.kind === "shape",
			`${query} must not be served to the model as a result`,
		);
	}

	// …and the same bodies are refused with toon off, so the option never widens what is accepted.
	await assert.rejects(
		search(settings(), "texterror", { key: "k" }),
		(error) => error instanceof SearloError && error.kind === "shape",
	);
});

test("a JSON body with toon on still gives structured items to render from", async () => {
	const response = await search(settings({ toon: true }), "hello world", { key: "k" });
	assert.equal(response.toonText, undefined, "Searlo answers JSON today, so the TOON block is ours to render");
	assert.equal(response.items.length, 2);
	assert.match(seen.at(-1)!.url, /format=toon/);
});

test("missing key fails before any request is sent", async () => {
	seen.length = 0;
	await assert.rejects(
		search(settings(), "hello", { key: "" }),
		(error) => error instanceof SearloError && error.kind === "no-key",
	);
	assert.equal(seen.length, 0);
});

test("empty query fails before any request is sent", async () => {
	seen.length = 0;
	await assert.rejects(search(settings(), "   ", { key: "k" }), (error) => error instanceof SearloError);
	assert.equal(seen.length, 0);
});

test("times out a hanging request", async () => {
	await assert.rejects(
		search(settings({ timeoutMs: 500 }), "hang", { key: "k" }),
		(error) => error instanceof SearloError && error.kind === "timeout",
	);
});

test("an abort from the caller surfaces as abort, not as a searlo error", async () => {
	const controller = new AbortController();
	controller.abort("user cancelled");
	await assert.rejects(
		search(settings({ timeoutMs: 30000 }), "hang", { key: "k", signal: controller.signal }),
		(error) => !(error instanceof SearloError),
	);
});

test("unreachable host is a network error", async () => {
	await assert.rejects(
		search(settings({ baseUrl: "http://127.0.0.1:1" }), "hello", { key: "k" }),
		(error) => error instanceof SearloError && error.kind === "network",
	);
});
