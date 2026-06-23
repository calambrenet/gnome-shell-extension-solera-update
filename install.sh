#!/usr/bin/env bash
# install.sh — instala/actualiza la extensión en el directorio de usuario
# para probarla en vivo.
#
# OJO (Wayland + repo en disco externo): no se puede enlazar por symlink desde
# ~/.local/share/gnome-shell/extensions/ al repo, porque GNOME Shell escanea
# las extensiones al iniciar sesión, momento en el que un disco externo puede
# no estar montado todavía (el symlink quedaría colgando y la extensión se
# ignora en silencio). Por eso copiamos a una carpeta real en $HOME.
#
# Tras ejecutar este script hay que CERRAR Y ABRIR SESIÓN: en Wayland el shell
# no recarga extensiones nuevas ni cambios de JS en caliente.

set -euo pipefail

UUID="solera-update@soleralinux.org"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

rm -rf "$DEST"
mkdir -p "$DEST"
for f in extension.js updateChecker.js metadata.json stylesheet.css lib icons; do
    [ -e "$SRC/$f" ] && cp -r "$SRC/$f" "$DEST/"
done
chmod +x "$DEST/lib/solera-gui-update" 2>/dev/null || true

# Compilar traducciones (po/*.po → locale/<lang>/LC_MESSAGES/<domain>.mo).
DOMAIN="solera-update@soleralinux.org"
for po in "$SRC"/po/*.po; do
    [ -e "$po" ] || continue
    lang="$(basename "$po" .po)"
    install -d "$DEST/locale/$lang/LC_MESSAGES"
    msgfmt "$po" -o "$DEST/locale/$lang/LC_MESSAGES/$DOMAIN.mo"
done

# El sol (icons/solera-symbolic.svg) viaja DENTRO de la extensión y se carga
# como GFileIcon (método Caffeine). No se instala en el tema de iconos.
# Limpio restos de intentos anteriores en el tema del usuario, por si acaso.
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons"
rm -f "$ICONS/solera.svg" "$ICONS/solera-symbolic.svg" \
      "$ICONS/hicolor/scalable/apps/solera.svg" \
      "$ICONS/hicolor/scalable/apps/solera-symbolic.svg" 2>/dev/null || true

gnome-extensions enable "$UUID" 2>/dev/null || true

echo "Instalada en: $DEST"
echo "Cierra y vuelve a abrir sesión para que GNOME Shell la cargue."
