#!/bin/sh
# Genera ~/.openjarvis/config.toml en cada arranque a partir de variables de
# entorno -- no hay volumen persistente, asi que el entorno es la unica
# fuente de verdad. Si SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_REF no estan
# seteadas, no escribe nada y el comportamiento por defecto de OpenJarvis
# queda intacto (config.toml simplemente no existe).
set -e

if [ -n "$SUPABASE_ACCESS_TOKEN" ] && [ -n "$SUPABASE_PROJECT_REF" ]; then
  mkdir -p "$HOME/.openjarvis"
  # include_tools restringe a herramientas de solo lectura -- el MCP de Supabase
  # tambien expone apply_migration, deploy_edge_function y manejo de branches
  # (create/delete/merge/reset/rebase), que NO estan cubiertas por read_only=true
  # (esa bandera solo protege execute_sql, no las operaciones de gestion del
  # proyecto). Sin este filtro el agente podria modificar el proyecto.
  # OPENJARVIS_DEFAULT_MODEL sobreescribe el modelo por defecto (el que la UI
  # nativa auto-selecciona); gpt-4o-mini es bastante mas barato que gpt-4o y
  # anda bien para este tipo de preguntas. Un pedido de chat puede seguir
  # pidiendo otro modelo explicitamente sin que esto se lo impida.
  cat > "$HOME/.openjarvis/config.toml" <<TOML
[server]
model = "${OPENJARVIS_DEFAULT_MODEL:-gpt-4o-mini}"

[tools.mcp]
enabled = true
servers = '[{"name":"supabase","url":"https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true","token":"${SUPABASE_ACCESS_TOKEN}","include_tools":["list_tables","list_extensions","list_migrations","execute_sql","get_logs","get_advisors","get_project_url","get_publishable_keys","generate_typescript_types","list_edge_functions","get_edge_function","list_branches"]}]'
TOML
fi

exec jarvis "$@"
