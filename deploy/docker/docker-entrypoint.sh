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
  # [speech] backend se fuerza a "openai" porque el default "auto" prueba
  # faster-whisper primero (motor local) y esta imagen no lo tiene instalado
  # (no hay GPU/Ollama en este despliegue) -- sin esto, /v1/speech/transcribe
  # explota con ImportError apenas alguien usa el microfono del Command Center.
  # [agent] default_system_prompt (NO "system_prompt" -- ese campo existe en
  # el dataclass pero /v1/chat/completions nunca lo lee; server/routes.py
  # arma el prompt de identidad exclusivamente desde default_system_prompt,
  # confirmado leyendo el codigo) existe porque sin el, el modelo no sabe
  # que los datos de las empresas viven en esta base de Supabase -- ante un
  # nombre de empresa que no reconoce (ej. mal escrito) o una pregunta de
  # negocio, respondia como si fuera una compania publica externa y mandaba
  # a buscar en internet, en vez de usar list_tables/execute_sql.
  # max_turns sube de 10 (default) a 24 porque con un modelo chico/barato
  # como gpt-5-nano, una pregunta que necesita varios pasos de herramientas
  # (list_tables, varios execute_sql) puede agotar el limite de turnos antes
  # de escribir la respuesta final -- el pedido termina en 200 OK pero con
  # el mensaje vacio.
  cat > "$HOME/.openjarvis/config.toml" <<TOML
[server]
model = "${OPENJARVIS_DEFAULT_MODEL:-gpt-4o-mini}"

[speech]
backend = "openai"

[agent]
max_turns = 24
default_system_prompt = """
Sos JARVIS, el asistente de IA del panel de superadministracion de INKAL, una plataforma SaaS multiempresa para el sector agricola. Tenes acceso en tiempo real a la base de datos de Supabase de INKAL a traves de herramientas MCP (list_tables, execute_sql, get_advisors, get_logs, etc.) en modo solo lectura.

Reglas importantes:
- Los datos de las empresas (ventas, ingresos, trabajadores, inventario, etc.) SIEMPRE viven en esa base de datos, nunca en internet ni en sitios web publicos. Nunca sugieras buscar informacion de una empresa en su "sitio web oficial", en "informes financieros" o en "plataformas de noticias economicas" -- esas empresas son clientes internos de INKAL, no companias publicas independientes.
- Antes de decir que no tenes un dato, explora el esquema con list_tables y proba un execute_sql razonable sobre las tablas que parezcan relevantes. Recien despues de intentarlo de verdad decis que no encontraste el dato, citando que tablas revisaste.
- Los nombres de empresa pueden llegar mal escritos o con variantes (por ejemplo "Incalla", "Inkal", "INKAL S.A.") -- busca coincidencias parecidas en la tabla de empresas en vez de asumir que es una empresa externa desconocida.
- Responde siempre en espanol, de forma clara y concisa, citando los numeros reales que encontraste en la base de datos.
"""

[tools.mcp]
enabled = true
servers = '[{"name":"supabase","url":"https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true","token":"${SUPABASE_ACCESS_TOKEN}","include_tools":["list_tables","list_extensions","list_migrations","execute_sql","get_logs","get_advisors","get_project_url","get_publishable_keys","generate_typescript_types","list_edge_functions","get_edge_function","list_branches"]}]'
TOML
fi

exec jarvis "$@"
