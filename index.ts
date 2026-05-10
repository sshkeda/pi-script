import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import ts from "typescript";
import { piContext, section, stringifyPayload, sanitizeText } from "pi-context";
import { createPiPending } from "pi-pending";
import { Text } from "@earendil-works/pi-tui";

const TOOL_NAME = "script_run";
const CUSTOM_TYPE = "pi_script_result";
const STATUS_ID = "pi-script";
const MAX_CONTEXT_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CALL_TEXT_CHARS = 240;
const MAX_ARG_SUMMARY_CHARS = 220;
const MAX_RENDER_LINES = 24;

function envEnablesPiScript(): boolean {
	return /^(1|true|yes|on)$/i.test(process.env.PI_SCRIPT ?? process.env.PI_SCRIPT_MODE ?? "");
}

type ScriptRunParams = {
	code: string;
	timeoutMs?: number;
};

type ScriptCall = {
	id: string;
	name: string;
	source?: string;
	args: unknown;
	ok: boolean;
	text?: string;
	error?: string;
	durationMs?: number;
};

type ScriptDetails = {
	id?: string;
	returnValue?: unknown;
	prints?: string[];
	logs?: string[];
	calls?: ScriptCall[];
	callCount?: number;
	failedCalls?: number;
	fullOutputPath?: string;
	truncation?: unknown;
	error?: string;
};

type ToolResult = {
	content: any[];
	details?: unknown;
	terminate?: boolean;
};

type ToolDefinitionLike = {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: ToolResult) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
};

type ToolInfoLike = {
	name: string;
	description?: string;
	parameters?: unknown;
	sourceInfo?: unknown;
};

type ScriptModeState = {
	enabled: boolean;
	previousActiveTools: string[] | undefined;
	lastTypes: string;
	runSeq: number;
};

const pending = createPiPending({
	namespace: "pi-script",
	format: (job) => job.text,
});

const state: ScriptModeState = {
	enabled: false,
	previousActiveTools: undefined,
	lastTypes: "",
	runSeq: 1,
};

function apiAny(pi: ExtensionAPI): any {
	return pi as any;
}

function withoutScriptTool(names: string[]): string[] {
	return names.filter((name) => name !== TOOL_NAME);
}

function setStatus(ctx: ExtensionContext | undefined) {
	// Keep Pi Script mode invisible in the footer/status line; command notifications
	// and /script status are enough, and the persistent footer is distracting.
	ctx?.ui.setStatus(STATUS_ID, undefined);
}

function getToolInfos(pi: ExtensionAPI): ToolInfoLike[] {
	return apiAny(pi).getAllTools().filter((tool: ToolInfoLike) => tool.name !== TOOL_NAME);
}

function getToolDefinition(pi: ExtensionAPI, ctx: ExtensionContext, name: string): ToolDefinitionLike | undefined {
	if (name === TOOL_NAME) return undefined;
	const direct = apiAny(pi).getToolDefinition?.(name) as (ToolDefinitionLike & { __piScriptResolveSource?: string }) | undefined;
	if (direct) {
		direct.__piScriptResolveSource = "native";
		return direct;
	}
	const registered = (apiAny(pi).getAllRegisteredTools?.() ?? []) as Array<{ definition: ToolDefinitionLike }>;
	const registeredMatch = registered.find((entry) => entry.definition?.name === name)?.definition as (ToolDefinitionLike & { __piScriptResolveSource?: string }) | undefined;
	if (registeredMatch) {
		registeredMatch.__piScriptResolveSource = "registered";
		return registeredMatch;
	}
	// Fallback for pi-mock/older Pi APIs that expose tool metadata but not definitions.
	// Production Pi Script should use ExtensionAPI.getToolDefinition so extension overrides
	// like pi-background-bash are delegated rather than reimplemented.
	const builtins: Record<string, () => ToolDefinitionLike> = {
		read: () => createReadToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
		write: () => createWriteToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
		edit: () => createEditToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
		bash: () => createBashToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
		grep: () => createGrepToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
		find: () => createFindToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
		ls: () => createLsToolDefinition(ctx.cwd) as unknown as ToolDefinitionLike,
	};
	const fallback = builtins[name]?.() as (ToolDefinitionLike & { __piScriptResolveSource?: string }) | undefined;
	if (fallback) fallback.__piScriptResolveSource = "builtin-fallback";
	return fallback;
}

function getMessageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part?.type === "text" && typeof part.text === "string") return part.text;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function branchMessages(ctx: ExtensionContext): any[] {
	return ctx.sessionManager
		.getBranch()
		.filter((entry: any) => entry.type === "message" && entry.message)
		.map((entry: any) => entry.message);
}

function latestUserMessage(ctx: ExtensionContext) {
	const messages = branchMessages(ctx);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user") {
			return {
				role: "user",
				text: getMessageText(message),
				content: message.content,
				timestamp: message.timestamp,
			};
		}
	}
	return { role: "user", text: "", content: [], timestamp: undefined };
}

function recentMessages(ctx: ExtensionContext, opts: { limit?: number } = {}) {
	const limit = opts.limit ?? 8;
	return branchMessages(ctx)
		.slice(-limit)
		.map((message) => ({
			role: message.role,
			text: getMessageText(message),
			content: message.content,
			toolName: message.toolName,
			isError: message.isError,
			timestamp: message.timestamp,
		}));
}

function isIdentifier(name: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function safeTypeName(name: string): string {
	const parts = name.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
	const raw = parts.map((part) => part[0]?.toUpperCase() + part.slice(1)).join("") || "Tool";
	return /^[A-Za-z_$]/.test(raw) ? raw : `Tool${raw}`;
}

function schemaToType(schema: any, depth = 0): string {
	if (!schema || depth > 4) return "unknown";
	if (schema.anyOf) return schema.anyOf.map((s: unknown) => schemaToType(s, depth + 1)).join(" | ");
	if (schema.oneOf) return schema.oneOf.map((s: unknown) => schemaToType(s, depth + 1)).join(" | ");
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") || "unknown";
	const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "array") return `${schemaToType(schema.items, depth + 1)}[]`;
	if (type === "object" || schema.properties) {
		const props = schema.properties ?? {};
		const required = new Set<string>(schema.required ?? []);
		const lines = Object.entries(props).map(([key, value]) => {
			const optional = required.has(key) ? "" : "?";
			const prop = isIdentifier(key) ? key : JSON.stringify(key);
			const desc = typeof (value as any)?.description === "string" ? `/** ${(value as any).description.replace(/\*\//g, "*\\/")} */\n  ` : "";
			return `  ${desc}${prop}${optional}: ${schemaToType(value, depth + 1)};`;
		});
		return lines.length ? `{\n${lines.join("\n")}\n}` : "Record<string, unknown>";
	}
	return "unknown";
}

function generateTypes(pi: ExtensionAPI): string {
	const tools = getToolInfos(pi);
	const typeDecls: string[] = [];
	const convenience: string[] = [];
	for (const tool of tools) {
		const typeName = `${safeTypeName(tool.name)}Args`;
		typeDecls.push(`type ${typeName} = ${schemaToType(tool.parameters)};`);
		if (isIdentifier(tool.name)) {
			const desc = tool.description ? `/** ${tool.description.replace(/\*\//g, "*\\/")} */\n  ` : "";
			convenience.push(`${desc}${tool.name}(args: ${typeName}): Promise<PiToolResult>;`);
		}
	}
	return `// Pi Script SDK generated from currently registered Pi tools.\n${typeDecls.join("\n\n")}\n\ntype PiTextPart = { type: "text"; text: string };\ntype PiToolResult = { content: Array<PiTextPart | Record<string, unknown>>; details?: unknown; terminate?: boolean };\ntype PiMessage = { role: string; text: string; content?: unknown; toolName?: string; isError?: boolean; timestamp?: number };\n\ndeclare const pi: {\n  session: {\n    cwd(): string;\n    latestUserMessage(): PiMessage;\n    recentMessages(opts?: { limit?: number }): PiMessage[];\n  };\n  tools: {\n    call(name: string, args?: unknown): Promise<PiToolResult>;\n    list(): Array<{ name: string; description?: string }>;\n  };\n  ${convenience.join("\n  ")}\n  print(...values: unknown[]): void;\n  log(...values: unknown[]): void;\n  /** Import a local/helper module from the host Pi process. Relative paths resolve from the session cwd. Prefer compiled .js modules. */\n  importModule<T = unknown>(specifier: string): Promise<T>;\n  sleep(ms: number): Promise<void>;\n  parallel<T>(tasks: Array<() => Promise<T>>, opts?: { concurrency?: number }): Promise<T[]>;\n};\n`;
}

