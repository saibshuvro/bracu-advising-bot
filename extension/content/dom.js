/* Generic DOM helpers used by the content scripts. */
(function (AB) {
  'use strict';

  class BotError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'BotError';
      this.code = code;
    }
  }

  const abortError = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Resolves with the first truthy value of predicate(), re-checked on every DOM change and every `interval` ms.
  function waitFor(predicate, { timeout = 10000, interval = 100, signal, what = 'the page' } = {}) {
    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;
      let poll = null;
      let timer = null;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, abortError());
      const check = () => {
        if (done) return;
        let value;
        try {
          value = predicate();
        } catch (e) {
          return finish(reject, e);
        }
        if (value) finish(resolve, value);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      poll = setInterval(check, interval);
      if (timeout !== Infinity) {
        timer = setTimeout(() => finish(reject, new BotError(`Timed out waiting for ${what}`, 'timeout')), timeout);
      }
      check();
    });
  }

  // Resolves once `root` has had no rows added or removed for quietMs, or after maxMs regardless.
  function waitForQuiet(root, { quietMs = 500, maxMs = 3000, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!root) return resolve({ quiet: true });
      if (signal?.aborted) return reject(abortError());
      const start = Date.now();
      let last = start;
      let done = false;
      const observer = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.type === 'childList')) last = Date.now();
      });
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poll);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, abortError());
      observer.observe(root, { childList: true, subtree: true });
      const poll = setInterval(() => {
        const now = Date.now();
        if (now - last >= quietMs) finish(resolve, { quiet: true });
        else if (now - start >= maxMs) finish(resolve, { quiet: false });
      }, 50);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function click(el) {
    el.click();
  }

  // Works with Angular/React/Vue bindings: use the native setter, then fire the events a user would.
  function setInputValue(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  AB.dom = { $, $$, isVisible, sleep, waitFor, waitForQuiet, click, setInputValue, BotError, abortError };
})(globalThis.AB);
