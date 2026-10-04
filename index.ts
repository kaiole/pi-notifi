import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type NotifiState = {
	enabled: boolean;
};

type TaskStatus = "finished" | "error" | "aborted";

type NotifiEventConfig = {
	disabled?: boolean;
	focusAware?: boolean;
	title?: string;
	body?: string;
	urgency?: string;
	expireTime?: string;
};

type NotifiConfig = Required<NotifiEventConfig>;

type NotifiFileConfig = Partial<{
	disabled: boolean;
	defaults: NotifiFileEventConfig;
	events: Partial<Record<TaskStatus, NotifiFileEventConfig>>;
}>;

type NotifiFileEventConfig = Partial<{
	disabled: boolean;
	focusAware: boolean;
	title: string;
	body: string;
	urgency: string;
	expireTime: string | number;
}>;

type TmuxLocation = {
	socketPath: string;
	serverPid: number;
	sessionId: string;
	windowId: string;
	paneId: string;
	sessionName?: string;
	windowIndex?: string;
};

type TmuxClient = {
	pid: number;
	tty?: string;
	sessionId: string;
	windowId: string;
};

type HyprClient = {
	address?: string;
	pid?: number;
	mapped?: boolean;
	hidden?: boolean;
	visible?: boolean;
	workspace?: {
		id?: number;
	};
};

type NotifiTarget = {
	id: string;
	workspaceId?: number;
	hyprWindowAddress?: string;
	tmuxSocketPath: string;
	tmuxServerPid: number;
	tmuxSessionId: string;
	tmuxWindowId: string;
	tmuxPaneId: string;
	tmuxClientTty?: string;
	timestamp: number;
};

type HyprMonitor = {
	activeWorkspace?: {
		id?: number;
	};
	specialWorkspace?: {
		id?: number;
	};
};

const truthy = (value: string | undefined): boolean => {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const env = (name: string): string | undefined => {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value : undefined;
};

const packageRoot = dirname(fileURLToPath(import.meta.url));
const focusScriptPath = join(packageRoot, "scripts", "notifi-focus");

const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

const cacheHome = (): string => process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "/tmp", ".cache");

const targetFile = (targetId: string): string => join(cacheHome(), "notifi", "targets", `${targetId}.json`);

const readConfigFile = async (cwd: string): Promise<NotifiFileConfig> => {
	const home = process.env.HOME ?? "";
	const paths = [
		join(cwd, ".pi", "notifi.json"),
		join(home, ".pi", "agent", "notifi.json"),
		join(home, ".pi", "agent", "extensions", "notifi.json"),
	];

	for (const path of paths) {
		if (!path || !(await fileExists(path))) continue;

		try {
			const raw = await readFile(path, "utf8");
			return JSON.parse(raw) as NotifiFileConfig;
		} catch {
			continue;
		}
	}

	return {};
};

const configString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) return value;
	if (typeof value === "number") return String(value);
	return undefined;
};

const configBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

const statusBody = (status: TaskStatus): string => {
	if (status === "finished") return "Task Finished";
	if (status === "aborted") return "Task Aborted";
	return "Task Failed";
};

// TMUX ends with ,server-pid,session-id; socket paths may themselves contain commas.
const tmuxServer = (): Pick<TmuxLocation, "socketPath" | "serverPid"> | undefined => {
	const value = process.env.TMUX;
	if (!value) return undefined;
	const parts = value.split(",");
	if (parts.length < 3) return undefined;
	const socketPath = parts.slice(0, -2).join(",");
	const serverPid = Number(parts.at(-2));
	if (!socketPath.startsWith("/") || !Number.isInteger(serverPid) || serverPid <= 0) return undefined;
	return { socketPath, serverPid };
};

const execTmux = (pi: ExtensionAPI, args: string[], timeout = 2000) => {
	const server = tmuxServer();
	if (!server) throw new Error("Cannot identify the originating tmux server");
	// -N prevents a missing socket from starting a replacement server.
	return pi.exec("tmux", ["-N", "-S", server.socketPath, ...args], { timeout });
};

const desktopNotificationsAllowed = async (pi: ExtensionAPI): Promise<boolean> => {
	if (!process.env.TMUX) {
		return !env("SSH_CONNECTION") && !env("SSH_TTY") && !env("SSH_CLIENT");
	}

	try {
		const server = tmuxServer();
		if (!server) return false;
		const identity = await execTmux(pi, ["display-message", "-p", "#{pid}"]);
		if (identity.code !== 0 || Number(identity.stdout.trim()) !== server.serverPid) return false;
		const option = await execTmux(pi, ["show-options", "-sqv", "@notifi-desktop"]);
		if (option.code !== 0) return false;
		const mode = option.stdout.trim().toLowerCase() || "auto";
		if (mode === "on") return true;
		if (mode !== "auto") return false; // off, or an invalid policy: fail closed.

		// Use server-global provenance, not the pi process/session environment,
		// which can inherit stale SSH variables after a client reattaches.
		const environment = await execTmux(pi, ["show-environment", "-g"]);
		return environment.code === 0 && !/^SSH_(?:CONNECTION|TTY|CLIENT)=.+$/m.test(environment.stdout);
	} catch {
		return false;
	}
};

