/**
 * Drives the extension factory with a stub ExtensionAPI: registration, mode handling,
 * auto injection, and the guarantee that the API key never reaches model-facing text.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import searloExtension from "../src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAYLOAD = JSON.stringify({
	success: true,
	searchInformation: { totalResults: "1250000", searchTime: 0.42, query: "q", currentPage: 1, hasNextPage: true },
	items: [{ rank: 1, title: "Fresh result", link: "https://a.test/1", snippet: "happened yesterday", domain: "a.test" }],
});

/** What an endpoint that honours `format=toon` answers: text, not JSON. Asked for with q=…toontext… */
const TOON_PAYLOAD = [
	"vertical: web",
	"query: toontext",
	"results[2]{rank,title,url,snippet}:",
	'  1,Alpha result,"https://a.test/1",alpha snippet',
	'  2,Beta result,"https://b.test/2",beta snippet',
].join("\n");

interface Stub {
	tools: any[];
	commands: Record<string, any>;
	handlers: Record<string, ((event: any, ctx: any) => any)[]>;
	active: string[];
	notifications: { message: string; type?: string }[];
	sentUserMessages: string[];
	/** Key bindings the extension asked for, in registration order. */
	shortcuts: { key: string; description?: string }[];
	/** Last status text per footer slot key. */
	status: Record<string, string | undefined>;
	/** Scripted answers for ctx.ui.select, consumed in order. */
	selectQueue: string[];
	selectTitles: string[];
	pi: ExtensionAPI;
	ctx: any;
}

function makeStub(): Stub {
	const stub: Stub = {
		tools: [],
		commands: {},
		handlers: {},
		active: ["read", "bash"],
		notifications: [],
		sentUserMessages: [],
		shortcuts: [],
		status: {},
		selectQueue: [],
		selectTitles: [],
		pi: undefined as unknown as ExtensionAPI,
		ctx: {},
	};

	const pi = {
		registerTool: (tool: any) => stub.tools.push(tool),
		registerCommand: (name: string, def: any) => {
			stub.commands[name] = def;
		},
		registerShortcut: (key: string, options: any) => {
			stub.shortcuts.push({ key, description: options?.description });
			stub.handlers[`shortcut:${key}`] ??= [];
			stub.handlers[`shortcut:${key}`].push(options.handler);
		},
		on: (event: string, handler: any) => {
			stub.handlers[event] ??= [];
			stub.handlers[event].push(handler);
		},
		getActiveTools: () => [...stub.active],
		setActiveTools: (names: string[]) => {
			stub.active = [...names];
		},
		sendUserMessage: async (content: string) => {
			stub.sentUserMessages.push(typeof content === "string" ? content : JSON.stringify(content));
		},
	} as unknown as ExtensionAPI;

	stub.pi = pi;
	stub.ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		signal: undefined,
		ui: {
			notify: (message: string, type?: string) => stub.notifications.push({ message, type }),
			input: async () => undefined,
			confirm: async () => true,
			select: async (title: string, _options: string[]) => {
				stub.selectTitles.push(title);
				return stub.selectQueue.shift();
			},
			setStatus: (key: string, text: string | undefined) => {
				stub.status[key] = text;
			},
		},
	};
	return stub;
}

async function fire(stub: Stub, event: string, payload: any, ctx: any = stub.ctx): Promise<any[]> {
	return Promise.all((stub.handlers[event] ?? []).map((handler) => handler(payload, ctx)));
}

let server: Server;
let baseUrl: string;
let agentDir: string;
let requests: string[] = [];

