import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const pagePath = new URL('./index.html', import.meta.url);

function readPage() {
  const html = fs.readFileSync(pagePath, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/type\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attributes));
  assert.ok(scripts.length, 'the built page must contain executable inline scripts');
  for (const [, attributes, source] of scripts) {
    assert.doesNotMatch(attributes, /\bsrc\s*=/i, 'startup must not require an external script');
    assert.doesNotMatch(attributes, /\btype\s*=\s*["']module["']/i, 'the entry point must be a classic script');
    assert.ok(source.trim(), 'the inline script must not be empty');
  }
  return { html, scripts: scripts.map(([, , source]) => source) };
}

function createBrowser(html, { legacy = false } = {}) {
  let now = 0;
  let nextTimer = 1;
  let reloads = 0;
  const timers = new Map();
  const frames = new Map();
  const images = [];
  const canvases = [];
  const elements = new Map();
  const windowListeners = new Map();
  const storage = new Map();
  const errors = [];

  class Element {
    constructor(tagName = 'div', id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.isConnected = true;
      this.open = false;
      this.textContent = '';
      this._html = '';
      this._classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this._classes.add(name)),
        remove: (...names) => names.forEach(name => this._classes.delete(name)),
        contains: name => this._classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !this._classes.has(name) : Boolean(force);
          if (on) this._classes.add(name); else this._classes.delete(name);
          return on;
        },
      };
      if (id) elements.set(id, this);
    }
    set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.firstChild; }
    get childNodes() { return this.children; }
    get textContent() { return this._text || ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      this._html = String(value);
      this.textContent = this._html.replace(/<[^>]+>/g, '');
      this.children = [];
      for (const match of this._html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        const id = match[2].match(/\bid=["']([^"']+)["']/i)?.[1];
        if (id) this.appendChild(makeElement(match[1], id, match[2]));
      }
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) {
      node.parentElement = this;
      this.children.push(node);
      return node;
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node.parentElement = null;
      return node;
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'open') this.open = true;
      if (name === 'hidden') this.hidden = true;
      if (name === 'id') { this.id = String(value); elements.set(this.id, this); }
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'open') this.open = false;
      if (name === 'hidden') this.hidden = false;
    }
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    }
    removeEventListener(name, callback) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter(fn => fn !== callback));
    }
    dispatchEvent(event) {
      event.target ||= this;
      event.preventDefault ||= () => {};
      for (const callback of this.listeners.get(event.type) || []) callback.call(this, event);
      this[`on${event.type}`]?.call(this, event);
      return true;
    }
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
    focus() { document.activeElement = this; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      if (selector === 'canvas') return this.querySelectorAll('canvas')[0] || null;
      if (selector === 'span') {
        let child = this.children.find(node => node.tagName === 'SPAN');
        if (!child) { child = new Element('span'); this.appendChild(child); }
        return child;
      }
      return null;
    }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return selector === '*' ? all : all.filter(child => child.tagName === selector.toUpperCase());
    }
    getBoundingClientRect() { return { left: 0, top: 0, right: 330, bottom: 450, width: 330, height: 450 }; }
    setPointerCapture() {}
    hasPointerCapture() { return false; }
    releasePointerCapture() {}
    showModal() { this.open = true; this.setAttribute('open', ''); }
    close() { this.removeAttribute('open'); this.dispatchEvent({ type: 'close' }); }
  }

  class Canvas extends Element {
    constructor(id = '') {
      super('canvas', id);
      this.width = 300;
      this.height = 150;
      this.clientWidth = 0;
      this.clientHeight = 0;
      this.draws = [];
      this.context = { canvas: this, globalAlpha: 1 };
      for (const method of ['save', 'restore', 'translate', 'rotate', 'scale', 'transform', 'setTransform',
        'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
        'ellipse', 'arc', 'quadraticCurveTo', 'bezierCurveTo', 'clip', 'fill', 'stroke', 'fillText',
        'strokeText', 'setLineDash']) this.context[method] = () => {};
      this.context.drawImage = (...args) => this.draws.push(args);
      this.context.measureText = text => ({ width: String(text).length * 8 });
      this.context.getImageData = () => ({ data: new Uint8ClampedArray(4) });
      canvases.push(this);
    }
    getContext(type) { assert.equal(type, '2d'); return this.context; }
    toDataURL() { return 'data:image/png;base64,c3R1Yg=='; }
  }

  function makeElement(tagName, id = '', attributes = '') {
    const element = tagName.toLowerCase() === 'canvas' ? new Canvas(id) : new Element(tagName, id);
    if (/\bdisabled(?:\s|$|=)/.test(attributes)) element.disabled = true;
    if (/\bhidden(?:\s|$|=)/.test(attributes)) element.hidden = true;
    for (const [, name, value] of attributes.matchAll(/([\w-]+)=["']([^"']*)["']/g)) {
      element.setAttribute(name, value);
      if (name === 'width' || name === 'height') element[name] = Number(value);
      if (name === 'class') element.className = value;
    }
    return element;
  }

  const document = new Element('document');
  document.baseURI = 'https://example.cn/bunny-merge/';
  document.hidden = false;
  document.readyState = 'complete';
  document.body = new Element('body');
  document.documentElement = new Element('html');
  document.activeElement = document.body;
  document.getElementById = id => elements.get(id) || null;
  document.createElement = tagName => makeElement(tagName);
  const icon = new Element('link');
  const appleIcon = new Element('link');
  document.querySelector = selector => {
    if (selector.includes('apple-touch-icon')) return appleIcon;
    if (selector.includes('rel="icon"') || selector.includes("rel='icon'")) return icon;
    if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
    return null;
  };
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const [, tagName, attributes] of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = attributes.match(/\bid=["']([^"']+)["']/i)?.[1];
    if (id) makeElement(tagName, id, attributes);
  }
  const initialButton = elements.get('start-button');
  if (initialButton) initialButton.textContent = '兔兔正在赶来…';
  const initialCount = elements.get('collection-count');
  if (initialCount) initialCount.textContent = '…';

  class FakeImage {
    constructor() { this.naturalWidth = this.naturalHeight = 0; images.push(this); }
    set src(value) { this._src = value; }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
    async complete() {
      this.naturalWidth = this.width = 1536;
      this.naturalHeight = this.height = 1024;
      await this.onload?.();
    }
  }

  if (legacy) {
    Element.prototype.replaceChildren = undefined;
    Element.prototype.showModal = undefined;
    Element.prototype.close = undefined;
    Element.prototype.setPointerCapture = undefined;
    Element.prototype.hasPointerCapture = undefined;
    Element.prototype.releasePointerCapture = undefined;
  }
  const sandbox = {
    document,
    Image: FakeImage,
    HTMLElement: Element,
    HTMLCanvasElement: Canvas,
    navigator: { userAgent: 'iPhone test WKWebView', maxTouchPoints: 1 },
    location: { href: document.baseURI, reload: () => { reloads++; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    performance: { now: () => now },
    devicePixelRatio: 2,
    innerWidth: 390,
    innerHeight: 844,
    console: { log() {}, info() {}, warn() {}, error: (...args) => errors.push(args.map(value => value?.stack || String(value)).join(' ')) },
    URL,
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    getComputedStyle: () => ({ width: '330px', height: '450px' }),
    setTimeout: (callback, delay = 0) => {
      const id = nextTimer++;
      timers.set(id, { callback, at: now + Number(delay) });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = nextTimer++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, callback) => {
      const callbacks = windowListeners.get(name) || [];
      callbacks.push(callback);
      windowListeners.set(name, callbacks);
    },
    removeEventListener: (name, callback) => {
      windowListeners.set(name, (windowListeners.get(name) || []).filter(fn => fn !== callback));
    },
  };
  if (!legacy) {
    sandbox.ResizeObserver = class { observe() {} disconnect() {} };
    sandbox.PointerEvent = class {};
  }
  const context = vm.createContext(sandbox);
  vm.runInContext('this.window = this; this.self = this;', context);
  if (legacy) vm.runInContext('Array.prototype.flatMap = undefined; this.globalThis = undefined;', context);

  return {
    context, document, elements, images, canvases, errors,
    get reloads() { return reloads; },
    evaluate: source => vm.runInContext(source, context, { timeout: 5000 }),
    photoDraws: canvas => canvas.draws.filter(args => args[0] instanceof FakeImage).length,
    async flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); },
    async completeImages() { for (const image of images) await image.complete(); await this.flush(); },
    advance(ms) {
      const end = now + ms;
      let iterations = 0;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++iterations < 1000, 'virtual timers must not spin forever');
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
    frame(time = now) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(time));
    },
  };
}

