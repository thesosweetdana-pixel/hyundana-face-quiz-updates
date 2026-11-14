/* Current local studio -> OBS public-only bridge. Does not send source project, answers or private notes. */
(() => {
  'use strict';
  const statusEl = document.getElementById('obsRelayIndicator');
  const openBtn = document.getElementById('obsOpen');
  const copyBtn = document.getElementById('obsCopy');
  const takeoverBtn = document.getElementById('obsTakeover');
  const obsUrl = `${location.origin}/obs`;
  const session = `studio-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  let nextSeq = 0;
  let latest = null;
  let sending = false;
  let lastGood = 0;
  let conflict = false;
  let lease = null;
  function keepControllerAlive() {
    if (lease || !('EventSource' in window)) return;
    // The local server refreshes the controller lease while the browser connection is open.
    // This avoids background-tab timer throttling while OBS is used alongside games.
    lease = new EventSource(`/api/lease?session=${encodeURIComponent(session)}`);
    lease.onmessage = async (event) => {
      if (event.data !== 'ping') return;
      try {
        await fetch('/api/ping', {method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({session}), cache:'no-store'});
      } catch (_) { /* main public-state heartbeat remains as fallback */ }
    };
  }
  window.addEventListener('pagehide', () => {
    if (lease) lease.close();
    try { void fetch('/api/release',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session}),keepalive:true,cache:'no-store'}); } catch (_) {}
  });
  function label(message, color = '#52627d') {
    if (statusEl) { statusEl.textContent = message; statusEl.style.color = color; }
    if (takeoverBtn) takeoverBtn.hidden = !conflict;
  }
  if (!/^https?:$/.test(location.protocol) || location.hostname !== '127.0.0.1') {
    label('OBS 연결은 실행 파일로 로컬 서버를 시작했을 때만 사용할 수 있어요.', '#bb4874');
    return;
  }
  if (openBtn) openBtn.addEventListener('click', () => window.open(obsUrl, '_blank', 'noopener'));
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(obsUrl); label('OBS 주소가 복사됐어요. OBS 브라우저 소스에 붙여넣으세요.', '#277f68'); }
    catch (_) { window.prompt('아래 OBS 주소를 복사해 주세요:', obsUrl); }
  });
  if (takeoverBtn) takeoverBtn.addEventListener('click', async () => {
    if (!window.confirm('다른 진행실의 OBS 송출 제어권을 가져올까요? 출력은 안전 화면으로 초기화됩니다.')) return;
    try {
      const r = await fetch('/api/takeover', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({session}), cache: 'no-store' });
      if (!r.ok) throw new Error('takeover failed');
      conflict = false;
      label('송출 제어권을 가져왔어요. 연결 상태 확인 중…', '#52627d');
      enqueue(window.HyundanaShowAdapter?.getPublicState());
    } catch (error) { label('제어권 변경 실패: 로컬 서버를 확인하세요.', '#bd4545'); }
  });

  function enqueue(state) {
    if (!state || typeof state !== 'object') return;
    latest = state;
    if (!sending) void flush();
  }
  async function flush() {
    sending = true;
    while (latest) {
      const payload = latest;
      latest = null;
      const seq = nextSeq++;
      try {
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), 5000);
        let response;
        try {
          response = await fetch('/api/public', {
            method:'POST', headers: {'Content-Type':'application/json'},
            body:JSON.stringify({session, seq, state:payload}),
            cache:'no-store', signal:ac.signal
          });
        } finally { clearTimeout(timeout); }
        if (response.status === 409) {
          conflict = true;
          if (lease) {lease.close(); lease = null;}
          label('다른 진행실이 송출 제어 중 · 이 창은 OBS에 반영되지 않습니다.', '#b24c39');
          break;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        conflict = false;
        keepControllerAlive();
        const acknowledged = await response.json();
        lastGood = Date.now();
        // External viewers receive only the exact scene accepted by the local OBS owner.
        // Inactive/stale studio tabs cannot overwrite the remote scene.
        window.dispatchEvent(new CustomEvent('hyundana:local-public-committed',
          {detail:{state:payload,revision:acknowledged.revision,session}}));
        label('OBS 로컬 연결 정상 · 진행실 공개 정보만 전달 중', '#207b63');
      } catch (err) {
        label('OBS 연결 끊김 · 서버 실행 여부를 확인하세요.', '#be4b4b');
        break;
      }
    }
    sending = false;
  }
  window.addEventListener('hyundana:public-screen', (ev) => enqueue(ev.detail));
  // A manual spectator Connect can request an immediate local commit; never bypass ownership.
  window.addEventListener('hyundana:request-public-commit', () => {
    if (!conflict) enqueue(window.HyundanaShowAdapter?.getPublicState());
  });
  setInterval(() => {
    if (!conflict) enqueue(window.HyundanaShowAdapter?.getPublicState());
  }, 2500);
  // The old studio script emits its initial public screen event before bridge.js loads.
  enqueue(window.HyundanaShowAdapter?.getPublicState());
})();
