/* SweetAlert2 popups: the confirm dialog, the 3-second toasts and the error / "Use Here" dialogs. */
(function (AB) {
  'use strict';

  const { $$, isVisible } = AB.dom;
  const norm = AB.normText;
  const ICONS = ['question', 'success', 'error', 'warning', 'info'];

  function classify(d) {
    const t = `${d.title} ${d.text}`;
    if (/Do you want to add this section/i.test(t)) return 'add-confirm';
    if (/open in another window/i.test(t)) return 'use-here';
    if (/system state has been updated/i.test(t)) return 'system-updated';
    if (/Advising data has changed/i.test(t)) return 'data-changed';
    if (/won'?t be able to change your courses/i.test(t)) return 'confirm-advising';
    if (d.toast) return d.icon === 'success' ? 'success-toast' : `${d.icon || 'plain'}-toast`;
    if (d.icon === 'question') return 'question'; // e.g. the server's repeat / retake prompt
    if (d.icon === 'error') return 'error';
    return 'notice';
  }

  function describe(el) {
    const button = (sel) => {
      const b = el.querySelector(sel);
      return b && isVisible(b) ? b : null;
    };
    const d = {
      el,
      toast: el.classList.contains('swal2-toast'),
      icon: ICONS.find((i) => el.classList.contains(`swal2-icon-${i}`)) || null,
      title: norm(el.querySelector('.swal2-title')?.textContent),
      text: norm(el.querySelector('.swal2-html-container')?.textContent),
      confirm: button('.swal2-confirm'),
      cancel: button('.swal2-cancel'),
    };
    d.kind = classify(d);
    return d;
  }

  const openPopups = () =>
    $$('.swal2-container .swal2-popup').filter((p) => !p.classList.contains('swal2-hide') && isVisible(p));

  // The popup that is open now (a closing one has .swal2-hide).
  function current() {
    const el = openPopups()[0];
    return el ? describe(el) : null;
  }

  // Remember every popup that appears: toasts close by themselves after 3 s.
  const seen = [];
  const recorded = new WeakMap();
  let started = false;
  function record() {
    for (const el of openPopups()) {
      const d = describe(el);
      const key = `${d.kind}|${d.title}|${d.text}`;
      if (recorded.get(el) === key) continue;
      recorded.set(el, key);
      seen.push({ at: Date.now(), kind: d.kind, toast: d.toast, icon: d.icon, title: d.title, text: d.text });
      if (seen.length > 200) seen.shift();
      AB.runner?.note(`Popup [${d.kind}]: ${d.title || d.text}`);
    }
  }
  function start() {
    if (started) return;
    started = true;
    new MutationObserver(record).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    record();
  }
  const since = (t, pred = () => true) => {
    record();
    return seen.filter((e) => e.at >= t && pred(e));
  };

  async function answer(d, which, signal) {
    const btn = which === 'confirm' ? d.confirm : d.cancel;
    if (!btn) throw new AB.dom.BotError(`The popup "${d.title || d.text}" has no ${which} button`);
    btn.click();
    await AB.dom
      .waitFor(() => !d.el.isConnected || d.el.classList.contains('swal2-hide') || !isVisible(d.el), {
        timeout: 5000,
        signal,
        what: 'the popup to close',
      })
      .catch((e) => {
        if (e.name === 'AbortError') throw e;
      });
  }

  AB.swal = { current, since, start, answer, classify };
})(globalThis.AB);