test.before(async () => {
	server = createServer((req, res) => {
		requests.push(req.url ?? "");
		const asked = new URL(req.url ?? "/", "http://mock").searchParams.get("q") ?? "";
		// One query word selects the text answer, so the JSON tests keep their payload.
		if (asked.includes("toontext")) {
			res.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"x-cache": "MISS",
				"x-credits-deducted": "1",
				"x-credits-remaining": "42",
			});
			res.end(TOON_PAYLOAD);
			return;
		}
		res.writeHead(200, {
			"content-type": "application/json",
			"x-cache": "MISS",
			"x-credits-deducted": "1",
			"x-credits-remaining": "42",
		});
		res.end(PAYLOAD);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Writes a fresh agent dir so the extension's own config load sees our mock endpoint. */
function useConfig(extra: Record<string, unknown> = {}) {
	requests = [];
	agentDir = mkdtempSync(join(tmpdir(), "pi-searlo-ext-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.SEARLO_API_KEY;
	writeFileSync(
		join(agentDir, "searlo.json"),
		JSON.stringify({ baseUrl, apiKey: "sk_wired_key_1234", timeoutMs: 4000, ...extra }),
	);
}

function cleanup() {
	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
}

test("binds the picker to f3 by default and to the configured key", () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		assert.deepEqual(stub.shortcuts.map((binding) => binding.key), ["f3"]);
		assert.match(stub.shortcuts[0].description ?? "", /mode and search type/);
	} finally {
		cleanup();
	}

	useConfig({ mode: "tool", shortcut: "ctrl+g" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		assert.deepEqual(stub.shortcuts.map((binding) => binding.key), ["ctrl+g"]);
	} finally {
		cleanup();
	}

	// An unusable binding must not stop the rest of the extension from loading.
	useConfig({ mode: "tool", shortcut: "not a key" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		assert.deepEqual(stub.shortcuts.map((binding) => binding.key), ["f3"], "falls back to the default binding");
		assert.ok(stub.tools.length > 0, "the tool still registers");
	} finally {
		cleanup();
	}
});

test("the bottom bar shows the search type only while searching is enabled", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		assert.equal(stub.status["searlo"], "Searlo: Web");

		await stub.commands["searlo"].handler("vertical images", stub.ctx);
		assert.equal(stub.status["searlo"], "Searlo: Image");

		await stub.commands["searlo"].handler("vertical videos", stub.ctx);
		assert.equal(stub.status["searlo"], "Searlo: Video");

		await stub.commands["searlo"].handler("off", stub.ctx);
		assert.equal(stub.status["searlo"], undefined, "off shows nothing");

		await stub.commands["searlo"].handler("auto", stub.ctx);
		assert.equal(stub.status["searlo"], "Searlo: Video", "auto shows the current type");
	} finally {
		cleanup();
	}
});

test("showStatus: false hides the bottom bar even when enabled", async () => {
	useConfig({ mode: "tool", showStatus: false });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		assert.equal(stub.status["searlo"], undefined);
		assert.deepEqual(stub.active, ["read", "bash", "searlo_search"], "hiding the label does not disable searching");
	} finally {
		cleanup();
	}
});

test("session_shutdown clears the status slot", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		assert.equal(stub.status["searlo"], "Searlo: Web");
		await fire(stub, "session_shutdown", { reason: "quit" });
		assert.equal(stub.status["searlo"], undefined);
	} finally {
		cleanup();
	}
});

test("the F3 picker marks the current choice and switches mode and search type", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const binding = stub.handlers["shortcut:f3"][0];
		stub.selectQueue = ["● Model decides (searches on demand)"];
		await binding(stub.ctx);
		assert.equal(stub.active.includes("searlo_search"), true, "re-picking the current mode changes nothing");

		stub.selectQueue = ["◆  Change search type…", "○ images"];
		await binding(stub.ctx);
		assert.equal(stub.status["searlo"], "Searlo: Image");
		assert.match(stub.selectTitles.at(-1) ?? "", /currently Web/);

		stub.selectQueue = ["○ Inject into every matching prompt"];
		await binding(stub.ctx);
		assert.equal(stub.status["searlo"], "Searlo: Image", "the search type survives a mode change");
		const injected = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});
		assert.ok(injected[0]?.message, "the picker choice actually turned injection on");
		assert.equal(stub.selectQueue.length, 0, "every scripted answer was consumed");
	} finally {
		cleanup();
	}
});