function localModuleUrl(ctx: ExtensionContext, specifier: string): string {
	const trimmed = specifier.trim();
	if (!trimmed) throw new Error("module specifier is required");
	if (/^(?:node:|data:|file:|https?:)/.test(trimmed)) return trimmed;
	return pathToFileURL(path.resolve(ctx.cwd, trimmed)).href;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function makeJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function" || typeof value === "symbol") return String(value);
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		if (Array.isArray(value)) return value.map((item) => makeJsonSafe(item, seen));
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = makeJsonSafe(child, seen);
		return out;
	}
	return String(value);
}

function resultText(result: ToolResult): string {
	return (result.content ?? [])
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			return formatValue(part);
		})
		.join("\n");
}

function oneLine(value: unknown, maxChars = MAX_ARG_SUMMARY_CHARS): string {
	const raw = formatValue(value).replace(/\s+/g, " ").trim();
	return raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 1))}…` : raw;
}

function firstLine(text: string, maxChars = MAX_CALL_TEXT_CHARS): string {
	const raw = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
	return raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 1))}…` : raw;
}

function formatCallSummary(call: ScriptCall): string {
	const icon = call.ok ? "✓" : "✗";
	const elapsed = call.durationMs === undefined ? "" : ` ${call.durationMs}ms`;
	const source = call.source && call.source !== "native" ? ` [${call.source}]` : "";
	const suffix = call.ok ? firstLine(call.text ?? "") : firstLine(call.error ?? "error");
	return `${icon} ${call.name}${elapsed}${source} ${oneLine(call.args)}${suffix ? ` → ${suffix}` : ""}`;
}

function compactScriptContext(id: string, prints: string[], safeReturn: unknown, calls: ScriptCall[]): string {
	const printed = prints.length ? prints.join("\n") : "(none)";
	const callSummary = calls.length ? calls.map(formatCallSummary).join("\n") : "(none)";
	return piContext({
		source: "pi-script",
		kind: "script_result",
		id,
		children: [
			section("summary", `${calls.filter((call) => call.ok).length}/${calls.length} tool calls succeeded`),
			section("prints", printed),
			section("return", stringifyPayload(safeReturn)),
			section("calls", callSummary),
		],
	});
}

async function truncateScriptContext(body: string, id: string): Promise<{ text: string; details: Pick<ScriptDetails, "truncation" | "fullOutputPath"> }> {
	const truncation = truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text: truncation.content, details: {} };
	const dir = await mkdtemp(path.join(tmpdir(), "pi-script-"));
	const fullOutputPath = path.join(dir, `${id}.txt`);
	await writeFile(fullOutputPath, body, "utf8");
	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	const notice = `\n\n[Pi Script output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full output saved to: ${fullOutputPath}]`;
	return { text: `${truncation.content}${notice}`, details: { truncation, fullOutputPath } };
}

function compileScript(code: string): string {
	if (/^\s*import\s/m.test(code) || /^\s*export\s/m.test(code)) {
		throw new Error("Pi Script does not support import/export in the MVP runtime. Use the global pi SDK only.");
	}
	const wrapped = `async function __piScriptMain(pi) {\n${code}\n}\n__piScriptMain;`;
	const compiled = ts.transpileModule(wrapped, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			strict: true,
		},
		reportDiagnostics: true,
	});
	const diagnostics = compiled.diagnostics ?? [];
	const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) {
		const formatted = errors
			.map((d) => {
				const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
				if (d.file && typeof d.start === "number") {
					const pos = d.file.getLineAndCharacterOfPosition(d.start);
					return `Line ${Math.max(1, pos.line)}:${pos.character + 1} TS${d.code}: ${msg}`;
				}
				return `TS${d.code}: ${msg}`;
			})
			.join("\n");
		throw new Error(formatted);
	}
	return compiled.outputText;
}

