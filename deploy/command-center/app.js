(() => {
  // Si esta pagina ya esta controlada por un service worker (el viejo, de
  // la SPA nativa de OpenJarvis, con precache agresivo via Workbox), hay
  // que re-registrar para que el navegador chequee /sw.js, note el cambio
  // e instale el que se autodestruye -- sin controller no hace falta
  // (evita un loop de registro-desregistro-registro en cada carga).
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const API_KEY_STORAGE = 'jarvis-command-center-api-key';
  let apiKey = localStorage.getItem(API_KEY_STORAGE) || '';
  let serverModel = '';
  let messages = [];
  let mediaRecorder = null;
  let audioChunks = [];

  const $ = (id) => document.getElementById(id);

  function authHeaders(extra) {
    return { Authorization: `Bearer ${apiKey}`, ...(extra || {}) };
  }

  async function api(path, options) {
    const res = await fetch(path, {
      ...options,
      headers: authHeaders(options && options.headers),
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  // ---- auth ----
  function showAuth(message) {
    $('auth-overlay').classList.remove('hidden');
    $('app').classList.add('hidden');
    $('auth-error').textContent = message || '';
  }

  function hideAuth() {
    $('auth-overlay').classList.add('hidden');
    $('app').classList.remove('hidden');
  }

  $('auth-submit').addEventListener('click', () => {
    const value = $('auth-input').value.trim();
    if (!value) return;
    apiKey = value;
    localStorage.setItem(API_KEY_STORAGE, apiKey);
    boot();
  });
  $('auth-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('auth-submit').click();
  });

  // ---- clock ----
  function tickClock() {
    const now = new Date();
    $('clock').textContent = now.toLocaleString('es-PE', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  }

  // ---- status ----
  function setStatus(ok, text) {
    $('status-dot').className = 'dot ' + (ok ? 'ok' : 'err');
    $('status-text').textContent = text;
  }

  // ---- panels ----
  async function loadInfo() {
    const info = await api('/v1/info');
    serverModel = info.model || '';
    $('info-engine').textContent = info.engine || '—';
    $('info-model').textContent = info.model || '—';
    $('info-agent').textContent = info.agent || '—';
    setStatus(true, `${info.engine || 'cloud'} / ${info.model || '?'}`);
  }

  async function loadAgents() {
    const data = await api('/v1/agents');
    const registered = data.registered || [];
    const runningKeys = new Set((data.running || []).map((r) => r.key || r.agent_type));
    const activeAgent = $('info-agent').textContent;
    $('agents-list').innerHTML = registered
      .map((a) => {
        const isActive = a.key === activeAgent || runningKeys.has(a.key);
        return `<span class="tag${isActive ? ' active' : ''}">${a.key}</span>`;
      })
      .join('') || '—';
  }

  // Los aros son solo un efecto visual -- no hay un "maximo" real de pedidos
  // o tokens, asi que se escalan contra un techo arbitrario nada mas para
  // que el anillo se llene progresivamente en una sesion normal.
  function setRing(id, value, ceiling) {
    const pct = Math.max(4, Math.min(100, (value / ceiling) * 100));
    const el = $(id);
    if (el) el.style.setProperty('--pct', pct.toFixed(0));
  }

  async function loadTelemetry() {
    try {
      const stats = await api('/v1/telemetry/stats');
      const requests = stats.total_requests ?? 0;
      const tokens = stats.total_tokens ?? 0;
      $('stat-requests').textContent = requests;
      $('stat-tokens').textContent = tokens;
      setRing('ring-requests', requests, 20);
      setRing('ring-tokens', tokens, 5000);
    } catch {
      /* telemetry is best-effort */
    }
    try {
      const energy = await api('/v1/telemetry/energy');
      const power = energy.avg_power_w || 0;
      $('stat-power').textContent = `${power.toFixed(1)}W`;
      setRing('ring-power', power, 50);
    } catch {
      /* best-effort */
    }
  }

  async function loadMemory() {
    try {
      const mem = await api('/v1/memory/stats');
      $('memory-status').textContent =
        mem.status === 'not_configured'
          ? 'No configurada'
          : `${mem.entries ?? 0} entradas (${mem.backend || 'desconocido'})`;
    } catch {
      $('memory-status').textContent = 'No disponible';
    }
  }

  async function loadSkills() {
    try {
      const data = await api('/v1/skills');
      const skills = Array.isArray(data) ? data : data.skills || [];
      $('tools-list').innerHTML = skills.length
        ? skills.map((s) => `<span class="tag active">${s.name || s}</span>`).join('')
        : '<span class="tag">Ninguna instalada</span>';
    } catch {
      $('tools-list').innerHTML = '<span class="tag">No disponible</span>';
    }
  }

  function refreshPanels() {
    loadAgents().catch(() => {});
    loadTelemetry().catch(() => {});
    loadMemory().catch(() => {});
    loadSkills().catch(() => {});
  }

  // ---- chat ----
  function appendMessage(role, text, pending) {
    const log = $('chat-log');
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = `msg ${role}${pending ? ' pending' : ''}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  async function sendMessage(text) {
    if (!text.trim()) return;
    appendMessage('user', text);
    messages.push({ role: 'user', content: text });
    $('chat-input').value = '';
    const pendingEl = appendMessage('assistant', 'Pensando...', true);

    try {
      // stream:false a proposito -- el servidor solo corre el agente con
      // herramientas (MCP de Supabase incluido) en pedidos sin streaming.
      const completion = await api('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: serverModel || 'gpt-4o-mini',
          messages,
          stream: false,
        }),
      });
      const content = completion.choices?.[0]?.message?.content || '(sin respuesta)';
      pendingEl.textContent = content;
      pendingEl.classList.remove('pending');
      messages.push({ role: 'assistant', content });
    } catch (err) {
      pendingEl.textContent = 'Error al responder: ' + err.message;
      pendingEl.classList.remove('pending');
    }

    loadTelemetry().catch(() => {});
  }

  $('send-btn').addEventListener('click', () => sendMessage($('chat-input').value));
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($('chat-input').value);
    }
  });
  $('new-chat-btn').addEventListener('click', () => {
    messages = [];
    $('chat-log').innerHTML = '<div class="chat-empty">Nueva conversación.</div>';
  });

  // ---- mic ----
  // El boton del chat y la barra flotante "Hablar con Jarvis" son dos
  // entradas para la misma accion -- se mantienen sincronizados.
  function setRecordingUI(recording) {
    $('mic-btn').classList.toggle('recording', recording);
    $('talk-btn').classList.toggle('recording', recording);
    $('talk-label').textContent = recording ? 'Escuchando...' : 'Hablar con Jarvis';
  }

  async function toggleMic() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      appendMessage('assistant', 'No se pudo acceder al micrófono.', false);
      return;
    }
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      setRecordingUI(false);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const form = new FormData();
      form.append('file', blob, 'recording.webm');
      try {
        const res = await fetch('/v1/speech/transcribe', {
          method: 'POST',
          headers: authHeaders(),
          body: form,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data.text) {
          $('chat-input').value = data.text;
          sendMessage(data.text);
        }
      } catch (err) {
        appendMessage('assistant', 'No se pudo transcribir el audio: ' + err.message, false);
      }
    };
    mediaRecorder.start();
    setRecordingUI(true);
  }

  $('mic-btn').addEventListener('click', toggleMic);
  $('talk-btn').addEventListener('click', toggleMic);

  // ---- boot ----
  async function boot() {
    if (!apiKey) {
      showAuth();
      return;
    }
    try {
      await loadInfo();
    } catch {
      showAuth('API key inválida o servidor no disponible.');
      return;
    }
    hideAuth();
    refreshPanels();
    setInterval(refreshPanels, 15000);
  }

  tickClock();
  setInterval(tickClock, 1000);
  boot();
})();
