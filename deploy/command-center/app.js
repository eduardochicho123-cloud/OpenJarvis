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
  let currentSpeechAudio = null;

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

  // ---- orb state ----
  // La esfera es la interfaz principal: idle (nada pasando), listening
  // (grabando el microfono), thinking (esperando la respuesta del modelo) y
  // speaking (reproduciendo la voz de Jarvis). El texto sigue existiendo,
  // pero como bitacora secundaria en el costado, no como protagonista.
  function setOrbState(state, label) {
    const orb = $('orb');
    orb.classList.remove('state-listening', 'state-thinking', 'state-speaking');
    if (state !== 'idle') orb.classList.add(`state-${state}`);
    const statusEl = $('orb-status');
    statusEl.className = 'orb-status' + (state !== 'idle' ? ` ${state}` : '');
    statusEl.textContent = label || '';
  }

  // ---- audio amplitude (hace que la esfera reaccione en vivo al volumen
  // real del microfono o de la voz de Jarvis, en vez de una animacion fija) ----
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  let ampRAF = null;
  function startAmplitudeLoop(analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const orb = $('orb');
    function tick() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      orb.style.setProperty('--orb-amp', Math.min(1, rms * 4).toFixed(3));
      ampRAF = requestAnimationFrame(tick);
    }
    tick();
  }
  function stopAmplitudeLoop() {
    if (ampRAF) cancelAnimationFrame(ampRAF);
    ampRAF = null;
    $('orb').style.setProperty('--orb-amp', '0');
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

  // Si llega una respuesta nueva mientras la anterior todavia esta
  // hablando (dos mensajes seguidos, o texto + voz casi al mismo tiempo),
  // sin esto quedaban dos <audio> reproduciendo en paralelo -- Jarvis
  // hablando dos veces a la vez, sin forma de callarlo.
  function stopCurrentSpeech() {
    if (!currentSpeechAudio) return;
    const { audioEl, finish } = currentSpeechAudio;
    currentSpeechAudio = null;
    audioEl.onended = null;
    audioEl.onerror = null;
    audioEl.pause();
    finish();
  }

  async function speak(text) {
    // A diferencia de antes, un fallo aca SI se muestra en el chat -- la voz
    // fallaba en silencio y no habia forma de saber por que sin revisar los
    // logs del servidor cada vez.
    //
    // Reproduccion simple (sin Web Audio API / AnalyserNode): un intento
    // anterior ruteaba el audio por un AudioContext para que la esfera
    // reaccionara al volumen real, pero eso fallaba con "audio error (code
    // 4)" -- MEDIA_ERR_SRC_NOT_SUPPORTED -- ademas de sumar una fuente mas
    // de fallos silenciosos. El pulso de la esfera ahora es sintetico
    // (basado en el tiempo de reproduccion), no en el volumen real.
    stopCurrentSpeech();

    let playError = null;
    let blob = null;
    let audioEl = null;
    try {
      const res = await fetch('/v1/speech/synthesize', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      blob = await res.blob();
      if (!blob.size) throw new Error('la respuesta llego vacia (0 bytes)');

      const url = URL.createObjectURL(blob);
      audioEl = new Audio(url);
      const orb = $('orb');
      const pulse = () => {
        const amp = 0.4 + 0.4 * Math.abs(Math.sin(audioEl.currentTime * 6));
        orb.style.setProperty('--orb-amp', amp.toFixed(3));
      };
      audioEl.addEventListener('timeupdate', pulse);

      setOrbState('speaking', 'Hablando...');

      // "No soportado" puede llegar por dos caminos distintos -- el evento
      // "error" del elemento, o el rechazo de play() -- segun el navegador y
      // el timing. Los dos casos usan el mismo diagnostico de bytes crudos
      // para no perder la pista la proxima vez.
      const describeBlob = async () => {
        try {
          const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
          const hex = Array.from(head)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          const text = (await blob.slice(0, 200).text()).replace(/\s+/g, ' ');
          return ` hex[${hex}] text[${text.slice(0, 150)}]`;
        } catch {
          return '';
        }
      };

      await new Promise((resolve) => {
        currentSpeechAudio = { audioEl, finish: resolve };
        audioEl.onended = resolve;
        audioEl.onerror = async () => {
          const code = audioEl.error ? audioEl.error.code : '?';
          const preview = await describeBlob();
          playError = `audio error (code ${code}, blob ${blob.size}b/${blob.type})${preview}`;
          resolve();
        };
        audioEl.play().catch(async (err) => {
          const preview = await describeBlob();
          playError = `${err.name}: ${err.message} (blob ${blob.size}b/${blob.type})${preview}`;
          resolve();
        });
      });
      URL.revokeObjectURL(url);
    } catch (err) {
      playError = err.message || String(err);
    } finally {
      if (currentSpeechAudio && currentSpeechAudio.audioEl === audioEl) {
        currentSpeechAudio = null;
      }
      orbAmpReset();
      setOrbState('idle', '');
    }
    if (playError) {
      appendMessage('assistant', `(No se pudo reproducir la voz: ${playError})`, false);
    }
  }

  function orbAmpReset() {
    $('orb').style.setProperty('--orb-amp', '0');
  }

  async function sendMessage(text) {
    if (!text.trim()) return;
    // Cortar cualquier voz que siga sonando apenas el usuario inicia una
    // interaccion nueva -- antes esto solo se hacia dentro de speak(),
    // justo antes de reproducir la respuesta nueva, asi que Jarvis seguia
    // hablando durante todo el tiempo que tardaba en pensar la siguiente.
    stopCurrentSpeech();
    appendMessage('user', text);
    messages.push({ role: 'user', content: text });
    $('chat-input').value = '';
    const pendingEl = appendMessage('assistant', 'Pensando...', true);
    setOrbState('thinking', 'Pensando...');

    let content = null;
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
      // Un modelo chico puede agotar sus turnos de herramientas sin llegar a
      // escribir una respuesta final -- el pedido sale 200 OK igual, asi que
      // content queda vacio. El texto "(sin respuesta)" es solo para
      // mostrar en pantalla; no se manda a la voz (antes Jarvis literalmente
      // "decia" esas palabras).
      content = completion.choices?.[0]?.message?.content || '';
      pendingEl.textContent = content || '(sin respuesta)';
      pendingEl.classList.remove('pending');
      messages.push({ role: 'assistant', content: content || '(sin respuesta)' });
    } catch (err) {
      pendingEl.textContent = 'Error al responder: ' + err.message;
      pendingEl.classList.remove('pending');
      setOrbState('idle', '');
    }

    loadTelemetry().catch(() => {});

    if (content) {
      await speak(content);
    } else {
      // Sin esto, si content vino vacio (ver comentario arriba) speak()
      // nunca se llama y la esfera se queda trabada en "Pensando...".
      setOrbState('idle', '');
    }
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
    $('chat-log').innerHTML = '<div class="chat-empty">Sin mensajes todavía.</div>';
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
    // Apretar el microfono para hablar de nuevo corta a Jarvis en el acto,
    // en vez de esperar a que termine de decir lo que estaba diciendo.
    stopCurrentSpeech();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      appendMessage(
        'assistant',
        'Este navegador no expone navigator.mediaDevices.getUserMedia en este contexto (revisar si la pagina se sirve por HTTPS y si hay alguna politica/extension bloqueandolo).',
        false,
      );
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      appendMessage(
        'assistant',
        `No se pudo acceder al micrófono -- ${err.name}: ${err.message}`,
        false,
      );
      return;
    }

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const micSource = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    micSource.connect(analyser);
    setOrbState('listening', 'Escuchando...');
    startAmplitudeLoop(analyser);

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      setRecordingUI(false);
      stopAmplitudeLoop();
      micSource.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      setOrbState('thinking', 'Transcribiendo...');

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
        } else {
          setOrbState('idle', '');
        }
      } catch (err) {
        appendMessage('assistant', 'No se pudo transcribir el audio: ' + err.message, false);
        setOrbState('idle', '');
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