test("a cancelled picker changes nothing", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.handlers["shortcut:f3"][0](stub.ctx);
		assert.equal(stub.status["searlo"], "Searlo: Web");
		assert.deepEqual(stub.active, ["read", "bash", "searlo_search"]);
	} finally {
		cleanup();
	}
});

test("the picker explains itself when there is no UI to show it in", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		stub.ctx.hasUI = false;
		await stub.handlers["shortcut:f3"][0](stub.ctx);
		assert.match(stub.notifications.map((note) => note.message).join(" "), /interactive session/);
	} finally {
		cleanup();
	}
});

test("/searlo <vertical>: <query> sends one shot searches to that endpoint", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("images: sunset lamp", stub.ctx);
		assert.match(requests.at(-1) ?? "", /^\/api\/v1\/search\/images\?/);
		assert.match(stub.sentUserMessages.at(-1) ?? "", /vertical="images"/);

		await stub.commands["searlo"].handler("news: tech", stub.ctx);
		assert.match(requests.at(-1) ?? "", /^\/api\/v1\/search\/news\?/);

		// A query whose first word merely matches a vertical keeps that word: no silent truncation.
		requests = [];
		await stub.commands["searlo"].handler("web application security best practices", stub.ctx);
		assert.match(requests.at(-1) ?? "", /q=web\+application\+security/, "the word stays in the query");

		await stub.commands["searlo"].handler("test images: sunset", stub.ctx);
		assert.match(requests.at(-1) ?? "", /\/api\/v1\/search\/images\?/, "test honours a vertical prefix too");
	} finally {
		cleanup();
	}
});

test("the model can choose the vertical per search", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.tools[0].execute("tc1", { query: "wireless earbuds", vertical: "shopping", limit: 40 }, undefined, undefined, {
			cwd: process.cwd(),
		});
		assert.match(requests.at(-1) ?? "", /limit=40/, "shopping accepts more results than the other verticals");
		assert.match(requests.at(-1) ?? "", /^\/api\/v1\/search\/shopping\?/);
	} finally {
		cleanup();
	}
});

test("an unknown vertical from the model falls back to the configured one", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		await stub.tools[0].execute("tc1", { query: "sunset", vertical: "gifs" }, undefined, undefined, { cwd: process.cwd() });
		assert.match(requests.at(-1) ?? "", /^\/api\/v1\/search\/web\?/);
	} finally {
		cleanup();
	}
});

test("/searlo vertical <name> switches the default search type", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("vertical shopping", stub.ctx);
		await stub.commands["searlo"].handler("wireless earbuds", stub.ctx);
		assert.match(requests.at(-1) ?? "", /\/api\/v1\/search\/shopping\?/, "the session default moved");

		// A new session reads the file again, so the unsaved switch is gone.
		await fire(stub, "session_start", {});
		requests = [];
		await stub.commands["searlo"].handler("wireless earbuds", stub.ctx);
		assert.match(requests.at(-1) ?? "", /\/api\/v1\/search\/web\?/);

		await stub.commands["searlo"].handler("vertical nonsense", stub.ctx);
		assert.match(stub.notifications.at(-1)?.message ?? "", /usage: \/searlo vertical/);
	} finally {
		cleanup();
	}
});

test("/searlo vertical <name> --save persists the search type", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("vertical news --save", stub.ctx);
		const stored = JSON.parse(readFileSync(join(agentDir, "searlo.json"), "utf8")) as Record<string, unknown>;
		assert.equal(stored["vertical"], "news");
		assert.equal(stored["apiKey"], "sk_wired_key_1234", "saving the vertical keeps the key");

		requests = [];
		await fire(stub, "session_start", {});
		await stub.commands["searlo"].handler("tech", stub.ctx);
		assert.match(requests.at(-1) ?? "", /\/api\/v1\/search\/news\?/, "a later session uses the saved vertical");
	} finally {
		cleanup();
	}
});

