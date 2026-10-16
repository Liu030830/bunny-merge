import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { GameWorld, LEVELS } from './physics.mjs';

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

function createBrowser(html, { legacy = false, saved, reducedMotion = false } = {}) {
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
  if (saved !== undefined) storage.set('bunny-garden-v1', JSON.stringify(saved));
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
      this.scales = [];
      this.drawMatrices = [];
      this.context = { canvas: this, globalAlpha: 1 };
      for (const method of ['save', 'restore', 'translate', 'rotate', 'scale', 'transform', 'setTransform',
        'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
        'ellipse', 'arc', 'quadraticCurveTo', 'bezierCurveTo', 'clip', 'fill', 'stroke', 'fillText',
        'strokeText', 'setLineDash']) this.context[method] = () => {};
      let matrix = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const transform = (a, b, c, d, e, f) => {
        const [ma, mb, mc, md, me, mf] = matrix;
        matrix = [ma*a+mc*b, mb*a+md*b, ma*c+mc*d, mb*c+md*d, ma*e+mc*f+me, mb*e+md*f+mf];
      };
      this.context.save = () => stack.push([...matrix]);
      this.context.restore = () => { if (stack.length) matrix = stack.pop(); };
      this.context.setTransform = (...values) => { matrix = values; };
      this.context.resetTransform = () => { matrix = [1, 0, 0, 1, 0, 0]; };
      this.context.transform = transform;
      this.context.translate = (x, y) => transform(1, 0, 0, 1, x, y);
      this.context.rotate = angle => transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0);
      this.context.scale = (x, y) => { this.scales.push([x, y]); transform(x, 0, 0, y, 0, 0); };
      this.context.drawImage = (...args) => { this.draws.push(args); this.drawMatrices.push([...matrix]); };
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
    matchMedia: query => ({ matches: reducedMotion && query.includes('prefers-reduced-motion'), addListener() {}, addEventListener() {} }),
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
    readSaved() { return JSON.parse(storage.get('bunny-garden-v1') || 'null'); },
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

