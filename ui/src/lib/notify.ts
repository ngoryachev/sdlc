import type { HilRequest, SdlcEvent } from '@sdlc/shared';

export function requestNotifyPermission() { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); }

export function notifyHil(e: SdlcEvent) {
  const hil = (e.payload as { hil: HilRequest }).hil;
  beep();
  if (!document.hidden) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`sdlc · ${hil.kind}`, { body: `${hil.title}\n${hil.summary}`, tag: hil.id });
    n.onclick = () => { window.focus(); location.hash = ''; history.pushState(null, '', `/hil/${hil.id}`); dispatchEvent(new PopStateEvent('popstate')); };
  }
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
    o.start(); setTimeout(() => { o.stop(); void ctx.close(); }, 150);
  } catch { /* ignore */ }
}

export function setBadge(n: number) { document.title = n ? `(${n}) sdlc` : 'sdlc'; }