test("registers the tool and the /searlo command on load", () => {
	useConfig();
	try {
		const stub = makeStub();
		searloExtension(stub.pi);

		assert.deepEqual(stub.tools.map((tool) => tool.name), ["searlo_search"]);
		assert.ok(stub.commands["searlo"], "command registered");
		assert.equal(stub.tools[0].defaultActive, false, "the tool must not activate itself by default");
		assert.equal(stub.tools[0].annotations.readOnlyHint, true);
		assert.equal(stub.tools[0].annotations.openWorldHint, true);
	} finally {
		cleanup();
	}
});

test("mode tool activates searlo_search at session start, manual does not", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		assert.deepEqual(stub.active, ["read", "bash", "searlo_search"]);
	} finally {
		cleanup();
	}

	useConfig({ mode: "manual" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		assert.deepEqual(stub.active, ["read", "bash"]);
	} finally {
		cleanup();
	}
});

test("the tool returns citable results and never leaks the key", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const result = await stub.tools[0].execute(
			"tc1",
			{ query: "what changed last week" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		const text = result.content[0].text;

		assert.match(text, /<searlo_results/);
		assert.match(text, /\[1\] Fresh result — https:\/\/a\.test\/1/);
		assert.match(text, /total_results="1250000"/);
		assert.doesNotMatch(text, /sk_wired_key_1234/, "the API key must not reach model-facing text");
		assert.equal(result.details.account.creditsRemaining, 42);
		assert.equal(result.details.count, 1);
	} finally {
		cleanup();
	}
});

test("auto mode injects a context message before the run only for time-sensitive prompts", async () => {
	useConfig({ mode: "auto" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const skip = await fire(stub, "before_agent_start", { messageType: "user", prompt: "refactor this function please" });
		assert.deepEqual(skip, [undefined], "a code task must not trigger a paid search");

		const hits = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});
		assert.equal(hits[0]?.message?.customType, "searlo:context");
		assert.match(hits[0].message.content, /<searlo_results/);
		assert.equal(hits[0].message.display, false);

		const guarded = await fire(stub, "before_agent_start", {
			messageType: "custom",
			prompt: "what is the latest release",
		});
		assert.deepEqual(guarded, [undefined], "an injected run must not re-trigger retrieval");
	} finally {
		cleanup();
	}
});

test("auto injection keeps a TOON text body instead of dropping it", async () => {
	useConfig({ mode: "auto", toon: true });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const injected = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest toontext release today",
		});

		// items is empty for a text body, so this used to look like "no results" and inject nothing.
		assert.equal(injected[0]?.message?.customType, "searlo:context", "the search happened, so it must be injected");
		assert.match(injected[0].message.content, /results\[2\]\{rank,title,url,snippet\}:/, "the endpoint's own TOON, verbatim");
		assert.equal(injected[0].message.details.count, 2, "the row count comes from the [N] header, not from items");
	} finally {
		cleanup();
	}
});

test("a failing search does not block the user's turn", async () => {
	useConfig({ mode: "auto", baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const result = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});
		assert.deepEqual(result, [undefined], "auto retrieval fails open");
		assert.match(stub.notifications.map((note) => note.message).join(" "), /searlo auto skipped/);
	} finally {
		cleanup();
	}
});

test("/searlo <query> injects results as a user message", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await stub.commands["searlo"].handler("latest searlo docs", stub.ctx);

		assert.equal(stub.sentUserMessages.length, 1);
		assert.match(stub.sentUserMessages[0], /<searlo_results/);
		assert.match(stub.sentUserMessages[0], /Question: latest searlo docs/);
		assert.doesNotMatch(stub.sentUserMessages[0], /sk_wired_key_1234/);
	} finally {
		cleanup();
	}
});

test("/searlo off withdraws the tool and /searlo on restores it", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("off", stub.ctx);
		assert.deepEqual(stub.active, ["read", "bash"]);

		await stub.commands["searlo"].handler("auto", stub.ctx);
		assert.deepEqual(stub.active, ["read", "bash", "searlo_search"]);
	} finally {
		cleanup();
	}
});

