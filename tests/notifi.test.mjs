import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "notifi-test-"));
const originalEnv = { ...process.env };
const servers = new Set();
const jiti = createJiti(import.meta.url);
const extension = await jiti.import("../index.ts", { default: true });
const helper = fileURLToPath(new URL("../scripts/notifi-focus", import.meta.url));
const cache = join(root, "cache");
const targetsDir = join(cache, "notifi", "targets");
const home = join(root, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "notifi.json"), JSON.stringify({ defaults: { focusAware: false }, events: { aborted: { disabled: false } } }));

function cleanEnv() {
	const result = { ...originalEnv, HOME: home, XDG_CACHE_HOME: cache };
	for (const key of Object.keys(result)) {
		if (key === "TMUX" || key === "TMUX_PANE" || key.startsWith("SSH_") || key.startsWith("PI_NOTIFI_")) delete result[key];
	}
	return result;
}
function tmux(socket, ...args) {
	assert.ok(servers.has(socket), "Commands may only address disposable test servers");
	return execFileSync("tmux", ["-N", "-S", socket, ...args], { env: cleanEnv(), encoding: "utf8" }).trim();
}
function server(name, remote = false) {
	const socket = join(root, name);
	const environment = cleanEnv();
	if (remote) environment.SSH_CONNECTION = "test remote connection";
	execFileSync("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "test", "/bin/sh"], { env: environment });
	servers.add(socket);
	const pid = Number(tmux(socket, "display-message", "-p", "#{pid}"));
	const [sessionId, windowId, paneId] = tmux(socket, "display-message", "-p", "#{session_id}\t#{window_id}\t#{pane_id}").split("\t");
	return { socket, pid, sessionId, windowId, paneId };
}
function useServer(s) {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, cleanEnv(), { TMUX: `${s.socket},${s.pid},0`, TMUX_PANE: s.paneId });
}
function harness({ visible = false } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const deliveries = [];
	const ui = [];
	const api = {
		on: (name, fn) => handlers.set(name, fn),
		registerCommand: (name, value) => commands.set(name, value),
		appendEntry: () => {},
		exec: async (command, args) => {
			if (command === "bash") {
				// Never run notify-send or launch background notification waiters in tests.
				deliveries.push(args);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (command === "hyprctl") {
				if (!visible) return { code: 1, stdout: "", stderr: "no desktop", killed: false };
				const state = args[0] === "clients" ? [{ address: "0x123", pid: process.pid, workspace: { id: 1 } }] : [{ activeWorkspace: { id: 1 } }];
				return { code: 0, stdout: JSON.stringify(state), stderr: "", killed: false };
			}
			assert.equal(command, "tmux");
			assert.deepEqual(args.slice(0, 2), ["-N", "-S"]);
			assert.ok(servers.has(args[2]), "Extension must query only disposable servers");
			if (visible && args[3] === "list-clients") {
				return { code: 0, stdout: `${process.pid}\t/dev/test\t${local.sessionId}\t${local.windowId}\n`, stderr: "", killed: false };
			}
			try {
				return { code: 0, stdout: execFileSync(command, args, { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", killed: false };
			} catch (error) {
				return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), killed: false };
			}
		},
	};
	extension(api);
	const ctx = { cwd: root, hasUI: true, hasPendingMessages: () => false, ui: { notify: (message) => ui.push(message) } };
	return { deliveries, ui, end: (reason = "stop") => handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: reason }] }, ctx), command: (args) => commands.get("notifi").handler(args, ctx) };
}
function files() {
	return existsSync(targetsDir) ? readdirSync(targetsDir).sort() : [];
}

after(() => {
	// Never use a bare kill-server: this set contains only sockets we created.
	for (const socket of servers) {
		try { tmux(socket, "kill-server"); } catch {}
	}
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	rmSync(root, { recursive: true, force: true });
});

const local = server("local,with-comma");
const remote = server("remote", true);

