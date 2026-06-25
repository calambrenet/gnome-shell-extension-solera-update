// SPDX-License-Identifier: GPL-2.0-or-later
//
// extension.js — indicador de actualizaciones de Solera en la barra superior.
//
// UI (GJS) que: comprueba updates cuando hay conexión (no al instante del
// login: NetworkManager-wait-online está enmascarado y la red sube tarde) y
// cada 6 h, avisa con una notificación, lanza el despliegue real vía `pkexec`
// (diálogo polkit nativo — la extensión NUNCA toca la contraseña), anima el
// icono mientras despliega y, al terminar, ofrece reiniciar.
//
// El trabajo privilegiado vive fuera de gnome-shell, en el wrapper
// lib/solera-gui-update (que fija ARKDEP_CONFIRM=1 y exec'ea
// `solera update`). La detección es 100% espacio de usuario (updateChecker.js).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {UpdateChecker} from './updateChecker.js';

const CHECK_INTERVAL_SECONDS = 6 * 60 * 60; // cada 6 h
const FIRST_CHECK_DELAY_SECONDS = 15;       // margen tras tener red, sin agobiar el arranque
const SPIN_INTERVAL_MS = 60;
// Si un chequeo falla por red (conectividad reportada pero el GET no sale:
// portal cautivo, DNS aún frío, repo caído un momento…) reintentamos con este
// backoff en vez de quedarnos en ERROR hasta el siguiente tick de 6 h.
const RETRY_BACKOFF_SECONDS = [30, 60, 120, 300, 600];

const State = {
    IDLE: 'idle',                   // al día
    CHECKING: 'checking',           // comprobando (spinner)
    UPDATE_AVAILABLE: 'available',  // hay nueva imagen
    UPDATING: 'updating',           // desplegando (spinner)
    NEEDS_REBOOT: 'reboot',         // deploy en cola, falta reiniciar
    ERROR: 'error',                 // no se pudo comprobar
};

// Sentinela del sol de Solera. Se carga como GFileIcon desde la extensión
// (icons/solera-symbolic.svg), igual que hace la extensión Caffeine con sus
// iconos: St lo reconoce como symbolic (nombre -symbolic) y lo recolorea.
const SOLERA_ICON = '__solera__';

const STATE_ICON = {
    [State.IDLE]: SOLERA_ICON,                                  // sol estático
    [State.CHECKING]: SOLERA_ICON,                              // sol girando
    [State.UPDATE_AVAILABLE]: 'software-update-available-symbolic',
    [State.UPDATING]: SOLERA_ICON,                             // sol girando
    [State.NEEDS_REBOOT]: 'system-reboot-symbolic',
    [State.ERROR]: 'dialog-warning-symbolic',
};

