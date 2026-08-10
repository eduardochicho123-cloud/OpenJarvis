(() => {
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

  async function loadTelemetry() {
    try {
      const stats = await api('/v1/telemetry/stats');
      $('stat-requests').textContent = stats.total_requests ?? 0;
      $('stat-tokens').textContent = stats.total_tokens ?? 0;
    } catch {
      /* telemetry is best-effort */
    }
    try {
      const energy = await api('/v1/telemetry/energy');
      $('stat-power').textContent = `${(energy.avg_power_w || 0).toFixed(1)} W`;
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
  async function toggleMic() {
    const btn = $('mic-btn');
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
      btn.classList.remove('recording');
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
    btn.classList.add('recording');
  }

  $('mic-btn').addEventListener('click', toggleMic);

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