async function mapLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
	const limit = Math.max(1, Math.floor(concurrency || tasks.length || 1));
	const results: T[] = new Array(tasks.length);
	let next = 0;
	async function worker() {
		for (;;) {
			const index = next++;
			if (index >= tasks.length) return;
			results[index] = await tasks[index]();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
	return results;
}

function makeScriptPi(pi: ExtensionAPI, ctx: ExtensionContext, parentToolCallId: string, onUpdate: ((update: ToolResult) => void) | undefined) {
	let childSeq = 1;
	const prints: string[] = [];
	const logs: string[] = [];
	const calls: ScriptCall[] = [];

	async function callTool(name: string, args: unknown = {}): Promise<ToolResult> {
		const childId = `${parentToolCallId}.${childSeq++}.${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
		const startedAt = Date.now();
		const nativeInvoke = (ctx as any).invokeTool as ((name: string, args?: unknown, options?: Record<string, unknown>) => Promise<ToolResult & { isError?: boolean; toolCallId?: string }>) | undefined;
		if (typeof nativeInvoke === "function") {
			const call: ScriptCall = { id: childId, name, source: "native", args: makeJsonSafe(args), ok: false };
			calls.push(call);
			try {
				const result = await nativeInvoke(name, args, {
					parentToolCallId,
					toolCallId: childId,
					includeMetadata: true,
					throwOnError: true,
				});
				call.ok = !result.isError;
				call.durationMs = Date.now() - startedAt;
				call.text = resultText(result).slice(0, MAX_CALL_TEXT_CHARS);
				return result;
			} catch (error) {
				call.ok = false;
				call.durationMs = Date.now() - startedAt;
				call.error = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}

		const definition = getToolDefinition(pi, ctx, name);
		if (!definition) {
			const configured = typeof apiAny(pi).getAllTools === "function" ? apiAny(pi).getAllTools().map((tool: ToolInfoLike) => tool.name).join(",") : "<no getAllTools>";
			const registered = typeof apiAny(pi).getAllRegisteredTools === "function" ? apiAny(pi).getAllRegisteredTools().map((entry: any) => entry.definition?.name ?? entry.name).join(",") : "<no getAllRegisteredTools>";
			throw new Error(`Tool ${name} is not registered or cannot be invoked from Pi Script. configured=[${configured}] registered=[${registered}] hasGetToolDefinition=${typeof apiAny(pi).getToolDefinition}`);
		}
		const preparedArgs = definition.prepareArguments ? definition.prepareArguments(args) : args;
		const call: ScriptCall = { id: childId, name, source: (definition as any).__piScriptResolveSource, args: makeJsonSafe(preparedArgs), ok: false };
		calls.push(call);
		onUpdate?.({ content: [{ type: "text", text: `↳ ${name} ${oneLine(preparedArgs)}` }], details: { childId, name, args: preparedArgs } });
		try {
			const result = await definition.execute(childId, preparedArgs, ctx.signal, (update) => {
				onUpdate?.({
					content: [{ type: "text", text: `↳ ${name} update\n${resultText(update).slice(0, 1000)}` }],
					details: { childId, name, update: makeJsonSafe(update) },
				});
			}, ctx);
			call.ok = true;
			call.durationMs = Date.now() - startedAt;
			call.text = resultText(result).slice(0, MAX_CALL_TEXT_CHARS);
			return result;
		} catch (error) {
			call.ok = false;
			call.durationMs = Date.now() - startedAt;
			call.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	const toolList = () => getToolInfos(pi).map((tool) => ({ name: tool.name, description: tool.description }));
	const scriptPi: any = {
		session: {
			cwd: () => ctx.cwd,
			latestUserMessage: () => latestUserMessage(ctx),
			recentMessages: (opts?: { limit?: number }) => recentMessages(ctx, opts),
		},
		tools: {
			call: callTool,
			list: toolList,
		},
		print: (...values: unknown[]) => {
			const line = values.map(formatValue).join(" ");
			prints.push(line);
			onUpdate?.({ content: [{ type: "text", text: line }], details: { print: line } });
		},
		log: (...values: unknown[]) => logs.push(values.map(formatValue).join(" ")),
		importModule: async (specifier: string) => import(localModuleUrl(ctx, specifier)),
		sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
		parallel: <T>(tasks: Array<() => Promise<T>>, opts?: { concurrency?: number }) => mapLimit(tasks, opts?.concurrency ?? tasks.length),
	};
	for (const tool of getToolInfos(pi)) {
		if (isIdentifier(tool.name) && !scriptPi[tool.name]) {
			scriptPi[tool.name] = (args: unknown = {}) => callTool(tool.name, args);
		}
	}
	return { scriptPi, prints, logs, calls };
}

async function executeScript(pi: ExtensionAPI, ctx: ExtensionContext, toolCallId: string, params: ScriptRunParams, onUpdate: ((update: ToolResult) => void) | undefined): Promise<ToolResult> {
	const id = `script_${state.runSeq++}`;
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	pending.start({ id, text: `running ${params.code.split(/\r?\n/).length} line script`, details: { toolCallId } });
	try {
		const compiled = compileScript(params.code);
		const { scriptPi, prints, logs, calls } = makeScriptPi(pi, ctx, toolCallId, onUpdate);
		const context = vm.createContext({
			console: {
				log: (...values: unknown[]) => scriptPi.log(...values),
				warn: (...values: unknown[]) => scriptPi.log("WARN", ...values),
				error: (...values: unknown[]) => scriptPi.log("ERROR", ...values),
			},
			setTimeout,
			clearTimeout,
		});
		const fn = new vm.Script(compiled, { filename: "pi-script.ts" }).runInContext(context, { timeout: Math.min(timeoutMs, 5_000) });
		if (typeof fn !== "function") throw new Error("Compiled Pi Script did not produce an executable function.");
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error(`Pi Script timed out after ${timeoutMs}ms`)), timeoutMs);
			timeout.unref?.();
		});
		const returnValue = await Promise.race([Promise.resolve(fn(scriptPi)), timeoutPromise]);
		if (timeout) clearTimeout(timeout);
		const safeReturn = makeJsonSafe(returnValue);
		const body = compactScriptContext(id, prints, safeReturn, calls);
		const truncated = await truncateScriptContext(body, id);
		const failedCalls = calls.filter((call) => !call.ok).length;
		return {
			content: [{ type: "text", text: truncated.text }],
			details: { id, returnValue: safeReturn, prints, logs, calls, callCount: calls.length, failedCalls, ...truncated.details } satisfies ScriptDetails,
		};
	} finally {
		pending.finish(id);
	}
}

export default function piScriptExtension(pi: ExtensionAPI) {
	// pi-mock synthetic invocation hook for deterministic extension tests.
	apiAny(pi).events?.emit?.("_mock:register_invocation", {
		name: TOOL_NAME,
		fn: (params: ScriptRunParams, ctx: ExtensionContext) => executeScript(pi, ctx, `mock_${Date.now()}`, params, undefined),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) pending.attach(ctx.ui);
		if (envEnablesPiScript()) {
			if (!state.enabled) state.previousActiveTools = withoutScriptTool(apiAny(pi).getActiveTools());
			state.enabled = true;
		}
		setStatus(ctx);
		state.lastTypes = generateTypes(pi);
		if (state.enabled) {
			apiAny(pi).setActiveTools([TOOL_NAME]);
		} else {
			const active = withoutScriptTool(apiAny(pi).getActiveTools());
			if (active.length !== apiAny(pi).getActiveTools().length) apiAny(pi).setActiveTools(active);
		}
	});

	pi.on("session_shutdown", async () => {
		pending.detach();
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!state.enabled) return;
		state.lastTypes = generateTypes(pi);
		const typeText = sanitizeText(state.lastTypes, { maxChars: MAX_CONTEXT_CHARS }).text;
		return {
			systemPrompt: `${_event.systemPrompt}\n\nPi Script mode is enabled. You have exactly one model-visible tool: ${TOOL_NAME}. Use ${TOOL_NAME} for every action. Inside ${TOOL_NAME}, write TypeScript using the global pi SDK. Do not ask for or assume direct tools; direct Pi tools are available through pi.<toolName>(args) and pi.tools.call(name, args). Top-level await is supported by writing normal await statements in the script body. Return a small JSON-serializable value and use pi.print() for model-visible progress. Long-running bash should use the bash tool's background:true option when appropriate.\n\n${typeText}`,
		};
	});

	pi.registerCommand("script", {
		description: "Toggle Pi Script single-tool TypeScript mode: /script on|off|status|types|tools",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "on", label: "on", description: "Enable Pi Script single-tool mode" },
				{ value: "off", label: "off", description: "Disable Pi Script and restore normal tools" },
				{ value: "status", label: "status", description: "Show Pi Script mode status" },
				{ value: "types", label: "types", description: "Show generated Pi Script SDK types" },
				{ value: "tools", label: "tools", description: "List tools callable from Pi Script" },
			];
			const normalizedPrefix = prefix.trimStart();
			const filtered = options.filter((option) => option.value.startsWith(normalizedPrefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim() || "status";
			if (arg === "on") {
				if (!state.enabled) state.previousActiveTools = withoutScriptTool(apiAny(pi).getActiveTools());
				state.enabled = true;
				state.lastTypes = generateTypes(pi);
				apiAny(pi).setActiveTools([TOOL_NAME]);
				setStatus(ctx);
				ctx.ui.notify("Pi Script mode on: model now sees only script_run.", "info");
				return;
			}
			if (arg === "off") {
				state.enabled = false;
				const restore = state.previousActiveTools?.length ? state.previousActiveTools : withoutScriptTool(apiAny(pi).getAllTools().map((tool: ToolInfoLike) => tool.name));
				apiAny(pi).setActiveTools(withoutScriptTool(restore));
				setStatus(ctx);
				ctx.ui.notify("Pi Script mode off: restored normal tools.", "info");
				return;
			}
			if (arg === "types") {
				state.lastTypes = generateTypes(pi);
				ctx.ui.notify(state.lastTypes, "info");
				return;
			}
			if (arg === "tools") {
				ctx.ui.notify(getToolInfos(pi).map((tool) => `- ${tool.name}`).join("\n"), "info");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Pi Script mode is ${state.enabled ? "on" : "off"}. Active tools: ${apiAny(pi).getActiveTools().join(", ")}`, "info");
				setStatus(ctx);
				return;
			}
			ctx.ui.notify("Usage: /script on|off|status|types|tools", "error");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Pi Script",
		description: "Execute a Pi Script: sandbox-ish TypeScript that uses the global pi SDK to call Pi tools, inspect read-only session context, print progress, and return structured results. Use this for all actions when /script on is active.",
		promptSnippet: "Run TypeScript against the Pi Script SDK to call Pi tools and session context through a single native tool.",
		promptGuidelines: [
			"Use script_run for every action when Pi Script mode is enabled; call tools inside the script via pi.<toolName>(args) or pi.tools.call(name, args).",
			"Keep Pi Scripts small, await blocking tools, and use background:true for long-running bash commands that should wake the session later.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "TypeScript script body. Use the global pi object; top-level await works as normal await in the body. Do not use import/export." }),
			timeoutMs: Type.Optional(Type.Number({ description: "Maximum script runtime in milliseconds. Default 60000." })),
		}),
		renderCall(args, theme) {
			const lines = String(args.code ?? "").split(/\r?\n/).length;
			let text = theme.fg("toolTitle", theme.bold("Pi Script "));
			text += theme.fg("accent", `${lines} line${lines === 1 ? "" : "s"}`);
			if (args.timeoutMs) text += theme.fg("dim", ` timeout=${args.timeoutMs}ms`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ScriptDetails | undefined;
			if (isPartial) {
				const text = resultText(result as ToolResult) || "running";
				return new Text(theme.fg("warning", firstLine(text, 120)), 0, 0);
			}
			if (details?.error) return new Text(theme.fg("error", `Pi Script failed: ${details.error}`), 0, 0);
			const callCount = details?.callCount ?? details?.calls?.length ?? 0;
			const failed = details?.failedCalls ?? details?.calls?.filter((call) => !call.ok).length ?? 0;
			let text = failed > 0 ? theme.fg("error", `Pi Script: ${failed}/${callCount} calls failed`) : theme.fg("success", `Pi Script: ${callCount} call${callCount === 1 ? "" : "s"}`);
			if (details?.prints?.length) text += theme.fg("dim", `, ${details.prints.length} print${details.prints.length === 1 ? "" : "s"}`);
			if (details?.truncation) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				for (const call of details?.calls ?? []) text += `\n${theme.fg(call.ok ? "dim" : "error", formatCallSummary(call))}`;
				const content = result.content?.[0];
				if (content?.type === "text") {
					const lines = content.text.split(/\r?\n/).slice(0, MAX_RENDER_LINES);
					if (lines.length) text += `\n${theme.fg("muted", lines.join("\n"))}`;
				}
				if (details?.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<any> {
			if (!state.enabled) {
				return {
					content: [{ type: "text", text: "Pi Script mode is off. Ask the user to run /script on, or use normal tools if available." }],
					details: { enabled: false },
				};
			}
			if (signal?.aborted) throw new Error("Pi Script aborted");
			return executeScript(pi, ctx, toolCallId, params as ScriptRunParams, onUpdate as any);
		},
	});
}
