// Voice/video calling via WebRTC. Media is peer-to-peer; call setup (offer/
// answer/ICE) is exchanged through the app API by short polling. Loaded on the
// board and chat pages: it rings for incoming calls app-wide and exposes
// window.TLCall.start(peerId, peerName, kind) for placing calls.
'use strict';
(function () {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  // Optional TURN for locked-down networks: set window.TL_TURN = { urls, username, credential } before this script.
  if (window.TL_TURN) ICE.iceServers.push(window.TL_TURN);

  let cur = null;           // active call state
  let ringing = null;       // incoming call being offered
  const seen = new Set();   // call ids already handled (declined/ended/answered)

  const api = async (path, opts = {}) => {
    const res = await fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json().catch(() => ({}));
  };
  const initials = n => (n || '?').trim().charAt(0).toUpperCase();

  // ---- overlay ----
  let el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = '__tlcall__';
    const root = el.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .bg { position: fixed; inset: 0; z-index: 2147483000; background: #14110B; color: #fff; display: none;
          font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; flex-direction: column; align-items: center; justify-content: center; }
        .bg.on { display: flex; }
        video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #14110B; }
        #local { position: absolute; width: 168px; height: 118px; right: 18px; bottom: 96px; inset: auto 18px 96px auto;
          border-radius: 12px; border: 2px solid rgba(255,255,255,.25); object-fit: cover; z-index: 2; background:#000; }
        .center { position: relative; z-index: 2; text-align: center; }
        .av { width: 96px; height: 96px; border-radius: 28px; background: #B4471F; display: flex; align-items: center; justify-content: center;
          font-size: 40px; font-weight: 700; margin: 0 auto 16px; }
        .name { font-size: 22px; font-weight: 600; }
        .status { font-size: 14px; opacity: .7; margin-top: 6px; }
        .bar { position: absolute; bottom: 26px; left: 0; right: 0; display: flex; gap: 16px; justify-content: center; z-index: 3; }
        .btn { width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer; font-size: 22px; color: #fff; background: rgba(255,255,255,.16); }
        .btn:hover { background: rgba(255,255,255,.26); }
        .btn.off { background: #fff; color: #14110B; }
        .btn.hang { background: #E23B2E; }
        .btn.accept { background: #2FA76A; }
        .hidden { display: none !important; }
      </style>
      <div class="bg" id="bg">
        <video id="remote" autoplay playsinline></video>
        <video id="local" autoplay playsinline muted></video>
        <div class="center" id="poster">
          <div class="av" id="av">?</div>
          <div class="name" id="cname">Someone</div>
          <div class="status" id="cstatus">Calling…</div>
        </div>
        <div class="bar" id="bar-active">
          <button class="btn" id="mic" title="Mute">🎙️</button>
          <button class="btn" id="cam" title="Camera">🎥</button>
          <button class="btn hang" id="hang" title="Hang up">📵</button>
        </div>
        <div class="bar hidden" id="bar-incoming">
          <button class="btn accept" id="accept" title="Accept">📞</button>
          <button class="btn hang" id="reject" title="Decline">📵</button>
        </div>
      </div>`;
    document.documentElement.appendChild(el);
    const $ = s => root.querySelector(s);
    el._$ = $;
    $('#mic').onclick = toggleMic;
    $('#cam').onclick = toggleCam;
    $('#hang').onclick = hangup;
    $('#accept').onclick = () => ringing && acceptIncoming(ringing);
    $('#reject').onclick = () => ringing && declineIncoming(ringing);
    return el;
  }
  const $ = s => ensure()._$(s);
  const show = () => $('#bg').classList.add('on');
  const hide = () => $('#bg').classList.remove('on');
  const setStatus = t => { $('#cstatus').textContent = t; };
  function setPoster(name, kind) {
    $('#av').textContent = initials(name);
    $('#cname').textContent = name || 'Someone';
    // show poster (avatar) for audio or until remote video arrives
    $('#poster').classList.toggle('hidden', false);
  }

  // ---- media / peer ----
  async function getMedia(kind) {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
  }
  function makePc() {
    const pc = new RTCPeerConnection(ICE);
    pc.onicecandidate = e => { if (e.candidate) signal('ice', e.candidate); };
    pc.ontrack = e => {
      const remote = $('#remote');
      if (remote.srcObject !== e.streams[0]) remote.srcObject = e.streams[0];
      $('#poster').classList.add('hidden');
      setStatus('Connected');
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && cur) setStatus('Reconnecting…');
      if (pc.connectionState === 'connected') setStatus('Connected');
    };
    return pc;
  }
  const signal = (type, data) => cur && api(`/api/calls/${cur.callId}/signal`, { method: 'POST', body: { type, data } }).catch(() => {});

  function attachLocal(stream, kind) {
    const local = $('#local');
    local.srcObject = stream;
    local.classList.toggle('hidden', kind !== 'video');
    for (const t of stream.getTracks()) cur.pc.addTrack(t, stream);
  }

  // ---- outgoing ----
  async function start(peerId, peerName, kind) {
    if (cur) return;
    try {
      const call = await api('/api/calls', { method: 'POST', body: { to: peerId, kind } });
      cur = { callId: call.id, role: 'caller', kind, pc: makePc(), stream: null, pendingIce: [], peerName };
      seen.add(call.id);
      setPoster(peerName, kind); setStatus('Ringing…'); show();
      cur.stream = await getMedia(kind);
      attachLocal(cur.stream, kind);
      const offer = await cur.pc.createOffer();
      await cur.pc.setLocalDescription(offer);
      await signal('offer', offer);
      loop();
    } catch (e) { failStart(e); }
  }
  function failStart(e) {
    alert('Could not start the call: ' + (e && e.message || e));
    cleanup(true);
  }

  // ---- incoming ----
  function ringIncoming(call) {
    if (cur || (ringing && ringing.id === call.id)) return;
    ringing = call;
    setPoster(call.peer.name, call.kind);
    setStatus(`Incoming ${call.kind} call…`);
    $('#bar-active').classList.add('hidden');
    $('#bar-incoming').classList.remove('hidden');
    $('#remote').srcObject = null; $('#local').classList.add('hidden');
    show();
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
  }
  async function acceptIncoming(call) {
    ringing = null; seen.add(call.id);
    $('#bar-incoming').classList.add('hidden');
    $('#bar-active').classList.remove('hidden');
    try {
      await api(`/api/calls/${call.id}/accept`, { method: 'POST' });
      cur = { callId: call.id, role: 'callee', kind: call.kind, pc: makePc(), stream: null, pendingIce: [], peerName: call.peer.name };
      setStatus('Connecting…');
      cur.stream = await getMedia(call.kind);
      attachLocal(cur.stream, call.kind);
      loop();
    } catch (e) { failStart(e); }
  }
  async function declineIncoming(call) {
    ringing = null; seen.add(call.id);
    try { await api(`/api/calls/${call.id}/decline`, { method: 'POST' }); } catch {}
    cleanup(true);
  }

  // ---- signal + status loop ----
  function loop() {
    if (!cur) return;
    cur.timer = setInterval(async () => {
      if (!cur) return;
      try {
        const { signals } = await api(`/api/calls/${cur.callId}/signals`);
        for (const s of signals) await handleSignal(s);
        const call = await api(`/api/calls/${cur.callId}`);
        if (call.status === 'declined') { setStatus('Call declined'); return end(false, 1200); }
        if (call.status === 'ended') { setStatus('Call ended'); return end(false, 800); }
      } catch { /* transient */ }
    }, 700);
  }
  async function handleSignal(s) {
    const pc = cur.pc;
    if (s.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(s.data));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await signal('answer', answer);
    } else if (s.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(s.data));
      await flushIce();
    } else if (s.type === 'ice') {
      if (pc.remoteDescription && pc.remoteDescription.type) { try { await pc.addIceCandidate(s.data); } catch {} }
      else cur.pendingIce.push(s.data);
    }
  }
  async function flushIce() {
    for (const c of cur.pendingIce.splice(0)) { try { await cur.pc.addIceCandidate(c); } catch {} }
  }

  // ---- controls ----
  function toggleMic() {
    if (!cur?.stream) return;
    const t = cur.stream.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; $('#mic').classList.toggle('off', !t.enabled);
  }
  function toggleCam() {
    if (!cur?.stream) return;
    const t = cur.stream.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    $('#cam').classList.toggle('off', !t.enabled);
    $('#local').classList.toggle('hidden', !t.enabled);
  }
  async function hangup() {
    if (cur) { try { await api(`/api/calls/${cur.callId}/end`, { method: 'POST' }); } catch {} }
    end(true, 0);
  }
  function end(_local, delay) { setTimeout(() => cleanup(true), delay || 0); }
  function cleanup() {
    if (cur) {
      clearInterval(cur.timer);
      try { cur.pc && cur.pc.close(); } catch {}
      try { cur.stream && cur.stream.getTracks().forEach(t => t.stop()); } catch {}
    }
    cur = null; ringing = null;
    if (el) { $('#remote').srcObject = null; $('#local').srcObject = null; $('#mic').classList.remove('off'); $('#cam').classList.remove('off'); }
    hide();
  }

  // ---- incoming poller (app-wide) ----
  async function pollIncoming() {
    if (cur || ringing) return;
    try {
      const { call } = await api('/api/calls/incoming');
      if (call && !seen.has(call.id)) ringIncoming(call);
    } catch { /* not logged in or offline */ }
  }
  setInterval(pollIncoming, 2500);

  window.TLCall = { start };
})();
