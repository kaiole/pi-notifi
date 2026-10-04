# pi-notifi

A focus-aware desktop notification package for [pi](https://pi.dev/). It sends a
notification when an interactive pi task finishes, but skips the notification if
the tmux window containing that pi agent is already visible in Hyprland.

Notifications include a `Focus` action that jumps back to the originating pi
agent by restoring the saved Hyprland/Ghostty/tmux target.

This package is intentionally developed for an Arch + Hyprland + Ghostty +
tmux + dunst workflow. If your setup differs, copy/fork it and adapt the small
focus script.

## Requirements

- Linux with Hyprland
- Ghostty
- tmux
- dunst or another notification daemon compatible with `notify-send` actions
- `notify-send` from `libnotify`
- `dunstctl` if using the example keybinds
- `jq`

On Arch:

```bash
sudo pacman -S libnotify dunst jq
```

Your pi shell should be running inside tmux, and that tmux client should be
inside a Hyprland-managed Ghostty window.

## Install

From npm, once published:

```bash
pi install npm:pi-notifi
```

From git:

```bash
pi install git:github.com/<you>/pi-notifi
```

For a one-off test without installing:

```bash
pi -e git:github.com/<you>/pi-notifi
```

For local development from this checkout:

```bash
pi -e /absolute/path/to/pi-notifi
```

The package manifest loads:

```text
index.ts
```

No manual symlink is required. The extension invokes the packaged focus helper
at:

```text
scripts/notifi-focus
```

## My dunst / Hyprland setup

Hyprland binds:

```ini
bind = SUPER, X, exec, dunstctl close
bind = SUPER, N, exec, dunstctl action
```

Dunst mouse behavior:

```ini
mouse_left_click = do_action, close_current
mouse_right_click = close_current
```

Behavior:

- `SUPER X` / right click: close the current notification without action.
- `SUPER N` / left click: invoke the notification action. Dunst closes actioned notifications automatically.
- For notifi notifications, the action jumps to the Ghostty/tmux location that
  produced that specific notification.

## Commands

Inside pi:

```text
/notifi status
/notifi test
/notifi on|enable
/notifi off|disable
```

`on` / `off` are persisted into the current pi session. They do not override the
tmux server's desktop delivery policy. `status` also reports whether desktop
delivery is allowed; `test` reports when delivery was suppressed.

## Per-server desktop delivery

Different tmux servers share the same user's Linux notification daemon. notifi
therefore checks a **server-scoped** option before sending any event or test
notification, or creating an action target:

```bash
# Run inside the server you want to configure. No restart is needed.
tmux set-option -s @notifi-desktop on   # Permit host-desktop delivery
tmux set-option -s @notifi-desktop off  # Block host-desktop delivery
tmux set-option -s @notifi-desktop auto # Automatic (also the default when unset)
```

`auto` blocks delivery when the server's global environment contains a nonempty
`SSH_CONNECTION`, `SSH_TTY`, or `SSH_CLIENT`; otherwise it permits delivery.
These variables normally come from the environment in which the server was
created. notifi does not use the pi process's SSH variables inside tmux, because
session/process environments can be stale after reattaching. Set `on` or `off`
explicitly for servers shared by local and remote clients, or with unusual
inherited environments. Automatic detection is a convenience, not a security
boundary or a determination of which client is currently watching pi.

To configure a named server explicitly from anywhere:

```bash
tmux -N -L mac set-option -s @notifi-desktop off
```

Invalid option values or an unreachable/unidentifiable tmux server block delivery.
Without tmux, local pi retains its plain-notification behavior, while SSH-launched
pi does not send host-desktop notifications. Existing config/environment disable
settings still apply; allowing delivery does not override them or visibility
suppression.

The option is read for each notification, so changes take effect immediately in
pi instances running the updated extension. It lives only for the server's
lifetime; put a server-appropriate setting in its startup configuration if you
want persistence. Reload an existing pi instance with `/reload` after updating
this package; restarting tmux is unnecessary.

## Configuration

Configuration is read from the first valid JSON file that exists:

1. `<project>/.pi/notifi.json`
2. `~/.pi/agent/notifi.json`
3. `~/.pi/agent/extensions/notifi.json`

Example:

```json
{
  "disabled": false,
  "defaults": {
    "urgency": "normal",
    "expireTime": 0
  },
  "events": {
    "finished": {
      "body": "Task Finished"
    },
    "error": {
      "body": "Task Failed",
      "urgency": "critical"
    },
    "aborted": {
      "disabled": true,
      "body": "Task Aborted"
    }
  }
}
```

Top-level fields:

| Field      | Default | Description                    |
| ---------- | ------- | ------------------------------ |
| `disabled` | `false` | Disable all notifi events      |
| `defaults` | `{}`    | Shared defaults for all events |
| `events`   | `{}`    | Per-event notification config  |

Supported events:

| Event      | Default disabled | Default focus-aware | Default body    | Default urgency |
| ---------- | ---------------- | ------------------- | --------------- | --------------- |
| `finished` | `false`          | `true`              | `Task Finished` | `normal`        |
| `error`    | `false`          | `false`             | `Task Failed`   | `critical`      |
| `aborted`  | `true`           | `false`             | `Task Aborted`  | `normal`        |

Each event, and `defaults`, supports:

| Field        | Default                                 | Description                                                         |
| ------------ | --------------------------------------- | ------------------------------------------------------------------- |
| `disabled`   | event-specific                          | Disable notifications for this event                                |
| `focusAware` | event-specific                          | If true, suppress this event when the pi tmux window is visible     |
| `title`      | `<tmux-session>:<window-index>` or `pi` | Notification title                                                  |
| `body`       | event-specific                          | Notification body                                                   |
| `urgency`    | event-specific                          | notify-send urgency: `low`, `normal`, or `critical`                 |
| `expireTime` | `0`                                     | notify-send expire time in ms; `0` requests persist until dismissed |

Environment variables with the old `PI_NOTIFI_*` names override JSON for quick
one-off changes. Invalid JSON config files are ignored so a bad config does not
break notification delivery.

## Behavior

After the server policy permits desktop delivery, focus-aware events are
suppressed when all of these are true:

1. pi is running inside tmux.
2. notifi identifies the tmux session/window containing the pi pane.
3. an attached tmux client is currently viewing that same tmux window.
4. that tmux client maps through its process tree to a Hyprland window.
5. that Hyprland window is on a workspace visible on a monitor.

Pane focus does not matter for notification suppression. If the pi pane is
anywhere in the visible tmux window, no notification is sent. Notification
actions still try to focus the original pi pane after switching to the saved
tmux session/window.

If the tmux window is not visible, notifi sends a persistent notification with a
`Focus` action:

```text
<title: tmux-session:window-index>
<body: Task Finished | Task Failed | Task Aborted>
<action: Focus>
```

Only `finished` is focus-aware by default. `error` and `aborted` are not
focus-aware by default, so enabled error/abort notifications fire even when the
pi tmux window is visible. Aborted tasks still do not notify by default because
the `aborted` event is disabled by default. Headless/print-mode pi runs do not
notify.

## Action target cache

Each notification gets a unique UUID target id. The extension writes that
notification's jump target to:

```text
${XDG_CACHE_HOME:-~/.cache}/notifi/targets/<target-id>.json
```

Each notification action captures its own target id, so multiple concurrent pi
agents and long-lived notifications do not overwrite each other. Targets also
record the originating tmux socket path and server PID. Every tmux query/action
explicitly uses that socket, never the helper's inherited `TMUX` or another
server. A missing server is not automatically restarted.

`scripts/notifi-focus <target-id>`:

1. validates the target id
2. reads the target file
3. deletes the consumed target file
4. prunes target files older than 24 hours
5. verifies that the saved socket still belongs to the saved server PID and that
   the saved session/window exists
6. switches Hyprland to the saved Ghostty workspace/window when possible
7. switches only the originating tmux server to the saved session/window
8. focuses the original pi pane if it still exists

If no existing Ghostty/tmux client can be mapped back to Hyprland but the tmux
session/window still exists, the action opens Ghostty attached to that tmux
session/window. If the tmux session/window no longer exists, it exits
successfully and does nothing. A replacement server at the same socket also
causes the action to exit without focusing anything. Older targets lacking a
socket path/server PID are consumed without action rather than guessing which
server their IDs belong to. Existing desktop notifications are not cleared by
this update.

Target files for notifications dismissed without action are cleaned up the next
time a notifi action is consumed.

## Edge cases

- If multiple Ghostty windows are attached to tmux, notifi prefers one already
  viewing the target window, then one in the target session, then any usable tmux
  client it can map back to Hyprland.
- If no saved/reusable Ghostty/Hyprland window exists, notifi falls back to
  opening Ghostty attached to the saved tmux session/window.
- If the saved tmux server, session, or window no longer exists, the action exits
  successfully and does nothing; it never falls back to a different server.
- If the saved tmux pane no longer exists, the action still switches to the
  saved tmux window and skips pane focus.
- If the target file is missing, malformed, or older than 24 hours when pruning
  runs, the action exits successfully and/or removes stale metadata.

## Development checks

```bash
npm run check
```

This runs type checking, shell syntax checking, and regression tests. Tests
create isolated tmux servers with temporary sockets and an empty tmux config;
only those disposable servers are stopped afterward. Notification delivery and
Ghostty/Hyprland actions are stubbed, so tests do not send real notifications or
touch existing tmux servers.