const getTmuxSessionTitle = async (pi: ExtensionAPI): Promise<string | undefined> => {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return undefined;

	try {
		const result = await execTmux(pi, ["display-message", "-p", "-t", pane, "#S:#{window_index}"]);
		const title = result.stdout.trim();
		return title || undefined;
	} catch {
		return undefined;
	}
};

const normalizeEventConfig = (config: NotifiFileEventConfig | undefined): NotifiEventConfig => ({
	disabled: configBoolean(config?.disabled),
	focusAware: configBoolean(config?.focusAware),
	title: configString(config?.title),
	body: configString(config?.body),
	urgency: configString(config?.urgency),
	expireTime: configString(config?.expireTime),
});

const mergeEventConfig = (...configs: NotifiEventConfig[]): NotifiEventConfig =>
	configs.reduce<NotifiEventConfig>((merged, config) => ({ ...merged, ...withoutUndefined(config) }), {});

const withoutUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> =>
	Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;

const builtInEventConfig = (status: TaskStatus, title: string): NotifiConfig => ({
	disabled: status === "aborted",
	focusAware: status === "finished",
	title,
	body: statusBody(status),
	urgency: status === "error" ? "critical" : "normal",
	expireTime: "0",
});

const getConfig = async (pi: ExtensionAPI, ctx: ExtensionContext, status: TaskStatus): Promise<NotifiConfig> => {
	const [tmuxTitle, fileConfig] = await Promise.all([getTmuxSessionTitle(pi), readConfigFile(ctx.cwd)]);
	const title = tmuxTitle ?? "pi";
	const config = mergeEventConfig(
		builtInEventConfig(status, title),
		normalizeEventConfig(fileConfig.defaults),
		normalizeEventConfig(fileConfig.events?.[status]),
		{
			title: env("PI_NOTIFI_TITLE"),
			body: env("PI_NOTIFI_BODY"),
			urgency: env("PI_NOTIFI_URGENCY"),
			expireTime: env("PI_NOTIFI_EXPIRE_TIME"),
		},
	) as NotifiConfig;

	return {
		...config,
		disabled: truthy(process.env.PI_NOTIFI_DISABLED) || configBoolean(fileConfig.disabled) === true || config.disabled,
	};
};

const parseJsonArray = <T>(text: string): T[] | undefined => {
	try {
		const value = JSON.parse(text) as unknown;
		return Array.isArray(value) ? (value as T[]) : undefined;
	} catch {
		return undefined;
	}
};

const getTmuxLocation = async (pi: ExtensionAPI): Promise<TmuxLocation | undefined> => {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return undefined;

	try {
		const result = await execTmux(pi, ["display-message", "-p", "-t", pane, "#{socket_path}\t#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#S\t#{window_index}"]);
		const [socketPath, pidText, sessionId, windowId, paneId, sessionName, windowIndex] = result.stdout.trim().split("\t");
		const serverPid = Number(pidText);
		const server = tmuxServer();
		if (result.code !== 0 || !server || socketPath !== server.socketPath || serverPid !== server.serverPid || !sessionId || !windowId || !paneId) return undefined;
		return { socketPath, serverPid, sessionId, windowId, paneId, sessionName, windowIndex };
	} catch {
		return undefined;
	}
};

const getTmuxClients = async (pi: ExtensionAPI): Promise<TmuxClient[]> => {
	try {
		const result = await execTmux(pi, ["list-clients", "-F", "#{client_pid}\t#{client_tty}\t#{session_id}\t#{window_id}"]);

		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [pidText, tty, sessionId, windowId] = line.split("\t");
				return { pid: Number(pidText), tty, sessionId, windowId };
			})
			.filter((client) => Number.isInteger(client.pid) && client.pid > 0 && !!client.sessionId && !!client.windowId);
	} catch {
		return [];
	}
};

const getTmuxClientsForWindow = async (pi: ExtensionAPI, location: TmuxLocation): Promise<TmuxClient[]> => {
	const clients = await getTmuxClients(pi);
	return clients.filter((client) => client.sessionId === location.sessionId && client.windowId === location.windowId);
};