function boot({ legacy = false, watchdogOnly = false } = {}) {
  const { html, scripts } = readPage();
  const browser = createBrowser(html, { legacy });
  for (const source of scripts) {
    browser.evaluate(source);
    if (watchdogOnly && typeof browser.context.__bunnyBootFailed === 'function') return browser;
  }
  if (watchdogOnly) assert.fail('an independent watchdog must initialize before the application bundle');
  return browser;
}

function assertReady(browser) {
  const button = browser.elements.get('start-button');
  assert.deepEqual(browser.errors, [], 'startup must not report an exception');
  assert.equal(button.disabled, false, 'startup must enable play before photographs finish');
  assert.match(button.textContent || button.innerHTML, /开始合成/, 'the loading label must be replaced');
  assert.equal(browser.elements.get('collection-count').textContent, '1/12');
}

function currentSprites(browser, spriteSize) {
  const groups = new Map();
  for (const canvas of browser.canvases) {
    if (canvas.id || canvas.width !== canvas.height || canvas.width <= 128) continue;
    const group = groups.get(canvas.width) || [];
    group.push(canvas);
    groups.set(canvas.width, group);
  }
  // Favicon canvases also use devicePixelRatio. Identify the twelve-image cache
  // by its shared dimensions, and permit either reuse or replacement on refresh.
  const group = (spriteSize === undefined
    ? [...groups.values()].sort((a, b) => b.length - a.length)[0]
    : groups.get(spriteSize)) || [];
  assert.ok(group.length >= 12, 'the game must cache one sprite per rabbit');
  return group.slice(-12);
}

