# pi-script

**Pi Script** is an experimental Pi extension that toggles a TypeScript-native single-tool mode.

```txt
/script on   # expose only script_run to the model
/script off  # restore the previous active tool set
```

When enabled, the model calls one tool, `script_run`, and writes TypeScript against a global `pi` SDK. The SDK is generated from the currently registered Pi tools and delegates to their real tool definitions.

```ts
const msg = pi.session.latestUserMessage();
const readme = await pi.read({ path: "README.md" });
const test = await pi.bash({ command: "npm test", background: true });
pi.print("started", test.details?.jobId);
return { user: msg.text, test };
```

This first version is an MVP/prototype. It uses a Node VM/transpile runtime for local experimentation, not a hardened sandbox. The native core patch still wanted for production is a first-class `invokeTool` API that emits nested tool execution events and enforces hooks/permissions exactly like top-level calls.
