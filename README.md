# Solera Update — update indicator for GNOME Shell

GNOME Shell extension for **Solera** (an immutable, atomic Arch-based
distribution using the `arkdep` deployment engine). It adds a top-bar
indicator that:

- periodically checks (at login and every 6 h) whether a new system image has
  been published to the Solera repository,
- notifies you when an update is available,
- runs the actual deployment (`solera update`) via **polkit/pkexec** — the
  extension **never** handles the password; polkit shows its native dialog,
- animates the icon while deploying,
- and offers to **reboot** once the deployment is staged.

## Architecture

| Piece | What it does | Privileges |
|---|---|---|
| `extension.js` | indicator, states, animation, notifications, flow | user (gnome-shell) |
| `updateChecker.js` | detects updates: GET `<repo>/<image>/database` + local state (`/proc/self/mountinfo`, `/arkdep/tracker`) | user, no root |
| `lib/solera-gui-update` | wrapper that sets `ARKDEP_CONFIRM=1` and execs `solera update` | **root** (via `pkexec`) |

### Update detection (no root)

```
remote   = first field of the 1st line of  <repo_url>/<image>/database
deployed = first line of /arkdep/tracker
running  = root subvol from /proc/self/mountinfo
updateAvailable = remote   != deployed
needsReboot     = deployed != running
```

`repo_url` and `repo_default_image` are read from `/arkdep/config`.

## Development / live testing

```sh
./install.sh        # copies the repo to ~/.local/share/gnome-shell/extensions/
                    # and enables it; then LOG OUT AND BACK IN
```

No symlink is used: GNOME Shell scans extensions at login, when this repo (on
an external drive) may not be mounted yet, so the symlink would dangle. On
Wayland the shell does not hot-reload extensions either, so every JS change
requires logging out and back in.

Export `SOLERA_UPDATE_DEBUG=1` in the session to reveal a **"Simulation (dev)"**
submenu that walks the states (update available → deploying → reboot pending)
with no network or real deploy. It does not appear in the normal package.

### The icon

`icons/solera-symbolic.svg` (the Solera sun) ships inside the extension and is
loaded as a `GFileIcon`; St recognizes it as symbolic by name and recolors it
with the panel's foreground color. It is not installed into the icon theme.

## Translations

Source strings are English and wrapped with gettext (`_()`); the gettext domain
is set in `metadata.json`. Translation sources live in `po/` (`*.pot` template
and per-language `*.po`); `install.sh` and the package compile them to
`locale/<lang>/LC_MESSAGES/<domain>.mo`. Ships with a Spanish translation.

## Packaging in Solera

The monorepo `solera/packages/gnome-shell-extension-solera-update/PKGBUILD`
downloads a **tag** of this repo (same pattern as dash-to-dock) and installs it
system-wide under `/usr/share/gnome-shell/extensions/` (including `icons/` and
`lib/solera-gui-update`). Default activation is handled by `solera-config` via a
dconf override.

## License

GPL-2.0-or-later.
