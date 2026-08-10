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
  # [intelligence] max_tokens sube de 1024 (default) a 4096 -- gpt-5-nano
  # narra en texto plano lo que va a hacer ("Voy a consultar la
  # estructura...") antes de llamar a las herramientas, y con 1024 se
  # quedaba sin espacio a mitad de esa narracion (respuesta cortada a la
  # mitad, no vacia). La regla extra del prompt pidiendole que sea directo
  # ataca la causa; subir el limite es la red de seguridad.
  #
  # max_turns y max_tokens quedan detras de variables de entorno (con estos
  # valores como default) para poder ajustarlos despues sin tocar codigo --
  # cambiar la variable en EasyPanel y reiniciar el servicio alcanza, no
  # hace falta un rebuild de imagen (que es lo que tarda los ~4 minutos).
  # [analytics] enabled=false apaga la telemetria anonima de uso que
  # OpenJarvis manda a su propio servidor (34.231.106.201.sslip.io) --
  # ese host no es alcanzable desde esta red, asi que cada intento se
  # quedaba esperando 15 segundos antes de fallar (visible en los logs
  # como "error uploading ... connect timeout=15"). No aporta nada aca
  # (el dato nunca llega) y esos 15 segundos perdidos, si coinciden con
  # un pedido de chat, contribuyen a la demora percibida.
  # El mapa de tablas en default_system_prompt (mas abajo) es la mejora mas
  # grande de velocidad/costo: antes, CADA pregunta hacia que el agente
  # redescubriera el esquema desde cero via list_tables (mas turnos, mas
  # tokens, mas segundos reales). Con el inventario real de las 51 tablas
  # ya en el prompt (pedido a Jarvis mismo, no inventado), se salta ese
  # paso de descubrimiento y va directo a execute_sql. Si la base cambia
  # de forma importante (tablas nuevas, renombradas), este mapa hay que
  # actualizarlo a mano -- no se regenera solo.
  cat > "$HOME/.openjarvis/config.toml" <<TOML
[server]
model = "${OPENJARVIS_DEFAULT_MODEL:-gpt-4o-mini}"

[analytics]
enabled = false

[speech]
backend = "openai"

[intelligence]
max_tokens = ${OPENJARVIS_MAX_TOKENS:-4096}

[agent]
max_turns = ${OPENJARVIS_MAX_TURNS:-24}
default_system_prompt = """
Sos JARVIS, el asistente de IA del panel de superadministracion de INKAL, una plataforma SaaS multiempresa para el sector agricola. Tenes acceso en tiempo real a la base de datos de Supabase de INKAL a traves de herramientas MCP (list_tables, execute_sql, get_advisors, get_logs, etc.) en modo solo lectura.

Mapa de tablas conocidas del esquema publico (51 tablas) -- ya las tenes mapeadas, NO llames a list_tables para descubrirlas de nuevo, eso solo gasta pasos y tiempo. Andate directo a la tabla correcta con execute_sql; si necesitas confirmar las columnas exactas de una tabla especifica antes de armar la consulta final, consulta information_schema.columns para esa tabla puntual (mas barato que list_tables completo):
- Empresas/plataforma: companies, organizations, memberships, company_roles, company_role_permissions, global_role_permissions, platform_admins, company_integrations, company_bot_channels, company_tax_profiles, company_documents, company_alert_recipients
- Ventas: inkal_sales_lines, inkal_sales_import_runs, inkal_sales_quality_issues, inkal_vendedor_status_override, sales_pipeline, sales_targets, sales_targets_by_product, sales_targets_import_runs, client_pipeline, competitive_arguments, consultora_cards
- Facturacion electronica: fe_clients, fe_documents, fe_document_items, fe_document_logs, fe_series
- Gastos: expense_liquidations, expense_import_runs
- Inventario y productos: inventory, products, product_details, product_documents, providers
- Trabajadores/RRHH: workers, rtc_workers, worker_documents, worker_document_alerts_sent
- Agricola/campo: fundos, crop_calendar, phenological_stages, trials, visits
- Otros: bot_sessions, calendar_activities, failed_sends, social_media_assets, powerbi_import_runs, powerbi_raw_tables, powerbi_raw_rows

Reglas importantes:
- Los datos de las empresas (ventas, ingresos, trabajadores, inventario, etc.) SIEMPRE viven en esa base de datos, nunca en internet ni en sitios web publicos. Nunca sugieras buscar informacion de una empresa en su "sitio web oficial", en "informes financieros" o en "plataformas de noticias economicas" -- esas empresas son clientes internos de INKAL, no companias publicas independientes.
- Antes de decir que no tenes un dato, proba un execute_sql razonable sobre las tablas del mapa de arriba que parezcan relevantes. Recien despues de intentarlo de verdad decis que no encontraste el dato, citando que tablas revisaste.
- Los nombres de empresa pueden llegar mal escritos o con variantes (por ejemplo "Incalla", "Inkal", "INKAL S.A.") -- busca coincidencias parecidas en la tabla companies en vez de asumir que es una empresa externa desconocida.
- Responde siempre en espanol, de forma clara y concisa, citando los numeros reales que encontraste en la base de datos.
- No narres en texto lo que vas a hacer ("voy a consultar...", "ejecutando...") -- llama a las herramientas directamente y recien escribi texto cuando tengas la respuesta final para el usuario.
"""

[tools.mcp]
enabled = true
servers = '[{"name":"supabase","url":"https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true","token":"${SUPABASE_ACCESS_TOKEN}","include_tools":["list_tables","list_extensions","list_migrations","execute_sql","get_logs","get_advisors","get_project_url","get_publishable_keys","generate_typescript_types","list_edge_functions","get_edge_function","list_branches"]}]'
TOML
fi

exec jarvis "$@"