test('published HTML embeds all gameplay dependencies and the three PNG atlases', () => {
  const { html } = readPage();
  assert.match(html, /<style\b[^>]*>[\s\S]+?<\/style>/i, 'CSS must be inline');
  assert.doesNotMatch(html, /<link\b[^>]*rel=["']stylesheet["']/i);
  assert.doesNotMatch(html, /<link\b[^>]*rel=["']preload["'][^>]*as=["']image["']/i);
  assert.doesNotMatch(html, /<img\b[^>]*src=["'](?!data:)[^"']+["']/i);
  const atlases = [...new Set(html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [])];
  assert.equal(atlases.length, 3, 'exactly three unique embedded PNG atlases are expected');
  for (const atlas of atlases) {
    const bytes = Buffer.from(atlas.slice(atlas.indexOf(',') + 1), 'base64');
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'embedded atlas must be a real PNG');
  }
});

test('images that never load cannot hold the game at its initial loading screen', async () => {
  const browser = boot();
  await browser.flush();
  assertReady(browser);
  assert.equal(browser.images.length, 3);
  assert.ok(browser.images.every(image => image.naturalWidth === 0), 'the test must not complete image loading');
  browser.advance(16_000);
  assertReady(browser);
  browser.elements.get('start-button').click();
  assert.equal(browser.elements.get('welcome').hidden, true, 'fallback artwork must support a playable game');
  browser.frame(0);
  browser.frame(16);
});

test('legacy WebView APIs are optional during startup and in the collection dialog', async () => {
  const browser = boot({ legacy: true });
  await browser.flush();
  assertReady(browser);
  assert.equal(browser.evaluate('typeof ResizeObserver'), 'undefined');
  assert.equal(browser.evaluate('typeof Array.prototype.flatMap'), 'undefined');
  assert.equal(browser.evaluate('typeof globalThis'), 'undefined');
  assert.equal(typeof browser.elements.get('game-dialog').showModal, 'undefined');
  assert.equal(typeof browser.elements.get('evolution-strip').replaceChildren, 'undefined');
  browser.elements.get('collection-button').click();
  assert.equal(browser.elements.get('game-dialog').open, true, 'the non-native dialog must open');
  assert.equal(browser.elements.get('collection-grid').children.length, 12);
  browser.elements.get('close-dialog').click();
  assert.equal(browser.elements.get('game-dialog').open, false, 'the non-native dialog must close');
});

test('late photographs refresh cached sprites and all visible artwork', async () => {
  const browser = boot();
  await browser.flush();
  assertReady(browser);
  browser.elements.get('collection-button').click();
  const sprites = currentSprites(browser);
  const spriteSize = sprites[0].width;
  assert.ok(sprites.every(canvas => browser.photoDraws(canvas) === 0));
  await browser.images[0].complete();
  await browser.flush();
  assert.ok(currentSprites(browser, spriteSize).some(canvas => browser.photoDraws(canvas) > 0), 'each completed atlas must refresh sprites without waiting for all atlases');
  await browser.completeImages();
  const finalSprites = currentSprites(browser, spriteSize);
  assert.ok(finalSprites.every(canvas => browser.photoDraws(canvas) > 0),
    `all twelve cached sprites must use photographs: ${JSON.stringify(finalSprites.map(canvas => ({ size: canvas.width, photos: browser.photoDraws(canvas) })))}`);
  for (const id of ['welcome-art', 'brand-art', 'next-canvas']) {
    assert.ok(browser.photoDraws(browser.elements.get(id)) > 0, `${id} must refresh after images load`);
  }
  for (const id of ['evolution-strip', 'collection-grid']) {
    const icons = browser.elements.get(id).querySelectorAll('canvas');
    assert.ok(icons.length > 0, `${id} must contain artwork`);
    assert.ok(icons.every(canvas => browser.photoDraws(canvas) > 0), `${id} must refresh its visible icons`);
  }
  assertReady(browser);
});

test('independent startup watchdog offers a working retry after a script failure', () => {
  const browser = boot({ watchdogOnly: true });
  assert.equal(typeof browser.context.__bunnyReady, 'function');
  browser.evaluate('window.__bunnyBootFailed(new Error("simulated bundle failure"));');
  const button = browser.elements.get('start-button');
  assert.equal(button.disabled, false);
  assert.match(button.textContent || button.innerHTML, /重试/);
  assert.ok(browser.elements.get('load-status').textContent.length > 0, 'failure must explain what the player can do');
  button.click();
  assert.equal(browser.reloads, 1, 'retry must reload the page');
});

test('independent startup watchdog cannot leave a stalled script loading forever', () => {
  const browser = boot({ watchdogOnly: true });
  browser.advance(15_001);
  const button = browser.elements.get('start-button');
  assert.equal(button.disabled, false);
  assert.match(button.textContent || button.innerHTML, /重试/);
  button.click();
  assert.equal(browser.reloads, 1);
});

test('photographs decoded after the 12-second deadline still refresh all twelve sprites and clear the slow-load status', async () => {
  const browser = boot();
  await browser.flush();
  assertReady(browser);
  const sprites = currentSprites(browser);
  const spriteSize = sprites[0].width;
  assert.ok(sprites.every(canvas => browser.photoDraws(canvas) === 0));

  browser.advance(12_001);
  await browser.flush();
  assertReady(browser);
  assert.ok(browser.images.every(image => image.naturalWidth === 0), 'the deadline must pass before any photo is decoded');

  await browser.images[0].complete();
  await browser.flush();
  assert.ok(currentSprites(browser, spriteSize).some(canvas => browser.photoDraws(canvas) > 0),
    'an atlas decoded after the deadline must immediately replace its fallback sprites');

  await browser.completeImages();
  assert.ok(browser.images.every(image => image.naturalWidth > 0));
  assert.ok(currentSprites(browser, spriteSize).every(canvas => browser.photoDraws(canvas) > 0),
    'all twelve sprites must display the selected photos even when every atlas arrived after the deadline');
  assert.equal(browser.elements.get('load-status').textContent, '拖动瞄准 · 松手落下',
    'successful background progress must clear the stale slow-load status');
  assertReady(browser);
});
