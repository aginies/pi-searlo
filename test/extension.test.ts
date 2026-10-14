/**
 * Drives the extension factory with a stub ExtensionAPI: registration, mode handling,
 * auto injection, and the guarantee that the API key never reaches model-facing text.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface Stub {
	tools: any[];
	commands: Record<string, any>;
	handlers: Record<string, ((event: any, ctx: any) => any)[]>;
	active: string[];
	notifications: { message: string; type?: string }[];
	sentUserMessages: string[];
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
		pi: undefined as unknown as ExtensionAPI,
		ctx: {},
	};

	const pi = {
		registerTool: (tool: any) => stub.tools.push(tool),
		registerCommand: (name: string, def: any) => {
			stub.commands[name] = def;
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
			select: async () => undefined,
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
let requests: string[];

test.before(async () => {
	server = createServer((_req, res) => {
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