test("auto permits local server despite stale SSH process variables, and saves server identity", async () => {
	useServer(local);
	process.env.SSH_CONNECTION = "stale inherited value";
	const h = harness();
	const before = new Set(files());
	await h.end();
	assert.equal(h.deliveries.length, 1);
	const created = files().filter((file) => !before.has(file));
	assert.equal(created.length, 1);
	const target = JSON.parse(readFileSync(join(targetsDir, created[0]), "utf8"));
	assert.equal(target.tmuxSocketPath, local.socket);
	assert.equal(target.tmuxServerPid, local.pid);
	assert.equal(target.tmuxPaneId, local.paneId);
});

test("auto suppresses SSH-created server for all events and test, even without process SSH variables", async () => {
	useServer(remote);
	const h = harness();
	const before = files();
	for (const reason of ["stop", "error", "aborted"]) await h.end(reason);
	await h.command("test");
	await h.command("status");
	assert.equal(h.deliveries.length, 0);
	assert.deepEqual(files(), before);
	assert.match(h.ui[0], /test not sent/);
	assert.match(h.ui[1], /desktop delivery blocked/);
});

test("server on/off overrides are dynamic and cannot be bypassed by /notifi on", async () => {
	useServer(local);
	tmux(local.socket, "set-option", "-s", "@notifi-desktop", "off");
	const h = harness();
	await h.command("on");
	await h.end("error");
	assert.equal(h.deliveries.length, 0);
	tmux(local.socket, "set-option", "-s", "@notifi-desktop", "on");
	await h.end("error");
	assert.equal(h.deliveries.length, 1);
	tmux(local.socket, "set-option", "-s", "@notifi-desktop", "invalid");
	await h.end("error");
	assert.equal(h.deliveries.length, 1);
	tmux(local.socket, "set-option", "-su", "@notifi-desktop");

	useServer(remote);
	tmux(remote.socket, "set-option", "-s", "@notifi-desktop", "on");
	const r = harness();
	await r.end("error");
	assert.equal(r.deliveries.length, 1);
	tmux(remote.socket, "set-option", "-s", "@notifi-desktop", "auto");
	await r.end("error");
	assert.equal(r.deliveries.length, 1);
});

test("local focus suppression and event/config disables still apply", async () => {
	useServer(local);
	const configPath = join(home, ".pi", "agent", "notifi.json");
	const config = readFileSync(configPath, "utf8");
	try {
		writeFileSync(configPath, "{}");
		const h = harness({ visible: true });
		await h.end();
		await h.end("aborted");
		assert.equal(h.deliveries.length, 0);
		await h.end("error");
		assert.equal(h.deliveries.length, 1, "Errors are not focus-aware by default");
		process.env.PI_NOTIFI_DISABLED = "1";
		await h.end("error");
		assert.equal(h.deliveries.length, 1);
		delete process.env.PI_NOTIFI_DISABLED;
		writeFileSync(configPath, JSON.stringify({ disabled: true }));
		await h.end("error");
		assert.equal(h.deliveries.length, 1);
	} finally {
		delete process.env.PI_NOTIFI_DISABLED;
		writeFileSync(configPath, config);
	}
});

test("unidentifiable or replaced originating server blocks notification delivery", async () => {
	const before = files();
	for (const value of ["invalid", `${local.socket},99999999,0`]) {
		useServer(local);
		process.env.TMUX = value;
		const h = harness();
		await h.end("error");
		assert.equal(h.deliveries.length, 0);
	}
	useServer(local);
	process.env.TMUX_PANE = "%999999";
	const h = harness();
	await h.end("error");
	assert.equal(h.deliveries.length, 0);
	assert.deepEqual(files(), before);
});

test("without tmux, local plain delivery is preserved but SSH delivery is blocked", async () => {
	useServer(local);
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	const h = harness();
	await h.end("error");
	assert.equal(h.deliveries.length, 1);
	for (const key of ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) {
		process.env[key] = "remote";
		await h.end("error");
		assert.equal(h.deliveries.length, 1);
		delete process.env[key];
	}
});

