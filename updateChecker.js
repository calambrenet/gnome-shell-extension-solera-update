// SPDX-License-Identifier: GPL-2.0-or-later
//
// updateChecker.js — detección de actualizaciones de Solera SIN privilegios.
//
// El modelo de estado de arkdep distingue tres "versiones":
//
//   running  — el deployment que está arrancado ahora mismo. Se lee del
//              primer renglón de /proc/self/mountinfo (el subvol del root).
//   deployed — el último deployment presente en disco. Primera línea de
//              /arkdep/tracker. Tras un `solera update` (pero antes de
//              reiniciar) será MÁS NUEVO que `running`.
//   remote   — la última imagen publicada en el repo. Primer campo (antes
//              del ':') de la primera línea de  <repo_url>/<image>/database.
//
// De ahí derivamos:
//   updateAvailable = remote  != deployed   (hay algo nuevo que desplegar)
//   needsReboot     = deployed != running   (hay un deploy en cola)
//
// Todo esto es espacio de usuario: HTTP GET público + lectura de ficheros
// world-readable. El `solera update` real (que sí necesita root) se lanza
// aparte vía pkexec.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

// GJS no promisifica los métodos async automáticamente: hay que registrarlos
// para poder usar await sin pasar callback.
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const ARKDEP_CONFIG = '/arkdep/config';
const ARKDEP_TRACKER = '/arkdep/tracker';
const DEFAULT_REPO_URL = 'https://repo.soleralinux.org/stable/images';
const DEFAULT_IMAGE = 'solera';

function readFileSync(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder('utf-8').decode(bytes);
    } catch (_e) {
        return null;
    }
}

// Lee repo_url y repo_default_image de /arkdep/config, con fallback a los
// valores por defecto que el propio arkdep usa cuando faltan.
export function readArkdepConfig() {
    const text = readFileSync(ARKDEP_CONFIG) ?? '';
    const grab = (key, fallback) => {
        const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*'?([^'\\n]+)'?`, 'm'));
        return m ? m[1].trim() : fallback;
    };
    return {
        repoUrl: grab('repo_url', DEFAULT_REPO_URL).replace(/\/+$/, ''),
        image: grab('repo_default_image', DEFAULT_IMAGE),
    };
}

// id del deployment actualmente arrancado, p.ej.
// "solera-26-04-build-20260620-075443" o null si no se puede determinar.
export function getRunningDeployment() {
    const text = readFileSync('/proc/self/mountinfo');
    if (!text)
        return null;
    const first = text.split('\n')[0] ?? '';
    const m = first.match(/\/deployments\/([^/]+)\//);
    return m ? m[1] : null;
}

// Último deployment presente en disco (primera línea del tracker).
export function getDeployedLatest() {
    const text = readFileSync(ARKDEP_TRACKER);
    if (!text)
        return null;
    const first = text.split('\n').map(l => l.trim()).find(l => l.length > 0);
    return first ?? null;
}

export class UpdateChecker {
    constructor() {
        this._session = new Soup.Session({timeout: 30});
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
        this._session = null;
    }

    // GET <repo>/<image>/database y devuelve el id de la primera entrada,
    // o lanza si no hay red / no se puede parsear.
    async fetchRemoteLatest() {
        const {repoUrl, image} = readArkdepConfig();
        const url = `${repoUrl}/${image}/database`;
        const msg = Soup.Message.new('GET', url);
        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${msg.get_status()} requesting ${url}`);
        const text = new TextDecoder('utf-8').decode(bytes.get_data());
        const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0);
        if (!firstLine)
            throw new Error('empty database');
        // formato:  <id>:<compresion>:<sha256>
        return firstLine.split(':')[0];
    }

    // Estado completo. Nunca lanza: ante error de red marca
    // remote=null y reachable=false para que la UI degrade con gracia.
    async check() {
        const running = getRunningDeployment();
        const deployed = getDeployedLatest();
        let remote = null;
        let reachable = true;
        let error = null;
        try {
            remote = await this.fetchRemoteLatest();
        } catch (e) {
            reachable = false;
            error = e.message ?? String(e);
        }
        const updateAvailable = !!(remote && deployed && remote !== deployed);
        const needsReboot = !!(deployed && running && deployed !== running);
        return {running, deployed, remote, reachable, error, updateAvailable, needsReboot};
    }
}
