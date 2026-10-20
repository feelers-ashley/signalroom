/*
  net.js — a tiny shared-state layer for classroom sketches.

  Uses Firebase Realtime Database when config.js has a real config.
  Falls back to LOCAL MODE (browser tabs on one computer, via BroadcastChannel)
  when the config is still a placeholder, or when the address ends in ?local.

  You do not need to edit this file.

  Net.start(firebaseConfig, roomName)   connect; returns 'firebase' or 'local'
  Net.id                                this device's random id
  Net.set(path, value)                  write a value
  Net.update(path, object)              merge some fields into a value
  Net.push(path, value)                 add a new child with a time-ordered key
  Net.remove(path)                      delete a value
  Net.here(path, value)                 write a value that disappears when this device leaves
  Net.onValue(path, fn(value))          run fn now and whenever the value changes
  Net.onNew(path, fn(value, key))       run fn for each child pushed after now
  Net.onRecent(path, n, fn(value, key, isNew))  the last n children, then each new one
  Net.onStatus(fn(connected, mode))     connection changes
  Net.now()                             time in ms, shared across devices (roughly)
*/
(function () {
  const Net = {};
  const split = (p) => String(p || '').split('/').filter(Boolean);
  const join = (...parts) => parts.map(String).join('/').split('/').filter(Boolean).join('/');

  function makeId() {
    let id = null;
    try { id = sessionStorage.getItem('net-id'); } catch (e) {}
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem('net-id', id); } catch (e) {}
    }
    return id;
  }
  Net.id = makeId();

  let impl = null;
  let statusFns = [];
  let status = { connected: false, mode: 'none' };
  function setStatus(connected, mode) {
    status = { connected, mode };
    statusFns.forEach((fn) => fn(connected, mode));
  }
  Net.onStatus = (fn) => { statusFns.push(fn); fn(status.connected, status.mode); };

  function isPlaceholder(cfg) {
    return !cfg || !cfg.apiKey || /PASTE|YOUR/i.test(cfg.apiKey) || !cfg.databaseURL || /PASTE|YOUR/i.test(cfg.databaseURL);
  }

  Net.start = function (firebaseConfig, roomName) {
    const room = String(roomName || 'room').replace(/[.#$\[\]]/g, '-');
    const forceLocal = /[?&]local\b/.test(location.search);
    if (!forceLocal && !isPlaceholder(firebaseConfig) && window.firebase) {
      impl = firebaseImpl(firebaseConfig, room);
      Net.mode = 'firebase';
    } else {
      impl = localImpl(room);
      Net.mode = 'local';
      console.log('%cnet.js: LOCAL MODE — only tabs in this browser can see each other. Paste your Firebase config into config.js to go across devices.', 'color:#b45309');
    }
    Net.room = room;
    return Net.mode;
  };

  ['set', 'update', 'push', 'remove', 'here', 'onValue', 'onNew', 'onRecent', 'now'].forEach((name) => {
    Net[name] = function (...args) {
      if (!impl) throw new Error('net.js: call Net.start(...) before Net.' + name + '()');
      return impl[name](...args);
    };
  });

  /* ---------------- Firebase Realtime Database ---------------- */
  function firebaseImpl(cfg, room) {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
    const db = app.database();
    const ref = (p) => db.ref(join('rooms', room, p));
    let offset = 0;
    db.ref('.info/serverTimeOffset').on('value', (s) => { offset = s.val() || 0; });
    const heres = [];
    db.ref('.info/connected').on('value', (s) => {
      const ok = s.val() === true;
      if (ok) heres.forEach((h) => { h.ref.onDisconnect().remove(); h.ref.set(h.value); });
      setStatus(ok, 'firebase');
    });
    return {
      set: (p, v) => ref(p).set(v),
      update: (p, v) => ref(p).update(v),
      push: (p, v) => ref(p).push(v),
      remove: (p) => ref(p).remove(),
      here(p, v) {
        const r = ref(p);
        let h = heres.find((x) => x.path === p);
        if (!h) { h = { path: p, ref: r, value: v }; heres.push(h); r.onDisconnect().remove(); }
        h.value = v;
        return r.set(v);
      },
      onValue: (p, fn) => ref(p).on('value', (s) => fn(s.val())),
      onNew(p, fn) {
        const start = ref(p).push().key; // a key for "now" — never written
        ref(p).orderByKey().startAt(start).on('child_added', (s) => fn(s.val(), s.key));
      },
      onRecent(p, n, fn) {
        const start = ref(p).push().key;
        ref(p).limitToLast(n).on('child_added', (s) => fn(s.val(), s.key, s.key > start));
      },
      now: () => Date.now() + offset,
    };
  }

  /* ---------------- Local mode: tabs in one browser ---------------- */
  function localImpl(room) {
    const ch = new BroadcastChannel('net-local-' + room);
    let tree = {};
    const valueFns = []; // {path, fn}
    const childFns = []; // {path, fn}
    const recentFns = []; // {path, n, fn} — replayed when another tab sends its history
    const mine = new Set(); // paths written with here()
    let synced = false;
    const merge = (a, b) => { if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return b === undefined ? a : b; const o = Object.assign({}, a); Object.keys(b).forEach((k) => { o[k] = merge(a[k], b[k]); }); return o; };

    const get = (p) => split(p).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), tree);
    function put(p, v) {
      const keys = split(p);
      if (!keys.length) { tree = v == null ? {} : v; return; }
      let o = tree;
      keys.slice(0, -1).forEach((k) => { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
      const last = keys[keys.length - 1];
      if (v == null) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
    }
    const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
    function notify(changed, pushedKey) {
      valueFns.forEach((l) => {
        const a = l.path, b = changed;
        if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || a === '' || b === '') l.fn(clone(get(a)));
      });
      if (pushedKey) {
        const parent = split(changed).slice(0, -1).join('/');
        childFns.forEach((l) => { if (l.path === parent) l.fn(clone(get(changed)), pushedKey); });
      }
    }
    function apply(msg) {
      if (msg.op === 'set') put(msg.path, msg.value);
      if (msg.op === 'update') Object.entries(msg.value || {}).forEach(([k, v]) => put(join(msg.path, k), v));
      if (msg.op === 'remove') put(msg.path, null);
      notify(msg.path, msg.op === 'push' ? (put(msg.path, msg.value), split(msg.path).pop()) : null);
    }
    function send(msg) { apply(msg); ch.postMessage(msg); }
    ch.onmessage = (e) => {
      const m = e.data;
      if (m.op === 'hello') { ch.postMessage({ op: 'snapshot', tree }); mine.forEach((p) => ch.postMessage({ op: 'set', path: p, value: get(p) })); return; }
      if (m.op === 'snapshot') { if (!synced && m.tree && Object.keys(m.tree).length) {
        synced = true; tree = merge(m.tree, tree); notify('');
        recentFns.forEach((l) => { const kids = get(l.path) || {}; Object.keys(kids).sort().slice(-l.n).forEach((k) => l.fn(clone(kids[k]), k, false)); });
      } return; }
      apply(m);
    };
    window.addEventListener('pagehide', () => mine.forEach((p) => ch.postMessage({ op: 'remove', path: p })));
    ch.postMessage({ op: 'hello' });
    setTimeout(() => setStatus(true, 'local'), 0);
    let n = 0;
    const key = () => Date.now().toString(36).padStart(9, '0') + (n++).toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 5);

    return {
      set: (p, v) => send({ op: 'set', path: p, value: v }),
      update: (p, v) => send({ op: 'update', path: p, value: v }),
      push: (p, v) => send({ op: 'push', path: join(p, key()), value: v }),
      remove: (p) => send({ op: 'remove', path: p }),
      here: (p, v) => { mine.add(p); send({ op: 'set', path: p, value: v }); },
      onValue: (p, fn) => { valueFns.push({ path: split(p).join('/'), fn }); fn(clone(get(p))); },
      onNew: (p, fn) => childFns.push({ path: split(p).join('/'), fn }),
      onRecent(p, n, fn) {
        const kids = get(p) || {};
        Object.keys(kids).sort().slice(-n).forEach((k) => fn(clone(kids[k]), k, false));
        recentFns.push({ path: split(p).join('/'), n, fn });
        childFns.push({ path: split(p).join('/'), fn: (v, k) => fn(v, k, true) });
      },
      now: () => Date.now(),
    };
  }

  window.Net = Net;
})();