test("mode off refuses every search, including the ones asked for by hand", async () => {
	useConfig({ mode: "off" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		assert.deepEqual(stub.active, ["read", "bash"], "the model is left without the tool");
		assert.equal(stub.status["searlo"], undefined, "off shows nothing in the footer");

		await stub.commands["searlo"].handler("the latest release today", stub.ctx);
		await stub.commands["searlo"].handler("test the latest release", stub.ctx);
		await stub.commands["searlo"].handler("raw the latest release", stub.ctx);
		const injected = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});

		assert.deepEqual(injected, [undefined], "no per-prompt retrieval");
		assert.equal(stub.sentUserMessages.length, 0, "no search was injected as a turn");
		assert.deepEqual(requests, [], "off must not spend one single request");
		assert.match(stub.notifications.map((note) => note.message).join(" "), /searlo is off/);

		// Defence in depth: even a stale active-tool set cannot get a search through runSearch.
		await assert.rejects(
			() => stub.tools[0].execute("tc1", { query: "anything at all" }, undefined, undefined, { cwd: process.cwd() }),
			/searlo is off/,
		);
		assert.deepEqual(requests, [], "the tool path is refused before the network too");
	} finally {
		cleanup();
	}
});

test("/searlo off is absolute while /searlo manual still answers /searlo <query>", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("off", stub.ctx);
		await stub.commands["searlo"].handler("latest searlo docs", stub.ctx);
		assert.equal(stub.sentUserMessages.length, 0, "off refused the hand-run search");
		assert.deepEqual(requests, []);
		assert.match(stub.notifications.at(-1)!.message, /\/searlo manual\|on\|auto/, "the refusal says how to turn it back on");

		await stub.commands["searlo"].handler("manual", stub.ctx);
		assert.deepEqual(stub.active, ["read", "bash"], "manual still hides the tool");
		await stub.commands["searlo"].handler("latest searlo docs", stub.ctx);
		assert.equal(stub.sentUserMessages.length, 1, "manual answers explicit /searlo searches");
		assert.equal(requests.length, 1);
	} finally {
		cleanup();
	}
});

test("the picker can switch to Off and back to a searching mode", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		const binding = stub.handlers["shortcut:f3"][0];

		stub.selectQueue = ["○ Off (no Searlo searches)"];
		await binding(stub.ctx);
		assert.deepEqual(stub.active, ["read", "bash"]);

		await stub.commands["searlo"].handler("test the latest release", stub.ctx);
		assert.deepEqual(requests, [], "the picker's Off means no searches");

		stub.selectQueue = ["○ Manual (only /searlo searches)"];
		await binding(stub.ctx);
		await stub.commands["searlo"].handler("test the latest release", stub.ctx);
		assert.equal(requests.length, 1, "Manual searched again from the command");
	} finally {
		cleanup();
	}
});

test("a session mode toggle survives later /searlo commands", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("auto", stub.ctx);
		// /searlo test force-reloads the config; that used to silently reset the mode back to "tool".
		await stub.commands["searlo"].handler("test machine learning", stub.ctx);

		const injected = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});
		assert.ok(injected[0]?.message, "auto mode is still active after a forced config reload");
	} finally {
		cleanup();
	}
});

test("session_start resets a toggle left over from the previous session", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		await stub.commands["searlo"].handler("auto", stub.ctx);

		// Same session, new turn: still auto. Then a new session starts from the file again.
		await fire(stub, "session_start", {});
		const after = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});
		assert.deepEqual(after, [undefined], "the new session uses the configured mode");
		assert.deepEqual(stub.active, ["read", "bash", "searlo_search"], "tool mode is active, injection is not");
	} finally {
		cleanup();
	}
});

test("/searlo default writes the mode to the config file", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		await stub.commands["searlo"].handler("default auto", stub.ctx);

		const stored = JSON.parse(readFileSync(join(agentDir, "searlo.json"), "utf8")) as Record<string, unknown>;
		assert.equal(stored["mode"], "auto");
		assert.equal(stored["apiKey"], "sk_wired_key_1234", "saving the mode keeps the key");

		const notes = stub.notifications.map((note) => note.message).join(" ");
		assert.match(notes, /saved in/);
		assert.doesNotMatch(notes, /sk_wired_key_1234/);

		await stub.commands["searlo"].handler("default nonsense", stub.ctx);
		assert.match(stub.notifications.at(-1)!.message, /usage: \/searlo default/);

		await stub.commands["searlo"].handler("default off", stub.ctx);
		const persistedOff = JSON.parse(readFileSync(join(agentDir, "searlo.json"), "utf8")) as Record<string, unknown>;
		assert.equal(persistedOff["mode"], "off", "off is a persistable default");
	} finally {
		cleanup();
	}
});

