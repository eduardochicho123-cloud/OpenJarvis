#!/bin/sh
# Genera ~/.openjarvis/config.toml en cada arranque a partir de variables de
# entorno -- no hay volumen persistente, asi que el entorno es la unica
# fuente de verdad. Si SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_REF no estan
# seteadas, no escribe nada y el comportamiento por defecto de OpenJarvis
# queda intacto (config.toml simplemente no existe).
set -e

if [ -n "$SUPABASE_ACCESS_TOKEN" ] && [ -n "$SUPABASE_PROJECT_REF" ]; then
  mkdir -p "$HOME/.openjarvis"
  cat > "$HOME/.openjarvis/config.toml" <<TOML
[tools.mcp]
enabled = true
servers = '[{"name":"supabase","url":"https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true","token":"${SUPABASE_ACCESS_TOKEN}"}]'
TOML
fi

exec jarvis "$@"