const getAncestorPids = async (pid: number): Promise<number[]> => {
	const pids: number[] = [];
	let current = pid;

	for (let depth = 0; depth < 64 && current > 1; depth++) {
		pids.push(current);

		try {
			const status = await readFile(`/proc/${current}/status`, "utf8");
			const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
			if (!parent) break;
			current = Number(parent);
		} catch {
			break;
		}
	}

	return pids;
};

const getVisibleHyprWorkspaceIds = (monitors: HyprMonitor[]): Set<number> => {
	const ids = new Set<number>();
	for (const monitor of monitors) {
		if (typeof monitor.activeWorkspace?.id === "number") ids.add(monitor.activeWorkspace.id);
		if (typeof monitor.specialWorkspace?.id === "number" && monitor.specialWorkspace.id !== 0) {
			ids.add(monitor.specialWorkspace.id);
		}
	}
	return ids;
};

const hyprClientIsUsable = (client: HyprClient): boolean => {
	return (
		typeof client.address === "string" &&
		client.address.length > 0 &&
		typeof client.workspace?.id === "number" &&
		client.mapped !== false &&
		client.hidden !== true
	);
};

const hyprClientIsVisible = (client: HyprClient, visibleWorkspaceIds: Set<number>): boolean => {
	const workspaceId = client.workspace?.id;
	return hyprClientIsUsable(client) && typeof workspaceId === "number" && visibleWorkspaceIds.has(workspaceId) && client.visible !== false;
};

const getHyprState = async (pi: ExtensionAPI): Promise<{ clients: HyprClient[]; visibleWorkspaceIds: Set<number> } | undefined> => {
	try {
		const [clientsResult, monitorsResult] = await Promise.all([
			pi.exec("hyprctl", ["clients", "-j"], { timeout: 3000 }),
			pi.exec("hyprctl", ["monitors", "-j"], { timeout: 3000 }),
		]);

		const clients = parseJsonArray<HyprClient>(clientsResult.stdout);
		const monitors = parseJsonArray<HyprMonitor>(monitorsResult.stdout);
		if (!clients || !monitors) return undefined;

		return { clients, visibleWorkspaceIds: getVisibleHyprWorkspaceIds(monitors) };
	} catch {
		return undefined;
	}
};

const findHyprWindowForTmuxClient = async (
	tmuxClientPid: number,
	hyprClients: HyprClient[],
): Promise<HyprClient | undefined> => {
	const ancestorPids = new Set(await getAncestorPids(tmuxClientPid));
	return hyprClients.find((client) => typeof client.pid === "number" && ancestorPids.has(client.pid) && hyprClientIsUsable(client));
};

const getPiTmuxWindowTarget = async (pi: ExtensionAPI, targetId: string): Promise<NotifiTarget | undefined> => {
	const location = await getTmuxLocation(pi);
	if (!location) return undefined;

	const baseTarget: NotifiTarget = {
		id: targetId,
		tmuxSocketPath: location.socketPath,
		tmuxServerPid: location.serverPid,
		tmuxSessionId: location.sessionId,
		tmuxWindowId: location.windowId,
		tmuxPaneId: location.paneId,
		timestamp: Date.now(),
	};

	const [attachedClients, hyprState] = await Promise.all([getTmuxClients(pi), getHyprState(pi)]);
	if (attachedClients.length === 0 || !hyprState) return baseTarget;

	const targetWindowClients = attachedClients.filter(
		(client) => client.sessionId === location.sessionId && client.windowId === location.windowId,
	);
	const targetSessionClients = attachedClients.filter(
		(client) => client.sessionId === location.sessionId && client.windowId !== location.windowId,
	);
	const otherSessionClients = attachedClients.filter((client) => client.sessionId !== location.sessionId);

	// Prefer a client already viewing the target window. If none exists, use any
	// attached client for the same session. Finally, fall back to any tmux client
	// mapped to a Hyprland window; that client may have switched to another tmux
	// session after this pi task started, but the notification action can switch
	// it back instead of opening a new Ghostty window.
	const tmuxClients = [...targetWindowClients, ...targetSessionClients, ...otherSessionClients];

	for (const tmuxClient of tmuxClients) {
		const hyprWindow = await findHyprWindowForTmuxClient(tmuxClient.pid, hyprState.clients);
		if (!hyprWindow || typeof hyprWindow.workspace?.id !== "number" || !hyprWindow.address) continue;

		return {
			...baseTarget,
			workspaceId: hyprWindow.workspace.id,
			hyprWindowAddress: hyprWindow.address,
			tmuxClientTty: tmuxClient.tty,
		};
	}

	return baseTarget;
};