test("one query costs one request per turn", async () => {
	useConfig({ mode: "auto" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const prompt = { messageType: "user", prompt: "what is the latest node lts release today" };
		await fire(stub, "before_agent_start", prompt);
		// The model then calls the tool for the same question: it must be served from cache.
		await stub.tools[0].execute("tc1", { query: prompt.prompt }, undefined, undefined, { cwd: process.cwd() });
		assert.equal(requests.length, 1, "the same search must not be paid for twice in one turn");

		await fire(stub, "agent_end", {});
		await stub.tools[0].execute("tc2", { query: prompt.prompt }, undefined, undefined, { cwd: process.cwd() });
		assert.equal(requests.length, 2, "a new turn may search again");
	} finally {
		cleanup();
	}
});

test("/searlo toon switches the model-facing block to a TOON table", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const asText = await stub.tools[0].execute("tc1", { query: "the latest release today" }, undefined, undefined, { cwd: process.cwd() });
		assert.match(asText.content[0].text, /<searlo_results/, "default rendering is the readable list");

		await stub.commands["searlo"].handler("toon on", stub.ctx);
		const asToon = await stub.tools[0].execute("tc2", { query: "the latest release today" }, undefined, undefined, { cwd: process.cwd() });
		assert.match(asToon.content[0].text, /\nresults\[1\]\{rank,title,url,snippet,source\}:$/m, "the toggle reaches the tool");
		assert.doesNotMatch(asToon.content[0].text, /<searlo_results/);
		assert.match(asToon.content[0].text, /Cite inline as \[n\]/, "the grounding rules survive the format change");
		assert.equal(asToon.details.count, 1, "the count comes from the parsed items");
		assert.doesNotMatch(asToon.content[0].text, /sk_wired_key_1234/, "the key stays out of the table too");

		// A different rendering is a different request (format=toon), so it must not hit the same cache slot.
		assert.equal(requests.length, 2, "text and toon are not the same cached search");
		assert.doesNotMatch(requests[0], /format=/, "the first call was made before the toggle");
		assert.match(requests[1], /format=toon/, "the request asks for toon once the option is on");

		assert.equal(stub.status["searlo"], "Searlo: Web · toon", "the footer says which rendering is live");

		await stub.commands["searlo"].handler("toon off", stub.ctx);
		const backToText = await stub.tools[0].execute("tc3", { query: "the latest release today" }, undefined, undefined, { cwd: process.cwd() });
		assert.match(backToText.content[0].text, /<searlo_results/);
	} finally {
		cleanup();
	}
});

test("searlo.json can turn TOON on by default, and /searlo toon --save persists it", async () => {
	useConfig({ mode: "tool", toon: true });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const first = await stub.tools[0].execute("tc1", { query: "the latest release today" }, undefined, undefined, { cwd: process.cwd() });
		assert.match(first.content[0].text, /\nresults\[1\]\{/, "the file default reaches the very first search");

		await stub.commands["searlo"].handler("toon off --save", stub.ctx);
		const stored = JSON.parse(readFileSync(join(agentDir, "searlo.json"), "utf8")) as Record<string, unknown>;
		assert.equal(stored["toon"], false, "--save writes the file");
		assert.equal(stored["apiKey"], "sk_wired_key_1234", "saving the format keeps the key");
		assert.match(stub.notifications.at(-1)!.message, /saved in/);
		assert.doesNotMatch(stub.notifications.map((note) => note.message).join(" "), /sk_wired_key_1234/);
	} finally {
		cleanup();
	}
});