const SoleraIndicator = GObject.registerClass(
class SoleraIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Solera Update');
        this._extension = extension;
        this._state = State.IDLE;
        this._last = null;          // último resultado de check()
        this._sim = null;           // override de simulación (modo dev) o null
        this._spinTimerId = 0;
        this._notifSource = null;

        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._icon.set_pivot_point(0.5, 0.5);
        this._setIcon(STATE_ICON[State.IDLE]);
        this.add_child(this._icon);

        this._buildMenu();
        this._applyState(State.IDLE, {silent: true});
    }

    // ---- menú -------------------------------------------------------------

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);

        this._versionItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._versionItem.label.add_style_class_name('solera-dim');
        this.menu.addMenuItem(this._versionItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._actionItem = new PopupMenu.PopupMenuItem(_('Check for updates'));
        this._actionItem.connect('activate', () => this._onPrimaryAction());
        this.menu.addMenuItem(this._actionItem);

        // --- submenú de simulación (solo desarrollo) ---
        // Oculto salvo que se exporte SOLERA_UPDATE_DEBUG=1 en la sesión.
        // En el paquete normal no aparece.
        if (GLib.getenv('SOLERA_UPDATE_DEBUG') !== '1')
            return;
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const dev = new PopupMenu.PopupSubMenuMenuItem('Simulation (dev)');
        const addSim = (label, fn) => {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', fn);
            dev.menu.addMenuItem(it);
        };
        addSim('Simulate: update available', () => {
            this._sim = 'available';
            this._last = {running: 'solera-26-04-build-20260620-075443',
                deployed: 'solera-26-04-build-20260620-075443',
                remote: 'solera-26-05-build-20260701-101500', reachable: true};
            this._applyState(State.UPDATE_AVAILABLE);
        });
        addSim('Simulate: deploying', () => {
            this._sim = 'updating';
            this._simulateDeploy();
        });
        addSim('Simulate: reboot pending', () => {
            this._sim = 'reboot';
            this._applyState(State.NEEDS_REBOOT);
        });
        addSim('Reset (re-check)', () => {
            this._sim = null;
            this.checkNow();
        });
        this.menu.addMenuItem(dev);
    }

    // ---- estados ----------------------------------------------------------

    _applyState(state, {silent = false} = {}) {
        this._state = state;
        this._setIcon(STATE_ICON[state] ?? SOLERA_ICON);

        const spinning = state === State.CHECKING || state === State.UPDATING;
        this._setSpinning(spinning);

        const v = this._last ?? {};
        const short = id => (id ? id.replace(/^solera-/, '') : '—');

        switch (state) {
        case State.IDLE:
            this._statusItem.label.text = _('Solera is up to date');
            this._actionItem.label.text = _('Check for updates');
            break;
        case State.CHECKING:
            this._statusItem.label.text = _('Checking for updates…');
            this._actionItem.label.text = _('Checking…');
            break;
        case State.UPDATE_AVAILABLE:
            this._statusItem.label.text = _('Update available');
            this._actionItem.label.text = _('Update now');
            if (!silent)
                this._notifyUpdateAvailable();
            break;
        case State.UPDATING:
            this._statusItem.label.text = _('Deploying update…');
            this._actionItem.label.text = _('Deploying…');
            break;
        case State.NEEDS_REBOOT:
            this._statusItem.label.text = _('Restart to apply the update');
            this._actionItem.label.text = _('Restart now');
            if (!silent)
                this._notifyReboot();
            break;
        case State.ERROR:
            this._statusItem.label.text = _('Could not check (no network?)');
            this._actionItem.label.text = _('Retry');
            break;
        }

        this._versionItem.label.text = `${_('Installed')}: ${short(v.running)}` +
            (v.remote && v.remote !== v.running ? `  →  ${short(v.remote)}` : '');
    }

    // El sol: GFileIcon del SVG symbolic de la extensión (método Caffeine).
    // El resto: iconos symbolic del tema por nombre. St recolorea ambos.
    _setIcon(spec) {
        if (spec === SOLERA_ICON) {
            const path = GLib.build_filenamev(
                [this._extension.path, 'icons', 'solera-symbolic.svg']);
            this._icon.gicon = Gio.icon_new_for_string(path);
        } else {
            this._icon.gicon = null;
            this._icon.icon_name = spec;
        }
    }

    _setSpinning(on) {
        if (on && !this._spinTimerId) {
            this._spinTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPIN_INTERVAL_MS, () => {
                this._icon.rotation_angle_z = (this._icon.rotation_angle_z + 12) % 360;
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._spinTimerId) {
            GLib.source_remove(this._spinTimerId);
            this._spinTimerId = 0;
            this._icon.rotation_angle_z = 0;
        }
    }

    // ---- acciones ---------------------------------------------------------

    _onPrimaryAction() {
        switch (this._state) {
        case State.UPDATE_AVAILABLE:
            this._startUpdate();
            break;
        case State.NEEDS_REBOOT:
            this._reboot();
            break;
        case State.UPDATING:
        case State.CHECKING:
            break; // ocupado
        default:
            this.checkNow();
        }
    }

    async checkNow() {
        if (this._sim)
            return; // en simulación no pisamos el estado falso
        this._applyState(State.CHECKING, {silent: true});
        const res = await this._extension._checker.check();
        this._last = res;
        if (res.needsReboot)
            this._applyState(State.NEEDS_REBOOT);
        else if (res.updateAvailable)
            this._applyState(State.UPDATE_AVAILABLE);
        else if (!res.reachable)
            this._applyState(State.ERROR);
        else
            this._applyState(State.IDLE);
        // La extensión decide si reintenta (fallo de red) o resetea el backoff.
        this._extension._onCheckFinished(res);
    }

    _startUpdate() {
        if (this._sim === 'available') {
            this._sim = 'updating';
            this._simulateDeploy();
            return;
        }
        this._applyState(State.UPDATING, {silent: true});
        const wrapper = GLib.build_filenamev([this._extension.path, 'lib', 'solera-gui-update']);
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['pkexec', wrapper],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            this._notify('Solera', `${_('Could not start the update:')} ${e.message}`,
                MessageTray.Urgency.HIGH);
            this.checkNow();
            return;
        }
        proc.communicate_utf8_async(null, null, (p, result) => {
            let ok = false, out = '';
            try {
                const [, stdout] = p.communicate_utf8_finish(result);
                out = stdout ?? '';
                ok = p.get_exit_status() === 0;
            } catch (e) {
                out = e.message;
            }
            if (ok) {
                this.checkNow(); // recalcula → debería caer en NEEDS_REBOOT
            } else {
                // exit 126/127 = polkit cancelado / no autorizado
                this._notify('Solera', _('The update did not complete.'),
                    MessageTray.Urgency.HIGH);
                this.checkNow();
            }
            log(`[solera-update] deploy exit ok=${ok}: ${out.slice(-500)}`);
        });
    }

    _simulateDeploy() {
        this._applyState(State.UPDATING, {silent: true});
        this._simTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6, () => {
            this._simTimerId = 0;
            this._sim = 'reboot';
            if (this._last)
                this._last.deployed = this._last.remote;
            this._applyState(State.NEEDS_REBOOT);
            return GLib.SOURCE_REMOVE;
        });
    }

    _reboot() {
        if (this._sim) {
            this._notify('Solera (sim)', 'This would restart the computer.',
                MessageTray.Urgency.NORMAL);
            this._sim = null;
            this.checkNow();
            return;
        }
        try {
            const bus = Gio.DBus.system;
            bus.call(
                'org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', 'Reboot',
                new GLib.Variant('(b)', [true]), null,
                Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            this._notify('Solera', `${_('Could not restart:')} ${e.message}`,
                MessageTray.Urgency.HIGH);
        }
    }

    // ---- notificaciones ---------------------------------------------------

    _ensureSource() {
        if (this._notifSource && !this._notifSource._destroyed)
            return this._notifSource;
        this._notifSource = new MessageTray.Source({
            title: 'Solera',
            iconName: 'software-update-available-symbolic',
        });
        this._notifSource.connect('destroy', () => (this._notifSource = null));
        Main.messageTray.add(this._notifSource);
        return this._notifSource;
    }

    _notify(title, body, urgency = MessageTray.Urgency.NORMAL) {
        const source = this._ensureSource();
        const n = new MessageTray.Notification({source, title, body, urgency});
        source.addNotification(n);
        return n;
    }

    _notifyUpdateAvailable() {
        const source = this._ensureSource();
        const n = new MessageTray.Notification({
            source,
            title: _('Solera update available'),
            body: _('A new system image is ready to deploy.'),
            urgency: MessageTray.Urgency.HIGH,
        });
        n.addAction(_('Update now'), () => this._startUpdate());
        source.addNotification(n);
    }

    _notifyReboot() {
        const source = this._ensureSource();
        const n = new MessageTray.Notification({
            source,
            title: _('Update ready'),
            body: _('Restart to boot into the new version of Solera.'),
            urgency: MessageTray.Urgency.HIGH,
        });
        n.addAction(_('Restart now'), () => this._reboot());
        source.addNotification(n);
    }

    // ---- limpieza ---------------------------------------------------------

    destroy() {
        this._setSpinning(false);
        if (this._simTimerId) {
            GLib.source_remove(this._simTimerId);
            this._simTimerId = 0;
        }
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }
        super.destroy();
    }
});