function boot({ legacy = false, watchdogOnly = false, saved, reducedMotion = false } = {}) {
  const { html, scripts } = readPage();
  const browser = createBrowser(html, { legacy, saved, reducedMotion });
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

function gameFixture({ score = 2000, revivesUsed = 0, phase = 'over', bodies } = {}) {
  const world = new GameWorld({ width: 360, height: 360 * 450 / 330 - 12, random: () => 0 });
  const placements = bodies || [[1, 180, 260], [0, 165, 80], [8, 260, 340]];
  world.bodies = placements.map(([level, x, y]) => world.makeBody(level, x, y, 0, 0, 5));
  world.score = score;
  world.revivesUsed = revivesUsed;
  world.phase = phase;
  world.dangerTime = phase === 'over' ? 2 : 0;
  const highest = [...world.bodies].sort((a, b) => world.getBounds(a).min.y - world.getBounds(b).min.y)[0];
  return {
    saved: { best: score, unlocked: Math.max(0, ...placements.map(([level]) => level)), sound: false, game: world.snapshot() },
    highestId: highest?.id,
  };
}

function assertCoinUi(browser, coins, remaining = 2000) {
  assert.deepEqual(browser.errors, [], 'the saved game must start without an exception');
  const counter = browser.elements.get('revive-coins');
  const progress = browser.elements.get('coin-progress');
  assert.ok(counter, 'the coin counter must be rendered');
  assert.ok(progress, 'the next-coin progress must be rendered');
  assert.equal(counter.textContent, String(coins));
  assert.equal(progress.textContent, `再得 ${remaining} 分 +1枚`);
}

test('a restored overflow game can spend one coin to remove only the highest rabbit without losing points', () => {
  const fixture = gameFixture();
  const browser = boot({ saved: fixture.saved });
  assertCoinUi(browser, 1);
  assert.equal(browser.elements.get('game-dialog').open, true, 'an ended save must show the recovery dialog');
  const reviveButton = browser.elements.get('revive-button');
  assert.ok(reviveButton, 'a player with a coin must be offered revival');
  reviveButton.click();
  const saved = browser.readSaved();
  assert.equal(saved.game.score, 2000, 'revival must not spend score');
  assert.equal(browser.elements.get('score').textContent, '2000');
  assert.equal(saved.game.revivesUsed, 1, 'coin usage must be saved immediately');
  assert.equal(saved.game.phase, 'playing');
  assert.deepEqual(saved.game.bodies.map(body => body.id), fixture.saved.game.bodies.filter(body => body.id !== fixture.highestId).map(body => body.id));
  assert.equal(browser.elements.get('game-dialog').open, false);
  assertCoinUi(browser, 0);
  browser.frame(1);
  browser.frame(18);
  assert.equal(browser.elements.get('pause-overlay').hidden, true, 'revival must actually resume gameplay');

  const refreshed = boot({ saved });
  assertCoinUi(refreshed, 0);
  assert.equal(refreshed.readSaved().game.revivesUsed, 1, 'refresh must not refund the spent coin');
});

test('an overflow game with no available coins does not offer revival', () => {
  for (const options of [{ score: 1999 }, { score: 2000, revivesUsed: 1 }]) {
    const fixture = gameFixture(options);
    const browser = boot({ saved: fixture.saved });
    assertCoinUi(browser, 0, 2000 - options.score % 2000);
    assert.equal(browser.elements.get('game-dialog').open, true);
    assert.equal(browser.elements.get('revive-button'), undefined, 'an unearned or already spent coin cannot be used');
    assert.ok(browser.elements.get('again-button'), 'starting a new game must remain available');
  }
});

test('closing the overflow dialog leaves a recovery control that reopens it', () => {
  const browser = boot({ saved: gameFixture().saved });
  browser.elements.get('close-dialog').click();
  assert.equal(browser.elements.get('game-dialog').open, false);
  const button = browser.elements.get('pause-button');
  assert.equal(button.disabled, false);
  assert.equal(button.querySelector('span').textContent, '复活');
  button.click();
  assert.equal(browser.elements.get('game-dialog').open, true);
  assert.ok(browser.elements.get('revive-button'));
  assertCoinUi(browser, 1);
});

test('starting another round clears its coins and usage while preserving the high score', () => {
  const browser = boot({ saved: gameFixture({ score: 4000, revivesUsed: 1 }).saved });
  assertCoinUi(browser, 1);
  browser.elements.get('again-button').click();
  const saved = browser.readSaved();
  assert.equal(saved.game.phase, 'playing');
  assert.equal(saved.game.score, 0);
  assert.equal(saved.game.revivesUsed, 0);
  assert.equal(saved.game.bodies.length, 0);
  assert.equal(saved.best, 4000);
  assert.equal(browser.elements.get('score').textContent, '0');
  assertCoinUi(browser, 0);
});

test('refreshing an ended round preserves its rabbits, score and available revival coin', () => {
  const fixture = gameFixture();
  const first = boot({ saved: fixture.saved });
  const saved = first.readSaved();
  assert.equal(saved.game.phase, 'over', 'startup must not replace an ended save with a new round');
  assert.equal(saved.game.score, fixture.saved.game.score);
  assert.deepEqual(saved.game.bodies.map(body => body.id), fixture.saved.game.bodies.map(body => body.id));
  const refreshed = boot({ saved });
  assertCoinUi(refreshed, 1);
  assert.equal(refreshed.elements.get('game-dialog').open, true);
  assert.ok(refreshed.elements.get('revive-button'));
  assert.equal(refreshed.readSaved().game.revivesUsed, 0);
});

test('a real merge crossing 2000 points immediately awards one coin and updates its progress', () => {
  const fixture = gameFixture({ score: 1998, phase: 'playing', bodies: [[0, 170, 300], [0, 185, 300]] });
  const browser = boot({ saved: fixture.saved });
  assertCoinUi(browser, 0, 2);
  browser.elements.get('resume-button').click();
  browser.frame(1);
  browser.frame(18);
  const saved = browser.readSaved();
  assert.equal(saved.game.score, 2002, 'the two real level-zero bodies must merge for four points');
  assert.equal(saved.game.revivesUsed, 0);
  assert.equal(saved.game.bodies.length, 1);
  assert.equal(browser.elements.get('score').textContent, '2002');
  assertCoinUi(browser, 1, 1998);
});

test('the final rabbit pair clears for 500 points and a bonus coin, including the normal 2000-point reward', () => {
  for (const initialScore of [0, 1750]) {
    const last = LEVELS.length - 1;
    const fixture = gameFixture({ score: initialScore, phase: 'playing', bodies: [[last, 120, 300], [last, 240, 300]] });
    const browser = boot({ saved: fixture.saved });
    assertCoinUi(browser, 0, 2000 - initialScore);
    browser.elements.get('resume-button').click();
    browser.frame(1);
    browser.frame(18);

    const saved = browser.readSaved();
    const finalScore = initialScore + 500;
    const coins = 1 + Math.floor(finalScore / 2000);
    assert.equal(saved.game.score, finalScore, 'clearing the largest pair must award exactly 500 points');
    assert.equal(saved.game.bodies.length, 0, 'both largest rabbits must be removed');
    assert.equal(saved.game.bonusCoins, 1, 'the extra coin must be saved separately from score milestones');
    assert.equal(saved.game.revivesUsed, 0);
    assert.equal(saved.game.phase, 'playing');
    assert.equal(browser.elements.get('score').textContent, String(finalScore));
    assertCoinUi(browser, coins, 2000 - finalScore % 2000);
    const toast = browser.elements.get('toast').textContent;
    assert.match(toast, /奖励 500 分/, 'a win announcement must not overwrite the clearing reward');
    assert.ok(toast.includes(`获得 ${coins} 枚复活币`), 'the reward message must include both bonus and milestone coins');
    assert.ok(browser.elements.get('game-announcement').textContent.includes(`获得 ${coins} 枚复活币`), 'the accessible announcement must include the extra coin');

    const refreshed = boot({ saved });
    assertCoinUi(refreshed, coins, 2000 - finalScore % 2000);
    assert.equal(refreshed.readSaved().game.bonusCoins, 1, 'refresh must preserve the extra final-pair coin');
  }
});

test('a real landing visibly squashes, freezes while paused, recovers, and respects reduced motion', () => {
  function fallingGame(reducedMotion) {
    const fixture = gameFixture({ score: 0, phase: 'playing', bodies: [[0, 180, 400]] });
    fixture.saved.game.bodies[0].vy = 440;
    const browser = boot({ saved: fixture.saved, reducedMotion });
    assertCoinUi(browser, 0);
    browser.elements.get('resume-button').click();
    return browser;
  }
  function renderBody(browser, time) {
    const canvas = browser.elements.get('game-canvas');
    canvas.scales.length = canvas.draws.length = canvas.drawMatrices.length = 0;
    browser.frame(time);
    // The first sprite is the falling rabbit; the aim preview is drawn afterward.
    assert.ok(canvas.drawMatrices.length, 'the live rabbit must be rendered');
    const matrix = canvas.drawMatrices[0];
    const baseline = canvas.width / 360;
    return {
      x: Math.hypot(matrix[0], matrix[2]) / baseline,
      y: Math.hypot(matrix[1], matrix[3]) / baseline,
      scaleCalls: canvas.scales.map(values => [...values]),
    };
  }
  function assertUnit(transform, message) {
    assert.ok(Math.abs(transform.x - 1) < 1e-8 && Math.abs(transform.y - 1) < 1e-8, message);
  }

  const browser = fallingGame(false);
  let time = 1;
  assertUnit(renderBody(browser, time), 'the falling rabbit starts at its normal proportions');
  let impact;
  for (let i = 0; i < 120; i++) {
    const transform = renderBody(browser, time += 16);
    if (transform.x > 1.001 && transform.y < .999) { impact = transform; break; }
  }
  assert.ok(impact, 'a real floor collision must create a visible wider, shorter rabbit');
  assert.ok(impact.scaleCalls.some(([x, y]) => x > 1 && y < 1), 'the impact must use an anisotropic canvas scale');
  assert.ok(impact.x <= 1.1 && impact.y >= .89, 'the deformation must remain gentle');

  browser.elements.get('pause-button').click();
  assert.equal(browser.elements.get('pause-overlay').hidden, false);
  for (const elapsed of [16, 1500]) {
    const paused = renderBody(browser, time += elapsed);
    assert.ok(Math.abs(paused.x - impact.x) < 1e-10 && Math.abs(paused.y - impact.y) < 1e-10,
      'pausing must freeze the collision animation rather than letting it expire');
  }
  browser.elements.get('resume-button').click();
  let recovered;
  for (let i = 0; i < 180; i++) recovered = renderBody(browser, time += 16);
  assertUnit(recovered, 'the impact transform must restore normal proportions after the rabbit settles');

  const reduced = fallingGame(true);
  for (let i = 0; i <= 180; i++) {
    const transform = renderBody(reduced, 1 + i * 16);
    assertUnit(transform, 'reduced motion must disable collision squash throughout the real fall and landing');
    assert.ok(transform.scaleCalls.every(([x, y]) => Math.abs(x - y) < 1e-10), 'reduced motion must not apply anisotropic scaling');
  }
});
