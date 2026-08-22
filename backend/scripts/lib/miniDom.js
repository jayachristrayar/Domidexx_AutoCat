// A tiny, purpose-built DOM used only to unit-test
// extension/src/content-scripts/kohaFillEngine.js under Node, without
// pulling in jsdom or any other new dependency. It implements only the
// subset of DOM + CSS selectors kohaFillEngine.js actually uses:
// tag/class/attribute selectors (including ^= and *= with an "i" flag),
// comma-separated selector lists, querySelector(All), closest, matches,
// contains, getAttribute, and a minimal addEventListener/dispatchEvent.
//
// This is intentionally small and readable rather than a general CSS
// engine -- it exists to prove the engine's *logic* (verify-before-write,
// conflict detection, repeatable-field handling, the save guard) against
// realistic markup shapes, not to be a browser replacement.

let idCounter = 0;

export class MiniElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this._id = ++idCounter;
    this.attributes = new Map(Object.entries(attrs));
    this.className = attrs.class ?? '';
    this.children = [];
    this.parentElement = null;
    this._value = attrs.value ?? '';
    this.textContent = attrs.text ?? '';
    this._listeners = new Map();
  }

  get classListTokens() {
    return String(this.className || '').split(/\s+/).filter(Boolean);
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = v;
  }

  get id() {
    return this.attributes.get('id') ?? '';
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  dispatchEvent(event) {
    for (const handler of this._listeners.get(event.type) ?? []) handler(event);
    return true;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let el = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  }

  contains(other) {
    let el = other;
    while (el) {
      if (el === this) return true;
      el = el.parentElement;
    }
    return false;
  }

  querySelectorAll(selector) {
    return collectDescendants(this).filter((el) => matchesSelector(el, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class MiniDocument extends MiniElement {
  constructor() {
    super('#document');
  }
}

function collectDescendants(root) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

// --- tiny selector engine: comma list of compound selectors made of
// tag / .class / [attr] / [attr="v"] / [attr^="v"] / [attr*="v" i] ---

function parseCompound(compound) {
  const parts = [];
  const re = /^([a-zA-Z0-9-]+)?|(\.[a-zA-Z0-9_-]+)|(\[[^\]]+\])/g;
  let rest = compound.trim();
  let tag = null;
  const classes = [];
  const attrs = [];

  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    tag = tagMatch[0].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  }
  const tokenRe = /\.[a-zA-Z0-9_-]+|\[[^\]]+\]/g;
  let m;
  while ((m = tokenRe.exec(rest))) {
    const token = m[0];
    if (token.startsWith('.')) {
      classes.push(token.slice(1));
    } else {
      attrs.push(parseAttr(token.slice(1, -1)));
    }
  }
  return { tag, classes, attrs };
}

function parseAttr(inner) {
  const ciMatch = inner.match(/\s+i$/i);
  const caseInsensitive = Boolean(ciMatch);
  const body = caseInsensitive ? inner.replace(/\s+i$/i, '') : inner;
  const opMatch = body.match(/^([a-zA-Z0-9_-]+)([~^$*]?=)?"?([^"]*)"?$/);
  if (!opMatch) return { name: body, op: null, value: null, ci: caseInsensitive };
  const [, name, op, value] = opMatch;
  return { name, op: op ? op.replace('=', '') : null, value: value ?? null, ci: caseInsensitive };
}

function attrMatches(el, attr) {
  const raw = el.getAttribute(attr.name);
  if (attr.op == null) return raw != null;
  if (raw == null) return false;
  const a = attr.ci ? raw.toLowerCase() : raw;
  const b = attr.ci ? String(attr.value).toLowerCase() : attr.value;
  if (attr.op === '^') return a.startsWith(b);
  if (attr.op === '*') return a.includes(b);
  if (attr.op === '$') return a.endsWith(b);
  return a === b;
}

function matchesCompound(el, compound) {
  const { tag, classes, attrs } = parseCompound(compound);
  if (tag && el.tagName !== tag) return false;
  for (const c of classes) {
    if (!el.classListTokens.includes(c)) return false;
  }
  for (const a of attrs) {
    if (!attrMatches(el, a)) return false;
  }
  return true;
}

export function matchesSelector(el, selectorList) {
  return selectorList
    .split(',')
    .map((s) => s.trim())
    .some((compound) => matchesCompound(el, compound));
}

export function el(tagName, attrs, children = []) {
  const node = new MiniElement(tagName, attrs);
  node.append(...children);
  return node;
}