const piTmuxWindowIsVisible = async (pi: ExtensionAPI): Promise<boolean> => {
	const location = await getTmuxLocation(pi);
	if (!location) return false;

	const [tmuxClients, hyprState] = await Promise.all([getTmuxClientsForWindow(pi, location), getHyprState(pi)]);
	if (tmuxClients.length === 0 || !hyprState) return false;

	for (const tmuxClient of tmuxClients) {
		const hyprWindow = await findHyprWindowForTmuxClient(tmuxClient.pid, hyprState.clients);
		if (hyprWindow && hyprClientIsVisible(hyprWindow, hyprState.visibleWorkspaceIds)) return true;
	}

	return false;
};

const writeTarget = async (target: NotifiTarget | undefined): Promise<void> => {
	if (!target) return;
	const path = targetFile(target.id);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(target, null, 2)}\n`, "utf8");
};

const getStatus = (messages: unknown[]): TaskStatus => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return "error";
		if (message.stopReason === "aborted") return "aborted";
		return "finished";
	}
	return "finished";
};

const sendNotification = async (pi: ExtensionAPI, config: NotifiConfig, targetId: string | undefined): Promise<void> => {
	await pi.exec(
		"bash",
		[
			"-c",
			[
				"set -euo pipefail",
				"title=$1",
				"body=$2",
				"urgency=$3",
				"expire_time=$4",
				"target_id=$5",
				"focus_script=$6",
				"args=(--app-name pi --urgency \"$urgency\" --expire-time \"$expire_time\")",
				"if [[ -z \"$target_id\" ]]; then",
				"  notify-send \"${args[@]}\" \"$title\" \"$body\"",
				"else",
				"  args=(--wait --action=focus=Focus \"${args[@]}\")",
				"  (",
				"    action=$(notify-send \"${args[@]}\" \"$title\" \"$body\" || true)",
				"    if [[ \"$action\" == \"focus\" ]]; then",
				"      \"$focus_script\" \"$target_id\" >/dev/null 2>&1 || true",
				"    fi",
				"  ) >/dev/null 2>&1 &",
				"fi",
			].join("\n"),
			"notifi-send",
			config.title ?? "pi",
			config.body ?? "Task Finished",
			config.urgency ?? "normal",
			config.expireTime ?? "0",
			targetId ?? "",
			focusScriptPath,
		],
		{ timeout: 5000 },
	);
};

const notify = async (pi: ExtensionAPI, ctx: ExtensionContext, status: TaskStatus): Promise<boolean> => {
	if (!(await desktopNotificationsAllowed(pi))) return false;
	const config = await getConfig(pi, ctx, status);
	if (config.disabled) return false;
	if (config.focusAware && (await piTmuxWindowIsVisible(pi))) return false;

	try {
		const targetId = randomUUID();
		const target = await getPiTmuxWindowTarget(pi, targetId);
		if (process.env.TMUX && !target) return false;
		await writeTarget(target);
		await sendNotification(pi, config, target?.id);
		return true;
	} catch (error) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`notifi: notify-send failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		return false;
	}
};

export default function (pi: ExtensionAPI) {
	let state: NotifiState = {
		enabled: true,
	};

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			const custom = entry as { type?: string; customType?: string; data?: Partial<NotifiState> };
			if (custom.type === "custom" && custom.customType === "notifi-state" && typeof custom.data?.enabled === "boolean") {
				state.enabled = custom.data.enabled;
			}
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!state.enabled) return;
		// If queued steering/follow-up messages remain, this is not the final idle point yet.
		if (ctx.hasPendingMessages()) return;
		await notify(pi, ctx, getStatus(event.messages as unknown[]));
	});

	pi.registerCommand("notifi", {
		description: "Manage desktop notifications when pi finishes a task: status | test | on/enable | off/disable",
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase() || "status";
			if (subcommand === "on" || subcommand === "enable") {
				state.enabled = true;
				pi.appendEntry("notifi-state", { enabled: true });
				ctx.ui.notify("notifi enabled", "info");
				return;
			}

			if (subcommand === "off" || subcommand === "disable") {
				state.enabled = false;
				pi.appendEntry("notifi-state", { enabled: false });
				ctx.ui.notify("notifi disabled", "info");
				return;
			}

			if (subcommand === "test") {
				const sent = await notify(pi, ctx, "finished");
				ctx.ui.notify(sent ? "notifi test sent" : "notifi test not sent (server policy, event config, visibility, or delivery failure)", "info");
				return;
			}

			const desktopAllowed = await desktopNotificationsAllowed(pi);
			ctx.ui.notify(`notifi is ${state.enabled ? "enabled" : "disabled"}; desktop delivery ${desktopAllowed ? "allowed" : "blocked"}`, "info");
		},
	});
}