export default class SoleraUpdateExtension extends Extension {
    enable() {
        this._checker = new UpdateChecker();
        this._indicator = new SoleraIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._firstId = 0;
        this._retryId = 0;
        this._retryIndex = 0;
        this._netChangedId = 0;
        this._netMonitor = Gio.NetworkMonitor.get_default();

        // Primera comprobación: solo cuando la red esté de verdad arriba. Con
        // NetworkManager-wait-online enmascarado, al login todavía no hay ruta;
        // un retardo fijo es una adivinanza, así que esperamos a conectividad
        // FULL (no solo `network_available`, que da true con link-local o
        // portal cautivo y nos haría fallar el GET al repo).
        this._scheduleFirstCheck();

        // Tick periódico cada 6 h (pasa por checkNow → _onCheckFinished, así
        // que también se beneficia del reintento si justo no hay red).
        this._periodId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            CHECK_INTERVAL_SECONDS, () => {
                this._indicator?.checkNow();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _hasFullConnectivity() {
        return this._netMonitor?.connectivity === Gio.NetworkConnectivity.FULL;
    }

    _scheduleFirstCheck() {
        if (this._hasFullConnectivity()) {
            this._armFirstCheck();
            return;
        }
        // Aún sin red: chequeamos en cuanto suba la conectividad y nos
        // desconectamos (el resto lo cubre el tick periódico).
        log('[solera-update] no connectivity yet, waiting for network');
        this._netChangedId = this._netMonitor.connect('network-changed', () => {
            if (!this._hasFullConnectivity())
                return;
            log('[solera-update] connectivity is now FULL, scheduling first check');
            this._disconnectNetMonitor();
            this._armFirstCheck();
        });
    }

    // Pequeño margen para no agobiar el arranque (sesión, shell, dconf…).
    _armFirstCheck() {
        if (this._firstId)
            return;
        log(`[solera-update] first check in ${FIRST_CHECK_DELAY_SECONDS}s`);
        this._firstId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            FIRST_CHECK_DELAY_SECONDS, () => {
                this._firstId = 0;
                this._indicator?.checkNow();
                return GLib.SOURCE_REMOVE;
            });
    }

    _disconnectNetMonitor() {
        if (this._netChangedId) {
            this._netMonitor.disconnect(this._netChangedId);
            this._netChangedId = 0;
        }
    }

    _cancelRetry() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
    }

    // Llamado por el indicador al terminar cada check(). Centraliza el
    // reintento con backoff ante fallo de red.
    _onCheckFinished(res) {
        if (!this._indicator)
            return; // extensión ya desactivada (check en vuelo)
        if (res?.reachable) {
            this._retryIndex = 0;
            this._cancelRetry();
            return;
        }
        this._cancelRetry();
        const i = Math.min(this._retryIndex, RETRY_BACKOFF_SECONDS.length - 1);
        const delay = RETRY_BACKOFF_SECONDS[i];
        this._retryIndex = i + 1;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            this._indicator?.checkNow();
            return GLib.SOURCE_REMOVE;
        });
        log(`[solera-update] check failed (no network?), retrying in ${delay}s`);
    }

    disable() {
        this._disconnectNetMonitor();
        this._netMonitor = null;
        if (this._firstId) {
            GLib.source_remove(this._firstId);
            this._firstId = 0;
        }
        this._cancelRetry();
        if (this._periodId) {
            GLib.source_remove(this._periodId);
            this._periodId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._checker?.destroy();
        this._checker = null;
    }
}