const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "ghostty"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOTIFI_TEST_GHOSTTY_LOG"\n', { mode: 0o755 });
writeFileSync(join(bin, "hyprctl"), '#!/bin/sh\nif [ -n "$NOTIFI_TEST_HYPR_LOG" ]; then printf "%s\\n" "$*" >> "$NOTIFI_TEST_HYPR_LOG"; fi\nif [ "$1" = clients ] && [ -n "$NOTIFI_TEST_HYPR_LOG" ]; then echo \'[{"address":"0x123"}]\'; else echo "[]"; fi\n', { mode: 0o755 });
function actionTarget(overrides = {}) {
	return { id: randomUUID(), tmuxSocketPath: local.socket, tmuxServerPid: local.pid, tmuxSessionId: local.sessionId, tmuxWindowId: local.windowId, tmuxPaneId: local.paneId, timestamp: Date.now(), ...overrides };
}
function focus(target, log, extraEnv = {}) {
	mkdirSync(targetsDir, { recursive: true });
	const path = join(targetsDir, `${target.id}.json`);
	writeFileSync(path, JSON.stringify(target));
	execFileSync("bash", [helper, target.id], { env: { ...cleanEnv(), TMUX: `${remote.socket},${remote.pid},0`, TMUX_PANE: remote.paneId, PATH: `${bin}:${originalEnv.PATH}`, NOTIFI_TEST_GHOSTTY_LOG: log, ...extraEnv } });
	assert.equal(existsSync(path), false);
}

test("Focus ignores inherited server and launches Ghostty with saved socket", async () => {
	assert.equal(local.sessionId, remote.sessionId, "IDs intentionally collide across servers");
	assert.equal(local.windowId, remote.windowId);
	for (const s of [local, remote]) tmux(s.socket, "new-window", "-t", s.sessionId, "/bin/sh");
	const remoteWindow = tmux(remote.socket, "display-message", "-p", "#{window_id}");
	const log = join(root, "ghostty.log");
	focus(actionTarget(), log);
	assert.equal(tmux(local.socket, "display-message", "-p", "#{window_id}"), local.windowId);
	assert.equal(tmux(remote.socket, "display-message", "-p", "#{window_id}"), remoteWindow);
	for (let i = 0; i < 100 && !existsSync(log); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["-e", "tmux", "-N", "-S", local.socket, "attach-session", "-t", local.sessionId]);
});

test("Focus reuses saved Hyprland window and falls back to saved window when pane/client is gone", () => {
	for (const s of [local, remote]) tmux(s.socket, "select-window", "-t", `${s.sessionId}:1`);
	const remoteWindow = tmux(remote.socket, "display-message", "-p", "#{window_id}");
	const hyprLog = join(root, "hypr.log");
	const ghosttyLog = join(root, "no-ghostty.log");
	focus(actionTarget({ workspaceId: 1, hyprWindowAddress: "0x123", tmuxClientTty: "/dev/missing", tmuxPaneId: "%999999" }), ghosttyLog, { NOTIFI_TEST_HYPR_LOG: hyprLog });
	assert.equal(tmux(local.socket, "display-message", "-p", "#{window_id}"), local.windowId);
	assert.equal(tmux(remote.socket, "display-message", "-p", "#{window_id}"), remoteWindow);
	assert.equal(existsSync(ghosttyLog), false);
	assert.match(readFileSync(hyprLog, "utf8"), /workspace = 1/);
	assert.match(readFileSync(hyprLog, "utf8"), /address:0x123/);
});

test("Focus fails closed for legacy, replaced, missing-server, and missing-session targets", () => {
	const beforeLocal = tmux(local.socket, "display-message", "-p", "#{window_id}");
	const beforeRemote = tmux(remote.socket, "display-message", "-p", "#{window_id}");
	const missing = join(root, "missing-socket");
	const legacy = actionTarget();
	delete legacy.tmuxSocketPath;
	delete legacy.tmuxServerPid;
	for (const [index, target] of [legacy, actionTarget({ tmuxServerPid: 99999999 }), actionTarget({ tmuxSocketPath: missing }), actionTarget({ tmuxSessionId: "$999999" })].entries()) {
		const log = join(root, `unexpected-${index}.log`);
		focus(target, log);
		assert.equal(existsSync(log), false);
	}
	assert.equal(existsSync(missing), false, "No replacement server/socket is created");
	assert.equal(tmux(local.socket, "display-message", "-p", "#{window_id}"), beforeLocal);
	assert.equal(tmux(remote.socket, "display-message", "-p", "#{window_id}"), beforeRemote);
});
