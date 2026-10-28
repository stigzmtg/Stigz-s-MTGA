// Run `fn` in a moment. A hidden tab's timers are slowed to once a second, and after a few minutes hidden to once a
// minute, which would stretch every move of a friends' game that passes through that tab (a friend looking at
// another tab, a host whose computer players move while it's in the background). A message the page posts to
// itself isn't slowed, so hidden pages use that instead.
export const pageHidden = () => typeof document !== 'undefined' && !!document.hidden;
export function soon(fn, ms) {
  if (pageHidden() && typeof MessageChannel !== 'undefined') {
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); fn(); };
    c.port2.postMessage(0);
    return;
  }
  setTimeout(fn, ms);
}