test("/searlo config reports the output format and /searlo toon junk asks for usage", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		await stub.commands["searlo"].handler("config", stub.ctx);
		assert.match(stub.notifications.at(-1)!.message, /output: text \(text list\)/);

		await stub.commands["searlo"].handler("toon nonsense", stub.ctx);
		assert.match(stub.notifications.at(-1)!.message, /usage: \/searlo toon \[on\|off\]/);
	} finally {
		cleanup();
	}
});

test("auto injection and /searlo <query> both honour the format", async () => {
	useConfig({ mode: "auto" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		await stub.commands["searlo"].handler("toon", stub.ctx);

		const injected = await fire(stub, "before_agent_start", {
			messageType: "user",
			prompt: "what is the latest node lts release today",
		});
		assert.match(injected[0]?.message?.content ?? "", /\nresults\[1\]\{/, "the hidden context block is TOON too");

		await stub.commands["searlo"].handler("latest release notes", stub.ctx);
		assert.match(stub.sentUserMessages[0] ?? "", /\nresults\[1\]\{/, "/searlo <query> renders the same way");
	} finally {
		cleanup();
	}
});

test("the picker switches the output format without touching the mode", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});
		const binding = stub.handlers["shortcut:f3"][0];

		stub.selectQueue = ["◆  Change output format…", "○ TOON (header line, then one row per result)"];
		await binding(stub.ctx);
		assert.deepEqual(stub.active, ["read", "bash", "searlo_search"], "the mode is untouched");

		const result = await stub.tools[0].execute("tc1", { query: "the latest release today" }, undefined, undefined, { cwd: process.cwd() });
		assert.match(result.content[0].text, /\nresults\[1\]\{/, "the picker choice reaches the next search");

		const before = stub.notifications.length;
		stub.selectQueue = ["◆  Change output format…", "● TOON (header line, then one row per result)"];
		await binding(stub.ctx);
		assert.equal(stub.notifications.length, before, "re-picking the format you already have changes nothing");
		assert.match(stub.notifications.at(-1)!.message, /searlo output: toon \(this session\)/, "the first choice was confirmed truthfully");
	} finally {
		cleanup();
	}
});

test("/searlo login reads the key from the prompt, never from arguments", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		stub.ctx.ui.input = async () => "sk_pasted_key_9999";
		searloExtension(stub.pi);

		await stub.commands["searlo"].handler("login sk_should_be_ignored", stub.ctx);

		const path = join(agentDir, "searlo.json");
		const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.equal(stored["apiKey"], "sk_pasted_key_9999", "the prompted value is stored, not the argument");
		assert.equal(statSync(path).mode & 0o777, 0o600);

		const notes = stub.notifications.map((note) => note.message).join(" ");
		assert.match(notes, /key saved/);
		assert.doesNotMatch(notes, /sk_pasted_key_9999/, "status output must not echo the key");
		assert.doesNotMatch(notes, /sk_should_be_ignored/);
	} finally {
		cleanup();
	}
});

test("/searlo login with no prompt answer changes nothing", async () => {
	useConfig({ mode: "tool" });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await stub.commands["searlo"].handler("login", stub.ctx);

		const stored = JSON.parse(readFileSync(join(agentDir, "searlo.json"), "utf8")) as Record<string, unknown>;
		assert.equal(stored["apiKey"], "sk_wired_key_1234", "the existing key is untouched");
		assert.match(stub.notifications.map((note) => note.message).join(" "), /cancelled/);
	} finally {
		cleanup();
	}
});

test("missing key is reported once at session start and blocks no handler", async () => {
	useConfig({ apiKey: undefined });
	try {
		const stub = makeStub();
		searloExtension(stub.pi);
		await fire(stub, "session_start", {});

		const notes = stub.notifications.map((note) => note.message).join(" ");
		assert.match(notes, /Searlo API key is not configured/);
		assert.doesNotMatch(notes, /sk_wired_key_1234/);

		const result = await fire(stub, "before_agent_start", { messageType: "user", prompt: "the latest release today please" });
		assert.deepEqual(result, [undefined]);
	} finally {
		cleanup();
	}
});
