/* =========================================================
   LAZY LOADER — externí knihovny (Leaflet, Pannellum) stahujeme až když
   user doroluje k jejich sekci. Šetří ~300 KB JS+CSS na initial pageload.
   ========================================================= */
window.dilnaLazyLib = (function () {
  const cssCache = {};
  const jsCache = {};
  function loadCSS(href) {
    if (cssCache[href]) return cssCache[href];
    cssCache[href] = new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
    return cssCache[href];
  }
  function loadJS(src) {
    if (jsCache[src]) return jsCache[src];
    jsCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.body.appendChild(s);
    });
    return jsCache[src];
  }
  function loadOnIntersection(targetEl, rootMargin, callback) {
    if (!targetEl) return;
    if (!('IntersectionObserver' in window)) {
      // Fallback — starý browser, prostě nahraj hned
      callback();
      return;
    }
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        obs.disconnect();
        callback();
      }
    }, { rootMargin });
    obs.observe(targetEl);
  }
  return { loadCSS, loadJS, loadOnIntersection };
})();

/* =========================================================
   AVAILABILITY — sdílený data layer pro kalendář i time picker.

   HIERARCHIE PROSTORŮ:
   "Celé studio" je nadřazené — obsahuje "Studio" + "Podcastovou".
   - Rezervace "Celé studio" blokuje VŠECHNY tři varianty.
   - Rezervace "Studio" blokuje "Studio" + "Celé studio" (Podcastová zůstává volná).
   - Rezervace "Podcastová" blokuje "Podcastová" + "Celé studio" (Studio zůstává volné).

   Veřejné API:
   - getBusyHours(dateISO, space) → Set<hour> obsazených hodin pro daný prostor
   - getDayStatus(dateISO, space) → 'free' | 'partial' | 'busy'

   Vnitřní model: getRawBookings(dateISO) → [{space, hours}, ...] — seznam reálných
   rezervací. getBusyHours pak resolve podle hierarchie. Až napojíme Google Sheet,
   stačí přepsat getRawBookings, nic dalšího se měnit nebude.
   ========================================================= */
window.dilnaAvailability = (function () {
  const HOURLY_START = 8;     // provozní začátek 8:00
  const HOURLY_END = 22;      // provozní konec 22:00
  const SLOT_MIN = 30;        // 30 min granularita
  const SLOTS_PER_HOUR = 60 / SLOT_MIN; // 2
  const TOTAL_SLOTS = (HOURLY_END - HOURLY_START) * SLOTS_PER_HOUR; // 28
  const TOTAL_HOURS = HOURLY_END - HOURLY_START;

  const SPACE_STUDIO = 'Studio';
  const SPACE_PODCAST = 'Podcastová / konferenční místnost';
  const SPACE_WHOLE = 'Celé studio';

  // Google Sheets CSV endpoint — publikovaný "Comma-separated values" sheet.
  // Aneta upravuje sheet, web pulluje data každých 5 minut + při návratu na tab.
  const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT_r8X0goY7mPPYb2QYyuHn4Gk7_UjQNLsqEiktDvaUnv_GNxG-_iXvoWh582qteY6wlvhupDpaUCN_/pub?output=csv';
  const CACHE_KEY = 'dilna-bookings-v3';
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // bookingsByDate: Map<"YYYY-MM-DD", [{ space, hours: [int, int, ...] }]>
  let bookingsByDate = new Map();
  let isLoaded = false;

  function isClosedDay(dateISO) {
    return false;
  }
  function allSlotsArray() {
    const a = [];
    for (let s = 0; s < TOTAL_SLOTS; s++) a.push(s);
    return a;
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  // "HH:MM" → slot index (0 = HOURLY_START). Časy mimo provozní okno
  // (např. 04:00 nebo 23:00 ve sheetu) klampujeme na nejbližší okraj —
  // to umožní zapsat "celý den" obecnými čísly bez null.
  function timeToSlot(t) {
    if (!t) return null;
    const parts = String(t).split(':');
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1] || '0', 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    if (hh < HOURLY_START) return 0;
    if (hh > HOURLY_END || (hh === HOURLY_END && mm > 0)) return TOTAL_SLOTS;
    return (hh - HOURLY_START) * SLOTS_PER_HOUR + Math.floor(mm / SLOT_MIN);
  }
  function slotToTime(slot) {
    const total = HOURLY_START * SLOTS_PER_HOUR + slot;
    const hh = Math.floor(total / SLOTS_PER_HOUR);
    const mm = (total % SLOTS_PER_HOUR) * SLOT_MIN;
    return pad2(hh) + ':' + pad2(mm);
  }

  // Hierarchická logika: rezervace daného prostoru blokuje dotazovaný prostor?
  function conflicts(bookedSpace, querySpace) {
    if (bookedSpace === querySpace) return true;
    if (bookedSpace === SPACE_WHOLE) return true;   // celé blokuje vše
    if (querySpace === SPACE_WHOLE) return true;    // dotaz na celé → každá sub-rezervace ho blokuje
    return false; // Studio ↔ Podcastová jsou nezávislé
  }

  // ===== CSV parser (handles quoted fields s embedded čárkou) =====
  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        out.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  function parseCSV(text) {
    const lines = text.replace(/﻿/, '').trim().split(/\r?\n/);
    if (!lines.length) return [];
    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    return lines.slice(1).map((line) => {
      const values = parseCsvLine(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = values[i] || ''; });
      return obj;
    });
  }

  // Google Sheets autokorektil pomlčky na en-dash / em-dash. Normalizujeme.
  function normDash(s) {
    return s.replace(/[‐-―−]/g, '-');
  }

  // "HH:MM" → minuty od půlnoci (na rozdíl od timeToSlot bez clampingu).
  function toMinutes(t) {
    if (!t) return null;
    const parts = String(t).split(':');
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1] || '0', 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    return hh * 60 + mm;
  }

  // ===== Row → bookings transformace (slot-based, 30 min granularita) =====
  function rowsToBookings(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const date = normDash((row.datum || '').trim());
      const space = (row.prostor || '').trim();
      const od = (row.od || '').trim();
      const doStr = (row['do'] || '').trim();
      if (!date || !space || !od || !doStr) return;
      const odMin = toMinutes(od);
      const doMin = toMinutes(doStr);
      if (odMin == null || doMin == null || doMin <= odMin) return;
      const fromSlot = timeToSlot(od);
      const toSlot = timeToSlot(doStr);
      const slots = [];
      if (fromSlot != null && toSlot != null && toSlot > fromSlot) {
        for (let s = fromSlot; s < toSlot; s++) slots.push(s);
      }
      // Přesahy mimo provozní okno (8:00–22:00) si držíme zvlášť pro overtime
      // dropdown — uložíme jako [startMin, endMin] absolute v dané dni.
      const overtimeRanges = [];
      const winStart = HOURLY_START * 60; // 480
      const winEnd = HOURLY_END * 60;     // 1320
      if (odMin < winStart) overtimeRanges.push([odMin, Math.min(doMin, winStart)]);
      if (doMin > winEnd) overtimeRanges.push([Math.max(odMin, winEnd), doMin]);
      if (!map.has(date)) map.set(date, []);
      map.get(date).push({ space, slots, overtimeRanges });
    });
    return map;
  }

  // Posun ISO datumu o N dní (kvůli overtime bookings, které sahají do dalšího dne).
  function addDaysISO(dateISO, days) {
    if (!dateISO) return null;
    const [y, m, d] = dateISO.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  // Overtime busy detection — vrací Set indexů přesčasových půlhodinových slotů
  // (slot 0 = HOURLY_END:00 form data, poslední = HOURLY_START následujícího dne).
  // Délka odvozená dynamicky z provozního okna ((24-22 + 8)*2 = 20 slotů).
  const OVERTIME_TOTAL_SLOTS = ((24 - HOURLY_END) + HOURLY_START) * 2;
  function getOvertimeBusySlots(formDateISO, space) {
    const busy = new Set();
    if (!formDateISO || !space) return busy;
    function applyRanges(ranges, offsetMin) {
      ranges.forEach(([s, e]) => {
        const startSlot = Math.floor((s + offsetMin) / 30);
        const endSlot = Math.ceil((e + offsetMin) / 30);
        for (let i = startSlot; i < endSlot; i++) {
          if (i >= 0 && i < OVERTIME_TOTAL_SLOTS) busy.add(i);
        }
      });
    }
    // Večerní overtime z form data — minuty 1320–1440 → unif. 0–120 (offset −1320)
    const formDay = bookingsByDate.get(formDateISO) || [];
    formDay.forEach((b) => {
      if (!conflicts(b.space, space)) return;
      const eveRanges = (b.overtimeRanges || []).filter(([s]) => s >= HOURLY_END * 60);
      applyRanges(eveRanges, -HOURLY_END * 60);
    });
    // Ranní overtime z následujícího dne — minuty 0–420 → unif. 120–540 (offset +120)
    const nextDay = bookingsByDate.get(addDaysISO(formDateISO, 1)) || [];
    nextDay.forEach((b) => {
      if (!conflicts(b.space, space)) return;
      const morRanges = (b.overtimeRanges || []).filter(([_s, e]) => e <= HOURLY_START * 60);
      applyRanges(morRanges, (24 - HOURLY_END) * 60);
    });
    return busy;
  }

  // ===== Cache (localStorage, 5min TTL) =====
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
      return new Map(data.entries);
    } catch (_) { return null; }
  }
  function writeCache(map) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        entries: Array.from(map.entries()),
      }));
    } catch (_) {}
  }

  // ===== Hlavní loader =====
  async function loadFromSheet() {
    // Cache hit
    const cached = readCache();
    if (cached) {
      bookingsByDate = cached;
      isLoaded = true;
      document.dispatchEvent(new CustomEvent('availability:loaded'));
    }
    // Vždy zkusíme fresh fetch, i když máme cache (background refresh)
    try {
      const res = await fetch(SHEET_CSV_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const rows = parseCSV(text);
      bookingsByDate = rowsToBookings(rows);
      isLoaded = true;
      writeCache(bookingsByDate);
      document.dispatchEvent(new CustomEvent('availability:loaded'));
    } catch (err) {
      console.warn('Sheet load failed:', err);
      // Pokud nemáme ani cache, zůstává prázdné → dny se ukáží jako volné
    }
  }

  function getRawBookings(dateISO) {
    if (!dateISO) return [];
    if (isClosedDay(dateISO)) {
      return [{ space: SPACE_WHOLE, slots: allSlotsArray() }];
    }
    return bookingsByDate.get(dateISO) || [];
  }

  function getBusySlots(dateISO, space) {
    if (!dateISO || !space) return new Set();
    const busy = new Set();
    for (const b of getRawBookings(dateISO)) {
      if (conflicts(b.space, space)) b.slots.forEach((s) => busy.add(s));
    }
    return busy;
  }

  function getDayStatus(dateISO, space) {
    if (isClosedDay(dateISO)) return 'busy';
    const busy = getBusySlots(dateISO, space);
    if (busy.size === 0) return 'free';
    if (busy.size >= TOTAL_SLOTS) return 'busy';
    return 'partial';
  }

  // Initial load + auto-refresh
  loadFromSheet();
  setInterval(loadFromSheet, CACHE_TTL_MS);
  // Refresh při návratu na tab (ať vidíš nejnovější data hned)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadFromSheet();
  });

  return {
    getBusySlots,
    getDayStatus,
    getRawBookings,
    getOvertimeBusySlots,
    loadFromSheet,
    isLoaded: () => isLoaded,
    HOURLY_START,
    HOURLY_END,
    SLOT_MIN,
    SLOTS_PER_HOUR,
    TOTAL_SLOTS,
    OVERTIME_TOTAL_SLOTS,
    timeToSlot,
    slotToTime,
    SPACES: { STUDIO: SPACE_STUDIO, PODCAST: SPACE_PODCAST, WHOLE: SPACE_WHOLE },
  };
})();

// Parallax floating images + drag-to-move
// — parallax: kurzor řídí translate s lerp easingem
// — drag: pointerdown chytne obrázek, pointermove ho přesouvá, release nastaví novou home pozici
(function initFloating() {
  const container = document.getElementById('floating');
  if (!container) return;
  // Touch zařízení: parallax běží, ale drag handlery NE — ty by blokovaly scroll
  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const items = Array.from(container.querySelectorAll('.float-img')).map((el) => ({
    el,
    img: el.querySelector('img'),
    depth: parseFloat(el.dataset.depth) || 1,
    // parallaxové sklouznutí (lerp k mouse * depth)
    cx: 0, cy: 0,
    // home offset — kumulativní posun z dragů + inertia
    hx: 0, hy: 0,
    // aktivní drag
    dragging: false,
    dragStartX: 0, dragStartY: 0,
    dragDX: 0, dragDY: 0,
    pointerId: null,
    // inertia (px/ms) + sample pro výpočet rychlosti
    vx: 0, vy: 0,
    lastMoveX: 0, lastMoveY: 0,
    lastMoveT: 0,
    // hranice (offset relative to layout pozice; v rámci nich smí být finalX/Y)
    minX: 0, maxX: 0, minY: 0, maxY: 0,
  }));

  // Vypočítej, jak daleko může každý obrázek od své CSS pozice popojet,
  // aby zůstal v rámci viewport boxu kontejneru.
  function recalcBounds(it) {
    if (!it.el) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const ox = it.el.offsetLeft;
    const oy = it.el.offsetTop;
    const ow = it.el.offsetWidth || it.el.getBoundingClientRect().width;
    const oh = it.el.offsetHeight || it.el.getBoundingClientRect().height;
    it.minX = -ox;
    it.maxX = cw - ox - ow;
    it.minY = -oy;
    it.maxY = ch - oy - oh;
  }
  function recalcAllBounds() { items.forEach(recalcBounds); }
  if (!items.length) return;

  const sensitivity = -1;
  const easing = 0.05;
  const mouse = { x: 0, y: 0 };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setMouse(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    // Aktualizuj pouze když je kurzor SKUTEČNĚ uvnitř hera. Jinak (např. když
    // uživatel hýbe myší v sekcích pod herem po odscrollování) by mouse.y
    // = clientY - rect.top vyrobil obří hodnotu (rect.top je hodně negativní)
    // a obrázky by uletěly nahoru. Po návratu na hero bys je našel přilepené
    // na strop, dokud nehybneš myší zpět nad hero.
    if (
      clientX < rect.left || clientX > rect.right ||
      clientY < rect.top || clientY > rect.bottom
    ) return;
    mouse.x = clientX - rect.left;
    mouse.y = clientY - rect.top;
  }
  window.addEventListener('mousemove', (e) => setMouse(e.clientX, e.clientY), { passive: true });
  // Touch: NEPOUŽÍVÁME touchmove pro parallax. Při scrollu by clientY skákal mimo
  // hero rect → mouse.y by spočítal extrémní hodnoty → obrázky by uletěly nahoru.
  if (!isTouch) {
    window.addEventListener('touchmove', (e) => {
      if (e.touches[0]) setMouse(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
  }

  // Inertia konstanty
  const INERTIA_FRICTION = 0.88;       // decay rychlosti za frame; nižší = rychlejší zastavení
  const INERTIA_THRESHOLD = 0.01;      // px/ms, pod kterou se hýbání zastaví
  const INERTIA_DT = 5;                // ms za frame, multiplier pro per-frame posun (menší = kratší throw)

  function tick() {
    items.forEach((it) => {
      if (reduce) {
        it.el.style.transform =
          'translate3d(' + (it.hx + it.dragDX) + 'px, ' + (it.hy + it.dragDY) + 'px, 0)';
        return;
      }
      if (!it.dragging) {
        // Inertia — pokračuj v posledním směru s útlumem (frikce)
        const speed = Math.abs(it.vx) + Math.abs(it.vy);
        if (speed > INERTIA_THRESHOLD) {
          it.hx += it.vx * INERTIA_DT;
          it.hy += it.vy * INERTIA_DT;
          it.vx *= INERTIA_FRICTION;
          it.vy *= INERTIA_FRICTION;
        } else {
          it.vx = 0;
          it.vy = 0;
        }
        // Parallax — lerp k mouse * depth
        const strength = (it.depth * sensitivity) / 20;
        const tx = mouse.x * strength;
        const ty = mouse.y * strength;
        it.cx += (tx - it.cx) * easing;
        it.cy += (ty - it.cy) * easing;
      }
      let finalX = it.hx + it.dragDX + (it.dragging ? 0 : it.cx);
      let finalY = it.hy + it.dragDY + (it.dragging ? 0 : it.cy);

      // Clamp na hranice kontejneru. Pouze když je aktivní inertia (vx/vy != 0),
      // zacapujeme i hx/hy — jinak by se home pozice driftovala při každém doteku
      // hranice (např. při změně velikosti containeru během scrollu).
      if (finalX < it.minX) {
        finalX = it.minX;
        if (!it.dragging && it.vx !== 0) { it.hx = it.minX - it.cx; it.vx = 0; }
      } else if (finalX > it.maxX) {
        finalX = it.maxX;
        if (!it.dragging && it.vx !== 0) { it.hx = it.maxX - it.cx; it.vx = 0; }
      }
      if (finalY < it.minY) {
        finalY = it.minY;
        if (!it.dragging && it.vy !== 0) { it.hy = it.minY - it.cy; it.vy = 0; }
      } else if (finalY > it.maxY) {
        finalY = it.maxY;
        if (!it.dragging && it.vy !== 0) { it.hy = it.maxY - it.cy; it.vy = 0; }
      }

      it.el.style.transform =
        'translate3d(' + finalX.toFixed(2) + 'px, ' + finalY.toFixed(2) + 'px, 0)';
    });
    requestAnimationFrame(tick);
  }
  tick();

  // Hranice — počítáme po inicializaci, po načtení obrázků a při resize
  recalcAllBounds();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(recalcAllBounds, 80);
  }, { passive: true });

  // Drag handlery — používáme klasické MOUSE eventy (ne pointer events).
  // Důvod: Safari má dlouhodobý bug s pointer events + setPointerCapture na <img>
  // (drag se zasekne hned po prvních pixelech). Mouse events jsou v Safari
  // robustní a fungují identicky jako v Chrome.
  let activeItem = null;

  if (!isTouch) {
    items.forEach((it) => {
      if (!it.img) return;
      const img = it.img;

      img.addEventListener('mousedown', (e) => {
        if (activeItem || e.button !== 0) return;
        it.hx += it.cx;
        it.hy += it.cy;
        it.cx = 0;
        it.cy = 0;
        it.vx = 0;
        it.vy = 0;
        it.dragging = true;
        it.dragStartX = e.clientX;
        it.dragStartY = e.clientY;
        it.dragDX = 0;
        it.dragDY = 0;
        it.lastMoveX = e.clientX;
        it.lastMoveY = e.clientY;
        it.lastMoveT = performance.now();
        it.el.classList.add('is-dragging');
        activeItem = it;
        e.preventDefault();
      });

      // Safari: <img> má native drag-and-drop, prevent it
      img.addEventListener('dragstart', (e) => e.preventDefault());
    });

    window.addEventListener('mousemove', (e) => {
      const it = activeItem;
      if (!it) return;
      it.dragDX = e.clientX - it.dragStartX;
      it.dragDY = e.clientY - it.dragStartY;
      const now = performance.now();
      const dt = Math.max(1, now - it.lastMoveT);
      const instVX = (e.clientX - it.lastMoveX) / dt;
      const instVY = (e.clientY - it.lastMoveY) / dt;
      it.vx = instVX * 0.7 + it.vx * 0.3;
      it.vy = instVY * 0.7 + it.vy * 0.3;
      it.lastMoveX = e.clientX;
      it.lastMoveY = e.clientY;
      it.lastMoveT = now;
    });

    const endDrag = () => {
      const it = activeItem;
      if (!it) return;
      it.hx += it.dragDX;
      it.hy += it.dragDY;
      it.dragDX = 0;
      it.dragDY = 0;
      it.hx = Math.max(it.minX, Math.min(it.maxX, it.hx));
      it.hy = Math.max(it.minY, Math.min(it.maxY, it.hy));
      if (performance.now() - it.lastMoveT > 100) {
        it.vx = 0;
        it.vy = 0;
      }
      it.dragging = false;
      it.el.classList.remove('is-dragging');
      activeItem = null;
    };
    window.addEventListener('mouseup', endDrag);
    // mouseleave okna (kurzor uleťí mimo browser) ukončí drag
    window.addEventListener('blur', endDrag);
  }

  // Stagger fade-in + recalc bounds po načtení (height: auto u float-img--7)
  const imgs = container.querySelectorAll('img');
  imgs.forEach((img, i) => {
    const onReady = () => {
      setTimeout(() => img.classList.add('is-loaded'), 200 + i * 140);
      recalcAllBounds();
    };
    if (img.complete && img.naturalWidth) onReady();
    else img.addEventListener('load', onReady, { once: true });
  });
})();

// Reveal on scroll
const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  );
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('is-in'));
}


/* =========================================================
   TEAM MARQUEE — náhodné přepínání směru s plynulým reverse
   Konstantní rychlost (50s pro jeden cyklus), lerp přes nulu při change.
   ========================================================= */
(function initTeamMarquee() {
  const track = document.querySelector('.team__track');
  const viewport = document.querySelector('.team__viewport');
  if (!track || !viewport) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  // JS přebírá kontrolu — vypni CSS animaci
  track.style.animation = 'none';

  let trackWidth = 0;
  let wrapDist = 0;       // px posunu pro jeden seamless cyklus
  let speedPxPerSec = 0;  // konstantní rychlost — měněna jen při resize

  function recalc() {
    trackWidth = track.scrollWidth;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const gapPx = 1.5 * root;
    wrapDist = trackWidth / 2 + gapPx / 2;
    speedPxPerSec = wrapDist / 50; // 50s pro jeden směr full cyklus
  }
  recalc();

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(recalc, 100);
  }, { passive: true });

  let position = 0;
  let direction = -1;        // -1 = doleva (default), +1 = doprava
  let targetDirection = direction;
  let lastTime = performance.now();
  let isHovered = false;
  let isDragging = false;

  const SMOOTHING = 0.04;

  function applyTransform() {
    // Wrap — zachová pozici v rozsahu [-wrapDist, 0] díky duplikátům
    while (position > 0) position -= wrapDist;
    while (position < -wrapDist) position += wrapDist;
    track.style.transform = 'translateX(' + position.toFixed(2) + 'px)';
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (!isHovered && !isDragging) {
      if (direction !== targetDirection) {
        direction += (targetDirection - direction) * SMOOTHING;
        if (Math.abs(direction - targetDirection) < 0.005) direction = targetDirection;
      }
      position += direction * speedPxPerSec * dt;
      applyTransform();
    }

    requestAnimationFrame(tick);
  }

  function scheduleReverse() {
    const interval = 10000 + Math.random() * 35000;
    setTimeout(() => {
      targetDirection = -targetDirection;
      scheduleReverse();
    }, interval);
  }

  viewport.addEventListener('mouseenter', () => { isHovered = true; });
  viewport.addEventListener('mouseleave', () => {
    isHovered = false;
    lastTime = performance.now();
  });

  // ===== DRAG-TO-SCRUB — uživatel chytne slider a posune si ho sám =====
  let dragStartX = 0;
  let dragStartPos = 0;

  function startDrag(clientX) {
    isDragging = true;
    dragStartX = clientX;
    dragStartPos = position;
    viewport.classList.add('is-dragging');
  }
  function moveDrag(clientX) {
    if (!isDragging) return;
    const delta = clientX - dragStartX;
    position = dragStartPos + delta;
    applyTransform();
  }
  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    viewport.classList.remove('is-dragging');
    lastTime = performance.now();
  }

  // Mouse — listenery na window, aby drag přežil opuštění viewportu
  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    startDrag(e.clientX);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX));
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);

  // Touch — touch-action: pan-y v CSS pošle horizontální gesto sem
  viewport.addEventListener('touchstart', (e) => {
    if (e.touches[0]) startDrag(e.touches[0].clientX);
  }, { passive: true });
  viewport.addEventListener('touchmove', (e) => {
    if (e.touches[0]) moveDrag(e.touches[0].clientX);
  }, { passive: true });
  viewport.addEventListener('touchend', endDrag);
  viewport.addEventListener('touchcancel', endDrag);

  // Native image drag-and-drop disable
  viewport.querySelectorAll('img').forEach((img) => {
    img.addEventListener('dragstart', (e) => e.preventDefault());
  });

  scheduleReverse();
  requestAnimationFrame(tick);
})();

/* =========================================================
   NAV REZERVACE OVERLAY — orange tlačítko mimo .nav blend kontext.
   Aktivuje se v okamžiku, kdy nav začne překrývat marquee, a ZŮSTANE
   aktivní dokud se nezvedneme zpět nad marquee.
   ========================================================= */
(function initNavCtaOverlay() {
  const overlay = document.querySelector('.nav-cta');
  const original = document.querySelector('.nav__menu a[href="#cenik"]');
  const marquee = document.querySelector('.marquee');
  const booking = document.querySelector('.booking');
  const nav = document.querySelector('.nav');
  if (!overlay || !original || !marquee || !nav) return;

  function syncPosition() {
    // jen top/left — overlay má stejný padding/font/line-height jako originál,
    // takže přirozeně roste do stejného boxu (žádný posun při zobrazení)
    const r = original.getBoundingClientRect();
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
  }

  let ticking = false;
  function check() {
    const m = marquee.getBoundingClientRect();
    const b = booking ? booking.getBoundingClientRect() : null;
    const navH = nav.offsetHeight;
    // pastMarquee = překryl marquee nebo je nad ním
    // onBooking = sjeli jsme do booking (jeho top dosáhl nav) → vracíme se k default blend stavu
    const pastMarquee = m.top < navH;
    const onBooking = b ? b.top < navH : false;
    const show = pastMarquee && !onBooking;
    overlay.classList.toggle('is-visible', show);
    original.classList.toggle('is-hidden-orig', show);
    if (show) syncPosition();
    ticking = false;
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(check);
      ticking = true;
    }
  }, { passive: true });
  window.addEventListener('resize', () => { syncPosition(); check(); }, { passive: true });

  syncPosition();
  check();
})();

/* =========================================================
   LINK PREVIEW — hover na .about__hl zobrazí preview kartičku
   (vanilla port LinkPreview komponenty s placeholder obrázkem)
   ========================================================= */
(function initLinkPreview() {
  const triggers = document.querySelectorAll('.about__hl');
  if (!triggers.length) return;
  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  // Sdílená kartička v body
  const card = document.createElement('div');
  card.className = 'preview-card';
  const img = document.createElement('img');
  img.alt = '';
  card.appendChild(img);
  document.body.appendChild(card);

  // Default placeholder; každý trigger může mít vlastní přes data-preview="..."
  const DEFAULT_PREVIEW = 'assets/photo-1.jpeg';
  const TOUCH_AUTOHIDE_MS = 3500;

  let activeTrigger = null;
  let activeRect = null;
  let targetTx = 0;
  let currentTx = 0;
  let hideTimer = null;

  function showFor(trigger) {
    img.src = trigger.dataset.preview || DEFAULT_PREVIEW;
    const rect = trigger.getBoundingClientRect();
    activeRect = rect;
    activeTrigger = trigger;
    const centerX = rect.left + rect.width / 2;
    const topY = rect.top;
    card.style.left = centerX + 'px';
    card.style.top = topY + 'px';
    targetTx = 0;
    currentTx = 0;
    requestAnimationFrame(() => card.classList.add('is-visible'));
  }

  function hide() {
    activeTrigger = null;
    activeRect = null;
    card.classList.remove('is-visible');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  triggers.forEach((trigger) => {
    if (isTouch) {
      // Touch: tap = toggle preview; outside tap nebo timeout = hide
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (activeTrigger === trigger) { hide(); return; }
        showFor(trigger);
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, TOUCH_AUTOHIDE_MS);
      });
    } else {
      trigger.addEventListener('mouseenter', () => showFor(trigger));
      trigger.addEventListener('mouseleave', hide);
      trigger.addEventListener('mousemove', (e) => {
        if (!activeRect) return;
        targetTx = (e.clientX - activeRect.left - activeRect.width / 2) / 2;
      });
    }
  });

  if (isTouch) {
    // Klik mimo trigger / kartu zavře preview
    document.addEventListener('click', (e) => {
      if (!activeTrigger) return;
      if (e.target.closest('.about__hl') || e.target.closest('.preview-card')) return;
      hide();
    });
    // Scroll nebo resize zruší preview (pozice by jinak utekla)
    window.addEventListener('scroll', () => { if (activeTrigger) hide(); }, { passive: true });
    window.addEventListener('resize', hide);
  }

  // Lerp tx pro spring-like sledování kurzoru (jen desktop, target stays 0 na touch)
  function tick() {
    currentTx += (targetTx - currentTx) * 0.15;
    card.style.setProperty('--tx', currentTx.toFixed(2) + 'px');
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

/* =========================================================
   PRICING — výběr varianty z tabulky → propíše do rezervace
   ========================================================= */
(function initPricingPicker() {
  const cells = document.querySelectorAll('.price-cell');
  const variantBox = document.getElementById('bookingVariant');
  const variantValue = document.getElementById('bookingVariantValue');
  const variantPrice = document.getElementById('bookingVariantPrice');
  const variantInput = document.getElementById('f-variant');
  const clearBtn = document.getElementById('bookingVariantClear');
  if (!cells.length || !variantBox) return;

  // Najdi popisek prostoru z thead na základě indexu sloupce
  const headerCells = document.querySelectorAll('.pricing__table thead th[data-space-label]');
  const spaceLabels = Array.from(headerCells).map((th) => th.dataset.spaceLabel);

  function selectCell(cell) {
    const price = cell.dataset.price;
    if (!price || price === '—') return; // prázdné buňky neaktivní
    cells.forEach((c) => c.classList.remove('is-selected'));
    cell.classList.add('is-selected');

    const row = cell.closest('tr');
    const tier = row ? row.dataset.tierLabel : '';
    // index sloupce = pořadí td v řádku (počítáme po odečtení th)
    const tds = Array.from(row.querySelectorAll('td'));
    const colIdx = tds.indexOf(cell);
    const space = spaceLabels[colIdx] || '';

    // Chip zobrazuje jen prostor + cenu (kompaktní jeden řádek).
    // Tier ukládáme do hidden inputu pro form data.
    variantValue.textContent = space;
    variantPrice.textContent = price;
    if (variantInput) variantInput.value = `${space} · ${tier} — ${price}`;
    variantBox.hidden = false;

    // Notifikuj kalendář o změně varianty (filtrování vytíženosti)
    document.dispatchEvent(new CustomEvent('variant:select', {
      detail: { space, tier },
    }));

    // Plynulý scroll končí u dolního okraje nadpisu „termín" — viewport top
    // = heading.bottom (tedy uživatel uvidí vše pod nadpisem: chip + form + kalendář).
    const heading = document.querySelector('.booking__heading');
    if (heading) {
      const targetY = heading.getBoundingClientRect().bottom + window.scrollY;
      smoothScrollToY(targetY, 1000);
    }
  }

  function smoothScrollToY(targetY, duration) {
    const startY = window.scrollY;
    const distance = targetY - startY;
    const startTime = performance.now();
    // Ease-out cubic — rychlý rozjezd, jemný doseděk, plynulé ve většině situací
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    // DŮLEŽITÉ: globální `html { scroll-behavior: smooth }` by každý
    // scrollTo() v RAF smyčce sám animoval → trhání. Vypneme ho na dobu
    // animace a po skončení vrátíme.
    const html = document.documentElement;
    const prevBehavior = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      window.scrollTo(0, startY + distance * ease(t));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        html.style.scrollBehavior = prevBehavior;
      }
    }
    requestAnimationFrame(step);
  }

  function clearSelection() {
    cells.forEach((c) => c.classList.remove('is-selected'));
    variantValue.textContent = '';
    variantPrice.textContent = '';
    if (variantInput) variantInput.value = '';
    variantBox.hidden = true;
    document.dispatchEvent(new CustomEvent('variant:clear'));
  }

  cells.forEach((cell) => {
    cell.addEventListener('click', () => selectCell(cell));
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectCell(cell);
      }
    });
  });

  if (clearBtn) clearBtn.addEventListener('click', clearSelection);
})();

/* =========================================================
   CALENDAR — vytíženost studia podle vybrané varianty
   Mock data: deterministický hash z (datum + prostor + varianta) → 3 stavy.
   ========================================================= */
(function initCalendar() {
  const grid = document.getElementById('calendarGrid');
  const titleEl = document.getElementById('calendarTitle');
  const hintEl = document.getElementById('calendarHint');
  const dateInput = document.getElementById('f-date');
  if (!grid || !titleEl) return;

  const MONTHS = [
    'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
    'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
  ];

  let cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  let selectedSpace = null;
  let selectedTier = null;
  let pickedISO = null;

  // Status čerpá ze sdíleného `dilnaAvailability` — stejné busy hodiny
   // jako time picker. Pokud space není vybrán, zobrazíme defaultní pohled
   // (pro Studio jako nejběžnější variantu).
  function getStatus(date, space, tier) {
    const sp = space || 'Studio';
    return window.dilnaAvailability.getDayStatus(iso(date), sp);
  }
  function iso(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function render() {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    titleEl.textContent = `${MONTHS[month]} ${year}`;
    grid.innerHTML = '';

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    // CZ: týden začíná pondělím. JS getDay: 0=Ne..6=So. Posun: (d+6)%7 → Po=0.
    const startDow = (firstDay.getDay() + 6) % 7;

    for (let i = 0; i < startDow; i++) {
      const blank = document.createElement('div');
      blank.className = 'calendar__day calendar__day--blank';
      grid.appendChild(blank);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = 1; d <= lastDay.getDate(); d++) {
      const date = new Date(year, month, d);
      const dateISO = iso(date);
      const cell = document.createElement('div');
      cell.className = 'calendar__day';
      cell.dataset.date = dateISO;
      cell.setAttribute('role', 'button');
      cell.setAttribute('tabindex', '0');

      const num = document.createElement('span');
      num.textContent = d;
      cell.appendChild(num);

      const isPast = date < today;
      let status = null;
      if (isPast) {
        cell.classList.add('calendar__day--past');
      } else {
        status = getStatus(date, selectedSpace, selectedTier);
        const dot = document.createElement('span');
        dot.className = `calendar__dot calendar__dot--${status}`;
        cell.appendChild(dot);
        if (status === 'busy') cell.classList.add('calendar__day--busy');
      }

      if (date.getTime() === today.getTime()) cell.classList.add('calendar__day--today');
      if (pickedISO === dateISO) cell.classList.add('calendar__day--selected');

      cell.setAttribute(
        'aria-label',
        `${d}. ${MONTHS[month]} ${year} — ${labelStatus(status, isPast)}`
      );

      if (!isPast) {
        // Busy dny jsou klikací taky — formulář si na ně ukáže varování.
        cell.addEventListener('click', () => pickDay(dateISO));
        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickDay(dateISO);
          }
        });
      }
      grid.appendChild(cell);
    }
  }

  function labelStatus(status, isPast) {
    if (isPast) return 'minulý termín';
    if (status === 'free') return 'volné';
    if (status === 'partial') return 'částečně obsazeno';
    if (status === 'busy') return 'obsazeno';
    return '';
  }

  function pickDay(dateISO) {
    pickedISO = dateISO;
    if (dateInput) {
      dateInput.value = dateISO;
      // Programatický `value =` nespustí 'change'/'input' — vyšleme manuálně,
      // aby je chytl initDateWarning a zobrazil hlášku u busy termínu.
      dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    render();
  }

  document.querySelectorAll('.calendar__nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = parseInt(btn.dataset.dir, 10) || 0;
      cursor.setMonth(cursor.getMonth() + dir);
      render();
    });
  });

  // Veřejná funkce — formulář si přes ni zjistí, jestli je vybrané datum obsazené
  window.dilnaGetDayStatus = function (dateISO) {
    if (!dateISO) return null;
    const d = new Date(dateISO + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d < today) return 'past';
    return getStatus(d, selectedSpace, selectedTier);
  };

  document.addEventListener('variant:select', (e) => {
    selectedSpace = e.detail.space || null;
    selectedTier = e.detail.tier || null;
    if (hintEl) {
      hintEl.textContent = `Vytíženost pro ${selectedSpace} — ${selectedTier}.`;
    }
    render();
    // Re-evaluate warning, protože varianta mohla změnit status právě vybraného data
    document.dispatchEvent(new CustomEvent('calendar:rerender'));
  });
  document.addEventListener('variant:clear', () => {
    selectedSpace = null;
    selectedTier = null;
    if (hintEl) {
      hintEl.textContent =
        'Vyberte cenu výše — kalendář ukáže vytíženost vybraného prostoru.';
    }
    render();
    document.dispatchEvent(new CustomEvent('calendar:rerender'));
  });
  // Po úspěšném odeslání — vyčistit i picked datum
  document.addEventListener('booking:reset', () => {
    pickedISO = null;
    render();
  });
  // Sheet data dorazila → re-render kalendáře s reálnými daty
  document.addEventListener('availability:loaded', render);

  render();
})();

/* =========================================================
   EMAIL GHOST — průhledné dopsání domény za kurzorem (visual only).
   - Do inputu se NIC nezapisuje, ghost je samostatný overlay span
   - Při Tab nebo blur se navržená doména automaticky doplní do hodnoty
   - Uživatel může psát cokoliv chce, ghost se průběžně přepočítává
   ========================================================= */
(function initEmailGhost() {
  const input = document.getElementById('f-email');
  const ghost = document.getElementById('emailGhost');
  if (!input || !ghost) return;

  const DOMAINS = [
    'gmail.com', 'seznam.cz', 'email.cz', 'icloud.com',
    'outlook.com', 'hotmail.com', 'centrum.cz', 'volny.cz',
    'protonmail.com', 'me.com', 'live.com', 'yahoo.com',
  ];

  let pendingFull = null; // celá navrhovaná adresa pro Tab/blur

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function update() {
    const value = input.value;
    const atIdx = value.indexOf('@');
    if (atIdx === -1 || atIdx === value.length - 0) {
      ghost.innerHTML = '';
      pendingFull = null;
      // pokud je přesně "@" napsané, nic nenavrhujeme
      if (atIdx !== value.length - 1) return;
    }
    if (atIdx === -1) { ghost.innerHTML = ''; pendingFull = null; return; }

    const local = value.slice(0, atIdx);
    const partial = value.slice(atIdx + 1).toLowerCase();
    if (!local) { ghost.innerHTML = ''; pendingFull = null; return; }

    const match = DOMAINS.find((d) => d.startsWith(partial));
    if (!match || match === partial) {
      ghost.innerHTML = '';
      pendingFull = null;
      return;
    }
    const suffix = match.slice(partial.length);
    // Renderuj: typed (transparent — drží šířku za input textem) + suffix (faded)
    ghost.innerHTML =
      `<span class="email-input__ghost-typed">${escapeHtml(value)}</span>${escapeHtml(suffix)}`;
    pendingFull = `${local}@${match}`;
  }

  function accept() {
    if (pendingFull && pendingFull !== input.value) {
      input.value = pendingFull;
      pendingFull = null;
      ghost.innerHTML = '';
    }
  }

  input.addEventListener('input', update);
  input.addEventListener('blur', accept);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && pendingFull) {
      // Tab přijme návrh a normální tab posun fokusu nechá projít
      accept();
    }
  });
})();

/* =========================================================
   FORM LOCK — formulář vlevo zšedne, dokud uživatel nevybere cenu
   v ceníku A datum v kalendáři. Po splnění se odemkne pro vyplnění.
   ========================================================= */
(function initFormLock() {
  const formCol = document.querySelector('.booking__form-col');
  const dateInput = document.getElementById('f-date');
  const calendar = document.getElementById('calendar');
  const lockBtn = document.getElementById('calendarLockBtn');
  if (!formCol || !dateInput) return;

  let hasTier = false;
  let hasDate = !!dateInput.value;

  function update() {
    formCol.classList.toggle('is-locked', !hasTier || !hasDate);
    if (calendar) calendar.classList.toggle('is-locked', !hasTier);
  }
  update();

  // Klik na lock overlay → odroluj k ceníku
  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      const pricing = document.getElementById('cenik');
      if (pricing) pricing.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  document.addEventListener('variant:select', () => { hasTier = true; update(); });
  document.addEventListener('variant:clear', () => { hasTier = false; update(); });
  const onDate = () => { hasDate = !!dateInput.value; update(); };
  dateInput.addEventListener('change', onDate);
  dateInput.addEventListener('input', onDate);
  document.addEventListener('booking:reset', () => { hasTier = false; hasDate = false; update(); });
})();

/* =========================================================
   FORM FIELDS — klik kdekoliv v boxu zaostří odpovídající input
   ========================================================= */
(function initFieldFocus() {
  document.querySelectorAll('.booking__form-col .field').forEach((field) => {
    field.addEventListener('click', (e) => {
      // Když uživatel klikl přímo do inputu/textarea/buttonu, browser to vyřeší sám
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'LI') return;
      const focusable = field.querySelector('input:not([type="hidden"]), textarea');
      if (focusable) focusable.focus();
    });
  });
})();

/* =========================================================
   PHONE INPUT — výběr země s vlaječkou + předvolbou
   ========================================================= */
(function initPhoneFlag() {
  const btn = document.getElementById('phoneFlagBtn');
  const menu = document.getElementById('phoneFlagMenu');
  const iconEl = document.getElementById('phoneFlagIcon');
  const codeEl = document.getElementById('phoneFlagCode');
  const prefixInput = document.getElementById('f-phone-prefix');
  if (!btn || !menu) return;

  const COUNTRIES = [
    { code: '+420', flag: '🇨🇿', name: 'Česko' },
    { code: '+421', flag: '🇸🇰', name: 'Slovensko' },
    { code: '+49',  flag: '🇩🇪', name: 'Německo' },
    { code: '+43',  flag: '🇦🇹', name: 'Rakousko' },
    { code: '+48',  flag: '🇵🇱', name: 'Polsko' },
    { code: '+36',  flag: '🇭🇺', name: 'Maďarsko' },
    { code: '+44',  flag: '🇬🇧', name: 'Velká Británie' },
    { code: '+1',   flag: '🇺🇸', name: 'USA / Kanada' },
    { code: '+33',  flag: '🇫🇷', name: 'Francie' },
    { code: '+39',  flag: '🇮🇹', name: 'Itálie' },
    { code: '+34',  flag: '🇪🇸', name: 'Španělsko' },
    { code: '+31',  flag: '🇳🇱', name: 'Nizozemsko' },
    { code: '+41',  flag: '🇨🇭', name: 'Švýcarsko' },
    { code: '+45',  flag: '🇩🇰', name: 'Dánsko' },
    { code: '+46',  flag: '🇸🇪', name: 'Švédsko' },
  ];
  let selected = COUNTRIES[0];

  COUNTRIES.forEach((c) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.code = c.code;
    li.innerHTML = `<span class="flag">${c.flag}</span><span class="name">${c.name}</span><span class="code">${c.code}</span>`;
    li.addEventListener('click', () => pick(c));
    menu.appendChild(li);
  });

  function pick(c) {
    selected = c;
    iconEl.textContent = c.flag;
    codeEl.textContent = c.code;
    if (prefixInput) prefixInput.value = c.code;
    menu.querySelectorAll('li').forEach((li) => {
      li.classList.toggle('is-selected', li.dataset.code === c.code);
    });
    closeMenu();
  }
  function openMenu() {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });

  pick(COUNTRIES[0]);
})();


/* =========================================================
   360° TOUR — Pannellum viewer s placeholder panoramatem.
   Až dostaneme vlastní 360 fotku studia, vyměníme `panorama` URL.
   ========================================================= */
(function setupTour() {
  const el = document.getElementById('tourViewer');
  if (!el) return;
  // Pannellum nahrajeme až když user doroluje k tour sekci
  window.dilnaLazyLib.loadOnIntersection(el, '400px', async () => {
    await window.dilnaLazyLib.loadCSS('https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css');
    await window.dilnaLazyLib.loadJS('https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js');
    initTour();
  });
})();

function initTour() {
  const el = document.getElementById('tourViewer');
  const loader = document.getElementById('tourLoader');
  const buttons = document.querySelectorAll('.tour__scene-btn');
  if (!el || typeof pannellum === 'undefined') return;

  // Placeholder panoramata — zatím dvě demo fotky z Pannellum, různé úhly,
  // ať každá scéna ukáže viditelně něco jiného. Až dorazí reálné 360 fotky
  // z natáčení studia, vyměníme `panorama` URL u každého klíče.
  const SCENES = {
    studio: {
      title: 'Studio',
      panorama: 'https://pannellum.org/images/cerro-toco-0.jpg',
      yaw: 0, pitch: 0,
    },
    cyklorama: {
      title: 'Cyklorama',
      panorama: 'https://pannellum.org/images/alma.jpg',
      yaw: 90, pitch: -10,
    },
    podcast: {
      title: 'Podcastová / konferenční',
      panorama: 'https://pannellum.org/images/cerro-toco-0.jpg',
      yaw: 180, pitch: 5,
    },
    chill: {
      title: 'Chill zóna',
      panorama: 'https://pannellum.org/images/alma.jpg',
      yaw: -90, pitch: 0,
    },
  };

  // Build Pannellum scenes config
  const scenes = {};
  Object.keys(SCENES).forEach((key) => {
    const s = SCENES[key];
    scenes[key] = {
      type: 'equirectangular',
      panorama: s.panorama,
      title: s.title,
      yaw: s.yaw,
      pitch: s.pitch,
      hfov: 100,
      autoRotate: -2,
      mouseZoom: false,
    };
  });

  const viewer = pannellum.viewer('tourViewer', {
    default: {
      firstScene: 'studio',
      sceneFadeDuration: 700,
      autoLoad: true,
      compass: false,
      showControls: false,
      showZoomCtrl: false,
      showFullscreenCtrl: false,
    },
    scenes,
  });

  function hideLoader() { if (loader) loader.classList.add('is-hidden'); }
  function showLoader() { if (loader) loader.classList.remove('is-hidden'); }
  viewer.on('load', hideLoader);
  viewer.on('scenechange', showLoader);
  viewer.on('error', (err) => { console.error('Tour error', err); hideLoader(); });
  setTimeout(hideLoader, 8000);

  // Šetření CPU: zastav autoRotate když user nemá kurzor na vieweru
  // (desktop) nebo když sekce není ve viewportu (oba).
  const ROTATE_SPEED = -2;
  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  function startRotate() { try { viewer.startAutoRotate(ROTATE_SPEED); } catch (_) {} }
  function stopRotate()  { try { viewer.stopAutoRotate(); } catch (_) {} }

  if (!isTouch) {
    // Desktop: hover-based pause
    el.addEventListener('mouseenter', startRotate);
    el.addEventListener('mouseleave', stopRotate);
    stopRotate(); // start paused — user musí hovrnout, ať se rozjede
  }
  // Pojistka pro oba (především mobilní): zastav když sekce mimo viewport
  if ('IntersectionObserver' in window) {
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        if (isTouch) startRotate();
      } else {
        stopRotate();
      }
    }, { threshold: 0.05 });
    obs.observe(el);
  }

  // Scene switcher
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const scene = btn.dataset.scene;
      if (!SCENES[scene]) return;
      buttons.forEach((b) => {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      viewer.loadScene(scene);
    });
  });
}

/* =========================================================
   DATE INPUT — zamez vyplnění data v minulosti (min atribut + JS guard)
   ========================================================= */
(function initDateMin() {
  const dateInput = document.getElementById('f-date');
  if (!dateInput) return;
  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  dateInput.min = todayISO();
  // Pokud uživatel přesto napíše minulé datum (typing), srovnej ho při blur
  dateInput.addEventListener('blur', () => {
    if (dateInput.value && dateInput.value < dateInput.min) {
      dateInput.value = '';
    }
  });
})();

/* =========================================================
   TIME PICKER — výběr času pronájmu propojený s variantou + datumem.

   Architektura:
   - Stav držíme v IIFE: aktuální (space, tier, basePrice), datum, picknutý čas.
   - Listenery: variant:select / variant:clear / f-date 'change'.
   - getBusyHours(dateISO, space) je "data layer" — teď deterministický mock,
     později to nahradíme fetchem z Google Sheet (stejný interface).
   - Hodinová sazba: range slot picker (klik = start, druhý klik = konec).
   - Půldenní: 3 fixní bloky (dopo / odpo / večer).
   - Celodenní: 1 fixní blok 9:00–19:00.
   - Cena: hodinová násobí počet započatých hodin × hourly_rate;
     půldenní/celodenní je fixní za blok.
   - Hidden inputy cas_od / cas_do / cena_celkem se zapisují do formuláře.
   ========================================================= */
(function initTimePicker() {
  const root = document.getElementById('timePicker');
  const fromInput = document.getElementById('f-time-from');
  const toInput = document.getElementById('f-time-to');
  const totalInput = document.getElementById('f-price-total');
  const dateInput = document.getElementById('f-date');
  if (!root) return;

  // Cenová matice — base ceny per (space, tier).
  // Klíče sedí na data-space-label v <th> a data-tier-label v <tr>.
  const PRICING = {
    'Studio': { hourly: 1200, mini: 4300, halfday: 7000, fullday: 11300 },
    'Podcastová / konferenční místnost': { hourly: 600, mini: 2160, halfday: 3500, fullday: 5600 },
    'Celé studio': { hourly: 1700, mini: 6100, halfday: 9900, fullday: 15900 },
  };
  // Slot-based: 30min granularita, provozní doba 8:00–22:00 = 28 slotů.
  // Slot 0 = 8:00, slot 1 = 8:30, ..., slot 27 = 21:30. End time slotu = (slot+1).
  const HOURLY_START = 8;
  const HOURLY_END = 22;
  const SLOT_MIN = 30;
  const SLOTS_PER_HOUR = 60 / SLOT_MIN;
  const TOTAL_SLOTS = (HOURLY_END - HOURLY_START) * SLOTS_PER_HOUR; // 28

  // Půldenní bloky 7 h = 14 slotů. Dva kontinuální bloky pokryjí celých 8:00–22:00.
  const HALF_DAY_OPTIONS = [
    { label: 'Dopoledne', fromSlot: 0,  toSlot: 14 }, // 8:00–15:00
    { label: 'Odpoledne', fromSlot: 14, toSlot: 28 }, // 15:00–22:00
  ];
  // Mini blok 4 h = 8 slotů. Tři neoverlapující bloky.
  const MINI_OPTIONS = [
    { label: 'Ráno',      fromSlot: 0,  toSlot: 8 },  // 8:00–12:00
    { label: 'Odpoledne', fromSlot: 10, toSlot: 18 }, // 13:00–17:00
    { label: 'Večer',     fromSlot: 20, toSlot: 28 }, // 18:00–22:00
  ];
  // Celý den 14 h = 28 slotů, 8:00–22:00.
  const FULL_DAY = { fromSlot: 0, toSlot: 28 };

  // Stav (pickStart/pickEnd jsou SLOT indexy, ne hodiny!)
  let space = null;
  let tier = null;
  let dateISO = null;
  let pickStart = null;
  let pickEnd = null;   // exkluzivní

  function getBusySlots(d, sp) {
    return window.dilnaAvailability.getBusySlots(d, sp);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function slotToTime(slot) {
    const total = HOURLY_START * SLOTS_PER_HOUR + slot;
    const hh = Math.floor(total / SLOTS_PER_HOUR);
    const mm = (total % SLOTS_PER_HOUR) * SLOT_MIN;
    return pad(hh) + ':' + pad(mm);
  }

  function clearPicked() {
    pickStart = null; pickEnd = null;
    fromInput.value = ''; toInput.value = ''; totalInput.value = '';
  }

  function tierKey() {
    if (!tier) return null;
    if (tier === 'Hodinová sazba') return 'hourly';
    if (tier.startsWith('Mini')) return 'mini';
    if (tier.startsWith('Půldenní')) return 'halfday';
    if (tier.startsWith('Celodenní')) return 'fullday';
    return null;
  }
  function basePrice() {
    if (!space || !tier) return 0;
    const k = tierKey();
    return (PRICING[space] && PRICING[space][k]) || 0;
  }

  // Total box (sdílený mezi time pickerem + overtime — viz window.dilnaTotal)
  const totalBox = document.getElementById('formTotal');
  const totalDetail = document.getElementById('formTotalDetail');
  const totalPrice = document.getElementById('formTotalPrice');
  const totalVat = document.getElementById('formTotalVat');
  const totalGrand = document.getElementById('formTotalGrand');
  const VAT_RATE = 0.21;

  function fmt(n) { return Math.round(n).toLocaleString('cs-CZ') + ' Kč'; }

  // Globální stav celkové ceny — time picker zapisuje base, overtime IIFE addon, crew IIFE addon.
  if (!window.dilnaTotal) {
    window.dilnaTotal = {
      base: 0, baseDetail: '', baseHours: 0,
      overtime: 0, overtimeDetail: '', overtimeHours: 0,
      crew: 0, crewDetail: '',
      render() {
        if (!totalBox) return;
        const sum = this.base + this.overtime + this.crew;
        if (sum === 0) { totalBox.hidden = true; return; }
        const vat = sum * VAT_RATE;
        const grand = sum + vat;
        if (totalDetail) {
          let html = this.baseDetail || '';
          if (this.overtime > 0 && this.overtimeDetail) html += this.overtimeDetail;
          if (this.crew > 0 && this.crewDetail) html += this.crewDetail;
          totalDetail.innerHTML = html;
        }
        if (totalPrice) totalPrice.textContent = fmt(sum);
        if (totalVat) totalVat.textContent = fmt(vat);
        if (totalGrand) totalGrand.textContent = fmt(grand);
        totalBox.hidden = false;
      },
    };
  }

  function showTotal(detail, total, hours) {
    window.dilnaTotal.base = total;
    window.dilnaTotal.baseDetail = detail;
    window.dilnaTotal.baseHours = hours || 0;
    window.dilnaTotal.render();
    document.dispatchEvent(new CustomEvent('time:change'));
  }
  function hideTotal() {
    window.dilnaTotal.base = 0;
    window.dilnaTotal.baseDetail = '';
    window.dilnaTotal.baseHours = 0;
    window.dilnaTotal.render();
    document.dispatchEvent(new CustomEvent('time:change'));
  }

  function render() {
    root.innerHTML = '';
    if (!space || !tier) {
      root.innerHTML = '<p class="time-picker__hint">Nejdřív vyberte cenu v ceníku výše.</p>';
      clearPicked();
      hideTotal();
      return;
    }
    if (!dateISO) {
      root.innerHTML = '<p class="time-picker__hint">Vyberte datum v kalendáři vpravo (nebo klikněte do pole Datum).</p>';
      clearPicked();
      hideTotal();
      return;
    }
    const busy = getBusySlots(dateISO, space);
    const k = tierKey();
    if (k === 'hourly') renderHourly(busy);
    else if (k === 'mini') renderMini(busy);
    else if (k === 'halfday') renderHalfDay(busy);
    else if (k === 'fullday') renderFullDay(busy);
  }

  function renderHourly(busy) {
    const row = document.createElement('div');
    row.className = 'time-picker__row';
    // Renderujeme TOTAL_SLOTS + 1 časových BODŮ (8:00 .. 22:00 = 29 tlačítek).
    // Každé tlačítko = jeden okamžik. Klik na "9:00" znamená opravdu 9:00,
    // ne "slot začínající v 9:00" jak to bylo dřív.
    for (let p = 0; p <= TOTAL_SLOTS; p++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'time-slot';
      btn.dataset.point = String(p);
      btn.textContent = slotToTime(p);

      // Selected/in-range podle bodů. pickStart i pickEnd jsou point indexy.
      if (pickStart !== null && pickEnd !== null) {
        if (p === pickStart || p === pickEnd) btn.classList.add('time-slot--selected');
        else if (p > pickStart && p < pickEnd) btn.classList.add('time-slot--in-range');
      } else if (pickStart !== null && p === pickStart) {
        btn.classList.add('time-slot--selected');
      }

      // Bod je nepoužitelný, jen pokud jsou oba sousední sloty obsazené (nebo neexistují).
      let unusable;
      if (p === 0) unusable = busy.has(0);
      else if (p === TOTAL_SLOTS) unusable = busy.has(TOTAL_SLOTS - 1);
      else unusable = busy.has(p - 1) && busy.has(p);

      // Body, které by daly zakázanou délku rezervace (0,5 h nebo 1,5 h),
      // se zobrazí jako disabled — zšednou a po hoveru ukážou důvod.
      let invalidDuration = false;
      if (!unusable && pickStart !== null && p !== pickStart) {
        if (pickEnd === null && p > pickStart) {
          const slots = p - pickStart;
          if (slots === 1 || slots === 3) invalidDuration = true;
        } else if (pickEnd !== null) {
          if (p > pickEnd) {
            const slots = p - pickStart;
            if (slots === 1 || slots === 3) invalidDuration = true;
          } else if (p < pickStart) {
            const slots = pickEnd - p;
            if (slots === 1 || slots === 3) invalidDuration = true;
          }
        }
      }

      if (unusable) {
        btn.classList.add('time-slot--busy');
      } else if (invalidDuration) {
        btn.classList.add('time-slot--disabled');
        btn.setAttribute('data-tooltip', 'Min. 1 h, od 2 h prodlužujete po půl hodině.');
        btn.setAttribute('aria-label', `${slotToTime(p)} — Min. 1 h, od 2 h prodlužujete po půl hodině.`);
      } else {
        btn.addEventListener('click', () => onSlotClick(p, busy));
      }

      row.appendChild(btn);
    }
    root.appendChild(row);

    const legend = document.createElement('div');
    legend.className = 'time-picker__legend';
    legend.innerHTML =
      '<span><i style="background:rgba(255,255,255,0.18)"></i>Volné</span>' +
      '<span><i style="background:#ef4444"></i>Obsazené</span>' +
      '<span><i style="background:var(--rust)"></i>Vybráno</span>';
    root.appendChild(legend);

    if (pickStart !== null && pickEnd !== null) {
      // Účtuje se po půlhodinových slotech: každý slot = polovina hodinové sazby.
      // Tím vychází: 1 h = rate, 2 h = 2× rate, 2,5 h = 2,5× rate, 3 h = 3× rate, …
      const slots = pickEnd - pickStart;
      const total = slots * (basePrice() / 2);
      const fromT = slotToTime(pickStart);
      const toT = slotToTime(pickEnd);
      const realH = (slots * 0.5).toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
      const amountStr = Math.round(total).toLocaleString('cs-CZ') + ' Kč';
      const detail =
        `<div class="total-line">` +
          `<div class="total-line__label">` +
            `<span class="total-line__name">${space} · ${realH} h</span>` +
            `<span class="total-line__sub">${fromT}–${toT} · ${basePrice().toLocaleString('cs-CZ')} Kč/h</span>` +
          `</div>` +
          `<span class="total-line__amount">${amountStr}</span>` +
        `</div>`;
      showTotal(detail, total, slots * 0.5);
      writeForm(fromT, toT, total);
    } else {
      hideTotal();
      const hint = document.createElement('p');
      hint.className = 'time-picker__hint';
      hint.textContent = pickStart === null
        ? 'Klikněte na čas začátku. Min. 1 h, od 2 h prodlužujete po půl hodině.'
        : `Začátek ${slotToTime(pickStart)}. Klikněte na čas konce — dalšími kliky můžete prodlužovat.`;
      root.appendChild(hint);
    }
  }

  // Povolené délky: 2 sloty (1 h), 4 sloty (2 h), 5+ slotů (2,5 h+ po 30 min).
  // Neplatné 1 (0,5 h) a 3 (1,5 h) → zaokrouhlíme nahoru na další povolenou.
  function snapSlots(n) {
    if (n < 2) return 2;
    if (n === 3) return 4;
    return n;
  }
  function rangeValid(from, to, busy) {
    if (from < 0 || to > TOTAL_SLOTS) return false;
    for (let x = from; x < to; x++) if (busy.has(x)) return false;
    return true;
  }

  // p = časový bod (0 = 8:00, 28 = 22:00). pickStart/pickEnd jsou point indexy.
  function onSlotClick(p, busy) {
    // Bod ve dvou posledních pozicích (21:30, 22:00) nemůže být start
    // — nezbývá 1 h k dispozici.
    const canStart = (idx) => idx <= TOTAL_SLOTS - 2;

    // Nic vybráno → nastav start.
    if (pickStart === null) {
      if (!canStart(p)) return;
      pickStart = p; pickEnd = null;
      render();
      return;
    }

    // Máme jen start → druhý klik = konec.
    if (pickEnd === null) {
      if (p <= pickStart) {
        if (!canStart(p)) return;
        pickStart = p; pickEnd = null;
        render();
        return;
      }
      const slots = snapSlots(p - pickStart);
      const newEnd = pickStart + slots;
      if (rangeValid(pickStart, newEnd, busy)) pickEnd = newEnd;
      else if (canStart(p)) { pickStart = p; pickEnd = null; }
      render();
      return;
    }

    // Range existuje. Klik za stávajícím koncem → prodlouž.
    if (p > pickEnd) {
      const slots = snapSlots(p - pickStart);
      const newEnd = pickStart + slots;
      if (rangeValid(pickStart, newEnd, busy)) pickEnd = newEnd;
      render();
      return;
    }

    // Klik před začátkem → prodlouž start dozadu.
    if (p < pickStart) {
      const slots = snapSlots(pickEnd - p);
      const newStart = pickEnd - slots;
      if (rangeValid(newStart, pickEnd, busy)) pickStart = newStart;
      render();
      return;
    }

    // Klik dovnitř → reset, nový start.
    if (!canStart(p)) return;
    pickStart = p; pickEnd = null;
    render();
  }

  // Sjednocená warning hláška pro busy bloky (půldenní i celodenní)
  const BUSY_WARNING = 'Tento termín je částečně obsazený. Pošlete nezávaznou poptávku — ozveme se vám s možnostmi.';

  // Pro paušální bloky (Mini, Půldenní, Celodenní) rozlišujeme tři stavy:
  //   'free'    — všechny sloty volné, plně dostupný blok
  //   'partial' — některé sloty obsazené → blok lze vybrat s upozorněním
  //   'full'    — všechny sloty obsazené → blok nelze vybrat
  function blockStatus(fromSlot, toSlot, busy) {
    let busyCount = 0;
    for (let s = fromSlot; s < toSlot; s++) if (busy.has(s)) busyCount++;
    if (busyCount === 0) return 'free';
    if (busyCount === toSlot - fromSlot) return 'full';
    return 'partial';
  }

  function renderMini(busy) {
    const row = document.createElement('div');
    row.className = 'time-picker__row';
    MINI_OPTIONS.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'time-slot time-slot--block';
      const fromT = slotToTime(opt.fromSlot);
      const toT = slotToTime(opt.toSlot);
      const status = blockStatus(opt.fromSlot, opt.toSlot, busy);
      btn.innerHTML = `${opt.label}<span class="time-slot__sub">${fromT}–${toT} · 4 h</span>`;
      if (status === 'full') btn.classList.add('time-slot--busy');
      else if (status === 'partial') btn.classList.add('time-slot--partial');
      if (pickStart === opt.fromSlot && pickEnd === opt.toSlot) btn.classList.add('time-slot--selected');
      if (status !== 'full') {
        btn.addEventListener('click', () => {
          pickStart = opt.fromSlot;
          pickEnd = opt.toSlot;
          render();
        });
      }
      row.appendChild(btn);
    });
    root.appendChild(row);

    if (pickStart !== null) {
      const pickedStatus = blockStatus(pickStart, pickEnd, busy);
      if (pickedStatus === 'partial') appendBusyWarning();
    }

    if (pickStart !== null) {
      const amountStr = Math.round(basePrice()).toLocaleString('cs-CZ') + ' Kč';
      const detail =
        `<div class="total-line">` +
          `<div class="total-line__label">` +
            `<span class="total-line__name">${space} · Mini blok 4 h</span>` +
            `<span class="total-line__sub">${slotToTime(pickStart)}–${slotToTime(pickEnd)}</span>` +
          `</div>` +
          `<span class="total-line__amount">${amountStr}</span>` +
        `</div>`;
      showTotal(detail, basePrice(), 4);
      writeForm(slotToTime(pickStart), slotToTime(pickEnd), basePrice());
    } else {
      hideTotal();
      const hint = document.createElement('p');
      hint.className = 'time-picker__hint';
      hint.textContent = 'Vyberte Ráno (8–12), Odpoledne (13–17) nebo Večer (18–22) — 4 h.';
      root.appendChild(hint);
    }
  }

  function renderHalfDay(busy) {
    const row = document.createElement('div');
    row.className = 'time-picker__row';
    HALF_DAY_OPTIONS.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'time-slot time-slot--block';
      const fromT = slotToTime(opt.fromSlot);
      const toT = slotToTime(opt.toSlot);
      const status = blockStatus(opt.fromSlot, opt.toSlot, busy);
      btn.innerHTML = `${opt.label}<span class="time-slot__sub">${fromT}–${toT} · 7 h</span>`;
      if (status === 'full') btn.classList.add('time-slot--busy');
      else if (status === 'partial') btn.classList.add('time-slot--partial');
      if (pickStart === opt.fromSlot && pickEnd === opt.toSlot) btn.classList.add('time-slot--selected');
      if (status !== 'full') {
        btn.addEventListener('click', () => {
          pickStart = opt.fromSlot;
          pickEnd = opt.toSlot;
          render();
        });
      }
      row.appendChild(btn);
    });
    root.appendChild(row);

    if (pickStart !== null) {
      const pickedStatus = blockStatus(pickStart, pickEnd, busy);
      if (pickedStatus === 'partial') appendBusyWarning();
    }

    if (pickStart !== null) {
      const amountStr = Math.round(basePrice()).toLocaleString('cs-CZ') + ' Kč';
      const detail =
        `<div class="total-line">` +
          `<div class="total-line__label">` +
            `<span class="total-line__name">${space} · Půldenní 7 h</span>` +
            `<span class="total-line__sub">${slotToTime(pickStart)}–${slotToTime(pickEnd)}</span>` +
          `</div>` +
          `<span class="total-line__amount">${amountStr}</span>` +
        `</div>`;
      showTotal(detail, basePrice(), 7);
      writeForm(slotToTime(pickStart), slotToTime(pickEnd), basePrice());
    } else {
      hideTotal();
      const hint = document.createElement('p');
      hint.className = 'time-picker__hint';
      hint.textContent = 'Vyberte Dopoledne (8–15) nebo Odpoledne (15–22) — 7 h.';
      root.appendChild(hint);
    }
  }

  function renderFullDay(busy) {
    const fromSlot = FULL_DAY.fromSlot;
    const toSlot = FULL_DAY.toSlot;
    const status = blockStatus(fromSlot, toSlot, busy);
    const row = document.createElement('div');
    row.className = 'time-picker__row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'time-slot time-slot--block';
    btn.innerHTML = `Celý den<span class="time-slot__sub">${slotToTime(fromSlot)}–${slotToTime(toSlot)} · 14 h</span>`;
    if (status === 'full') btn.classList.add('time-slot--busy');
    else if (status === 'partial') btn.classList.add('time-slot--partial');
    if (pickStart === fromSlot && pickEnd === toSlot) btn.classList.add('time-slot--selected');
    if (status !== 'full') {
      btn.addEventListener('click', () => {
        pickStart = fromSlot; pickEnd = toSlot; render();
      });
    }
    row.appendChild(btn);
    root.appendChild(row);

    if (status === 'partial' && pickStart !== null) appendBusyWarning();

    if (pickStart !== null) {
      const amountStr = Math.round(basePrice()).toLocaleString('cs-CZ') + ' Kč';
      const detail =
        `<div class="total-line">` +
          `<div class="total-line__label">` +
            `<span class="total-line__name">${space} · Celodenní 14 h</span>` +
            `<span class="total-line__sub">${slotToTime(pickStart)}–${slotToTime(pickEnd)}</span>` +
          `</div>` +
          `<span class="total-line__amount">${amountStr}</span>` +
        `</div>`;
      showTotal(detail, basePrice(), 14);
      writeForm(slotToTime(pickStart), slotToTime(pickEnd), basePrice());
    } else {
      hideTotal();
    }
  }

  function appendBusyWarning() {
    const w = document.createElement('p');
    w.className = 'field__warning';
    w.textContent = BUSY_WARNING;
    root.appendChild(w);
  }

  function appendTotal(detail, total, range) {
    const box = document.createElement('div');
    box.className = 'time-picker__total';
    box.innerHTML =
      `<span class="time-picker__total-label">Cena celkem</span>` +
      `<span class="time-picker__total-detail">${detail} · ${range}</span>` +
      `<span class="time-picker__total-price">${total.toLocaleString('cs-CZ')} Kč</span>`;
    root.appendChild(box);
  }

  function writeForm(from, to, total) {
    fromInput.value = from;
    toInput.value = to;
    totalInput.value = total;
  }

  // ===== Hooks na události =====
  document.addEventListener('variant:select', (e) => {
    space = e.detail.space || null;
    tier = e.detail.tier || null;
    pickStart = null; pickEnd = null; // změna varianty zruší výběr času
    render();
  });
  document.addEventListener('variant:clear', () => {
    space = null; tier = null;
    pickStart = null; pickEnd = null;
    render();
  });
  if (dateInput) {
    const onDate = () => {
      const v = dateInput.value;
      if (v !== dateISO) {
        dateISO = v || null;
        // Změna data = nový stav vytíženosti, zrušíme výběr
        pickStart = null; pickEnd = null;
        render();
      }
    };
    dateInput.addEventListener('change', onDate);
    dateInput.addEventListener('input', onDate);
  }

  // Sheet data dorazila → re-render aktuálních slotů s reálnou vytížeností
  document.addEventListener('availability:loaded', render);

  render();
})();

/* =========================================================
   TOAST — popup notifikace v rohu obrazovky, auto-dismiss po 4 s
   ========================================================= */
window.dilnaToast = (function () {
  const el = document.getElementById('toast');
  let hideTimer = null;
  function show(msg, duration = 4000) {
    if (!el) return;
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add('is-visible'));
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove('is-visible'), duration);
  }
  return { show };
})();

/* =========================================================
   FLASH PRICING ERROR — bliknou všechny cenové buňky červeně,
   pod tabulkou se objeví červený popup. Auto-dismiss po 4 s.
   ========================================================= */
function flashPricingError() {
  const cells = document.querySelectorAll('.price-cell');
  cells.forEach((cell) => {
    cell.classList.remove('is-flash');
    // Force reflow → animace se restartuje, i když ji někdo právě dohrával
    void cell.offsetWidth;
    cell.classList.add('is-flash');
  });
  setTimeout(() => cells.forEach((c) => c.classList.remove('is-flash')), 1500);

  const alertEl = document.getElementById('pricingAlert');
  if (alertEl) {
    alertEl.classList.add('is-visible');
    clearTimeout(alertEl._hideT);
    alertEl._hideT = setTimeout(() => alertEl.classList.remove('is-visible'), 4000);
  }
}

/* =========================================================
   OVERTIME — pronájem mimo provozní dobu (+50 % hodinové sazby)
   ========================================================= */
(function initOvertime() {
  const checkbox = document.getElementById('f-overtime-enabled');
  const detail = document.getElementById('overtimeDetail');
  const fromInput = document.getElementById('f-overtime-from');
  const toInput = document.getElementById('f-overtime-to');
  const rateLabel = document.getElementById('overtimeRate');
  const calcLabel = document.getElementById('overtimeCalc');
  const fromBtn = document.getElementById('otFromBtn');
  const fromValueEl = document.getElementById('otFromValue');
  const fromMenu = document.getElementById('otFromMenu');
  const toBtn = document.getElementById('otToBtn');
  const toValueEl = document.getElementById('otToValue');
  const toMenu = document.getElementById('otToMenu');
  if (!checkbox || !detail || !fromInput || !toInput || !rateLabel || !calcLabel) return;
  if (!fromBtn || !toBtn || !fromMenu || !toMenu) return;

  const pad2 = (n) => String(n).padStart(2, '0');

  // Přesčas-times: pouze mimo provozní dobu (8:00–22:00).
  // 22:00, 22:30, … 23:30, 00:00, 00:30, … 07:30, 08:00 (= start otevírací doby).
  function buildOvertimeOptions() {
    const opts = [];
    const startMin = 22 * 60;          // 22:00
    const endMin = 8 * 60 + 24 * 60;   // 08:00 následující den (= konec přesčasu, start provozu)
    for (let m = startMin; m <= endMin; m += 30) {
      const hh = Math.floor((m / 60) % 24);
      const mm = m % 60;
      opts.push(pad2(hh) + ':' + pad2(mm));
    }
    return opts;
  }

  function setupTimePop({ btn, valueEl, menuEl, hiddenInput, onChange }) {
    const opts = buildOvertimeOptions();
    opts.forEach((v) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'time-pop__opt';
      opt.dataset.value = v;
      opt.setAttribute('role', 'option');
      opt.textContent = v;
      opt.addEventListener('click', () => {
        if (opt.classList.contains('time-pop__opt--busy')) return; // sandwich = unselectable
        select(v); close();
      });
      menuEl.appendChild(opt);
    });
    function select(v) {
      valueEl.textContent = v;
      hiddenInput.value = v;
      menuEl.querySelectorAll('.time-pop__opt').forEach((o) =>
        o.classList.toggle('is-selected', o.dataset.value === v)
      );
      onChange();
    }
    function clear() {
      valueEl.textContent = '—:—';
      hiddenInput.value = '';
      menuEl.querySelectorAll('.is-selected').forEach((o) => o.classList.remove('is-selected'));
    }
    // Aplikace busy stavu z dilnaAvailability — busySlots je Set indexů
    // 18 přesčasových půlhodinových slotů (0 = 22:00–22:30, 17 = 06:30–07:00).
    // Každý čas. bod má slotBefore a slotAfter; pokud OBA jsou busy, bod nelze vybrat.
    function applyBusy(busySlots) {
      const allOpts = menuEl.querySelectorAll('.time-pop__opt');
      const total = allOpts.length; // 19
      allOpts.forEach((opt, idx) => {
        const slotBefore = idx === 0 ? true : busySlots.has(idx - 1);
        const slotAfter = idx === total - 1 ? true : busySlots.has(idx);
        const sandwich = slotBefore && slotAfter;
        opt.classList.toggle('time-pop__opt--busy', sandwich);
        // Označme i jednostranně-busy (slot vedle je obsazený) menším vizuálem
        const partial = (slotBefore || slotAfter) && !sandwich;
        opt.classList.toggle('time-pop__opt--partial', partial);
      });
    }
    function open() {
      menuEl.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const sel = menuEl.querySelector('.is-selected');
      if (sel) sel.scrollIntoView({ block: 'center' });
    }
    function close() {
      menuEl.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuEl.hidden) open(); else close();
    });
    document.addEventListener('click', (e) => {
      if (!menuEl.hidden && !btn.contains(e.target) && !menuEl.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menuEl.hidden) close();
    });
    return { select, clear, applyBusy };
  }

  const fromPop = setupTimePop({ btn: fromBtn, valueEl: fromValueEl, menuEl: fromMenu, hiddenInput: fromInput, onChange: () => recompute() });
  const toPop = setupTimePop({ btn: toBtn, valueEl: toValueEl, menuEl: toMenu, hiddenInput: toInput, onChange: () => recompute() });

  // Hodinové sazby per prostor — drží se shodně s time pickerem
  const HOURLY_RATES = {
    'Studio': 1200,
    'Podcastová / konferenční místnost': 600,
    'Celé studio': 1700,
  };
  const OVERTIME_MULT = 1.3;

  let space = null;

  function rateFor(sp) {
    if (!sp || !HOURLY_RATES[sp]) return 0;
    return Math.round(HOURLY_RATES[sp] * OVERTIME_MULT);
  }
  function fmtKc(n) { return Math.round(n).toLocaleString('cs-CZ') + ' Kč'; }

  function toMinutes(t) {
    if (!t) return null;
    const parts = String(t).split(':');
    if (parts.length < 2) return null;
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    return hh * 60 + mm;
  }
  // Minuty od 22:00 (start přesčasového okna). Po půlnoci vyjdou kladné
  // hodnoty (00:00 = 120, 07:00 = 540), 22:00 = 0. Umožňuje srovnat časy
  // přes půlnoc bez bordelu.
  function overtimeMinutes(t) {
    const m = toMinutes(t);
    if (m === null) return null;
    return ((m - 22 * 60) + 24 * 60) % (24 * 60);
  }
  // Účtujeme po půlhodinách: 30 min = 0,5 h. Vstupy jsou na 30 min,
  // takže výsledek je vždy násobek 0,5 (1, 1.5, 2, 2.5, …) — žádný ceil.
  function billedHoursFromRange(from, to) {
    const a = overtimeMinutes(from);
    const b = overtimeMinutes(to);
    if (a === null || b === null) return 0;
    const minutes = b - a;
    if (minutes <= 0) return 0;
    return minutes / 60;
  }

  function recompute() {
    const enabled = checkbox.checked;
    detail.hidden = !enabled;
    const rate = rateFor(space);
    rateLabel.textContent = rate ? `Sazba ${fmtKc(rate)} / hod (+30 %)` : 'Vyberte prostor v ceníku';
    if (!enabled || !rate) {
      calcLabel.textContent = '';
      window.dilnaTotal.overtime = 0;
      window.dilnaTotal.overtimeDetail = '';
      window.dilnaTotal.overtimeHours = 0;
      window.dilnaTotal.render();
      document.dispatchEvent(new CustomEvent('time:change'));
      return;
    }
    const hours = billedHoursFromRange(fromInput.value, toInput.value);
    const overtimeAmount = hours * rate;
    window.dilnaTotal.overtimeHours = hours;
    if (hours > 0) {
      const hoursStr = hours.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
      calcLabel.textContent = `${fromInput.value}–${toInput.value} · ${hoursStr} h × ${fmtKc(rate)} = ${fmtKc(overtimeAmount)}`;
      window.dilnaTotal.overtime = overtimeAmount;
      window.dilnaTotal.overtimeDetail =
        `<div class="total-line total-line--addon">` +
          `<div class="total-line__label">` +
            `<span class="total-line__name">Přesčas · ${hoursStr} h</span>` +
            `<span class="total-line__sub">${fromInput.value}–${toInput.value} · ${fmtKc(rate)}/h (+30 %)</span>` +
          `</div>` +
          `<span class="total-line__amount">${fmtKc(overtimeAmount)}</span>` +
        `</div>`;
    } else {
      calcLabel.textContent = fromInput.value || toInput.value ? 'Vyplňte oba časy.' : '';
      window.dilnaTotal.overtime = 0;
      window.dilnaTotal.overtimeDetail = '';
    }
    window.dilnaTotal.render();
    document.dispatchEvent(new CustomEvent('time:change'));
  }

  checkbox.addEventListener('change', recompute);

  // Sync busy stavu obou dropdownů s rezervacemi z Google Sheetu
  // (form date + space → 18 půlhodinových slotů přesčasu, evening + morning).
  const dateInput = document.getElementById('f-date');
  let formDate = dateInput ? dateInput.value : '';
  function refreshBusy() {
    const busy = (window.dilnaAvailability && space && formDate)
      ? window.dilnaAvailability.getOvertimeBusySlots(formDate, space)
      : new Set();
    if (fromPop.applyBusy) fromPop.applyBusy(busy);
    if (toPop.applyBusy) toPop.applyBusy(busy);
  }
  refreshBusy();

  document.addEventListener('variant:select', (e) => {
    space = e.detail.space || null;
    refreshBusy();
    recompute();
  });
  document.addEventListener('variant:clear', () => {
    space = null;
    refreshBusy();
    recompute();
  });
  if (dateInput) {
    const onDate = () => {
      formDate = dateInput.value || '';
      refreshBusy();
    };
    dateInput.addEventListener('change', onDate);
    dateInput.addEventListener('input', onDate);
  }
  document.addEventListener('availability:loaded', refreshBusy);
  document.addEventListener('booking:reset', () => {
    checkbox.checked = false;
    fromPop.clear();
    toPop.clear();
    space = null;
    refreshBusy();
    recompute();
  });
})();

/* =========================================================
   CREW — poptávka produkční / technické podpory
   Multi-select profesí, orientační cena = sumOf(rates) × hodiny rezervace
   (baseHours z time pickeru + overtimeHours z přesčasu).
   ========================================================= */
(function initCrew() {
  const checkbox = document.getElementById('f-crew-enabled');
  const detail = document.getElementById('crewDetail');
  const calcLabel = document.getElementById('crewCalc');
  const options = document.querySelectorAll('.crew-option input[type="checkbox"]');
  if (!checkbox || !detail || !calcLabel || !options.length) return;

  function fmtKc(n) { return Math.round(n).toLocaleString('cs-CZ') + ' Kč'; }

  function totalHours() {
    const a = (window.dilnaTotal && window.dilnaTotal.baseHours) || 0;
    const b = (window.dilnaTotal && window.dilnaTotal.overtimeHours) || 0;
    return a + b;
  }

  function recompute() {
    const enabled = checkbox.checked;
    detail.hidden = !enabled;
    if (!enabled) {
      calcLabel.textContent = '';
      window.dilnaTotal.crew = 0;
      window.dilnaTotal.crewDetail = '';
      window.dilnaTotal.render();
      return;
    }
    // Pro každou zatrženou roli načteme tři sazby: hodinovou, půldenní (5–7 h)
    // a denní (8+ h). Tiered pricing: ≤4 h hodinová × hours; 4–7 h půldenní paušál;
    // 7+ h denní paušál. Odpovídá běžnému pražskému trhu.
    const selected = [];
    options.forEach((opt) => {
      if (opt.checked) {
        const hourly = parseInt(opt.dataset.rate, 10) || 0;
        const halfDay = parseInt(opt.dataset.halfDayRate, 10) || (hourly * 7);
        const day = parseInt(opt.dataset.dayRate, 10) || (hourly * 14);
        selected.push({ name: opt.value, hourly, halfDay, day });
      }
    });
    const hours = totalHours();
    function tierFor(h, r) {
      if (h <= 4) return { fee: r.hourly * h, label: `${formatHours(h)} h × ${fmtKc(r.hourly)}/h` };
      if (h <= 7) return { fee: r.halfDay, label: `Půldenní paušál (${formatHours(h)} h)` };
      return { fee: r.day, label: `Denní paušál (${formatHours(h)} h)` };
    }
    function formatHours(h) {
      return h.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
    }
    if (selected.length === 0) {
      calcLabel.textContent = 'Vyberte alespoň jednu profesi.';
      window.dilnaTotal.crew = 0;
      window.dilnaTotal.crewDetail = '';
    } else if (hours === 0) {
      const sumH = selected.reduce((a, r) => a + r.hourly, 0);
      calcLabel.textContent = `${selected.map(r => r.name).join(', ')} · od ${fmtKc(sumH)}/h. Vyplňte čas pronájmu pro odhad ceny.`;
      window.dilnaTotal.crew = 0;
      window.dilnaTotal.crewDetail = '';
    } else {
      let totalCrew = 0;
      let lines = '';
      const tierName = hours <= 4 ? 'hodinová' : hours <= 7 ? 'půldenní' : 'denní';
      selected.forEach((r) => {
        const t = tierFor(hours, r);
        totalCrew += t.fee;
        lines +=
          `<div class="total-line total-line--addon">` +
            `<div class="total-line__label">` +
              `<span class="total-line__name">${r.name}</span>` +
              `<span class="total-line__sub">${t.label}</span>` +
            `</div>` +
            `<span class="total-line__amount">${fmtKc(t.fee)}</span>` +
          `</div>`;
      });
      calcLabel.textContent = `${selected.map(r => r.name).join(', ')} · ${tierName} sazba (${formatHours(hours)} h) ≈ ${fmtKc(totalCrew)}`;
      window.dilnaTotal.crew = totalCrew;
      window.dilnaTotal.crewDetail = lines;
    }
    window.dilnaTotal.render();
  }

  checkbox.addEventListener('change', recompute);
  options.forEach((opt) => opt.addEventListener('change', recompute));
  document.addEventListener('time:change', recompute);

  document.addEventListener('booking:reset', () => {
    checkbox.checked = false;
    options.forEach((opt) => { opt.checked = false; });
    const msg = document.getElementById('f-crew-msg');
    if (msg) msg.value = '';
    recompute();
  });
})();

/* =========================================================
   BOOKING FORM — AJAX submit přes Formspree, in-page feedback
   ========================================================= */
(function initBookingForm() {
  const form = document.getElementById('bookingForm');
  const submit = document.getElementById('bookingSubmit');
  const feedback = document.getElementById('formFeedback');
  if (!form || !submit || !feedback) return;

  function showFeedback(type, message) {
    feedback.className = 'form__feedback form__feedback--' + type;
    feedback.textContent = message;
    feedback.hidden = false;
  }

  function showSuccessAndReset() {
    const success = document.getElementById('bookingSuccess');
    if (!success) return;
    success.removeAttribute('hidden');
    // Force reflow → animace startuje od začátku, nesedí na předchozím stavu
    void success.offsetWidth;
    success.classList.add('is-visible');

    // Po 4 s plynule fadnout, pak resetovat formulář
    setTimeout(() => {
      success.classList.remove('is-visible');
      setTimeout(() => {
        success.setAttribute('hidden', '');
        resetBookingState();
      }, 500); // čas na fade-out
    }, 4000);
  }

  function resetBookingState() {
    form.reset();

    // Cenová varianta — odoznačit cell + skrýt chip + clear hidden input
    document.querySelectorAll('.price-cell.is-selected').forEach((c) =>
      c.classList.remove('is-selected')
    );
    const variantBox = document.getElementById('bookingVariant');
    if (variantBox) variantBox.hidden = true;
    const variantField = document.getElementById('f-variant');
    if (variantField) variantField.value = '';

    // Notifikace ostatním komponentám
    document.dispatchEvent(new CustomEvent('variant:clear'));
    document.dispatchEvent(new CustomEvent('booking:reset'));

    // Total box, time picker hidden inputs
    const totalBox = document.getElementById('formTotal');
    if (totalBox) totalBox.hidden = true;
    ['f-time-from', 'f-time-to', 'f-price-total'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // Email ghost (faded návrh domény)
    const emailGhost = document.getElementById('emailGhost');
    if (emailGhost) emailGhost.innerHTML = '';

    // Phone country picker zpět na default (CZ +420)
    const flagIcon = document.getElementById('phoneFlagIcon');
    const flagCode = document.getElementById('phoneFlagCode');
    const flagPrefix = document.getElementById('f-phone-prefix');
    if (flagIcon) flagIcon.textContent = '🇨🇿';
    if (flagCode) flagCode.textContent = '+420';
    if (flagPrefix) flagPrefix.value = '+420';

    // Skrýt jakoukoli formulářovou feedback
    feedback.hidden = true;

    // Date input — fire change event pro sync time pickeru
    const dateInput = document.getElementById('f-date');
    if (dateInput) dateInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    feedback.hidden = true;

    // 1) Cenová varianta — povinná. Bliknou všechny cenové buňky červeně
    //    a pod tabulkou se ukáže červený popup. Plus scroll k ceníku.
    const variantField = document.getElementById('f-variant');
    if (!variantField || !variantField.value) {
      flashPricingError();
      const pricing = document.getElementById('cenik');
      if (pricing) pricing.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // 2) Pole — nativní HTML5 validace (required atributy)
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    // 3) Čas pronájmu — buď běžný výběr (cas_od + cas_do), nebo přesčas
    //    (zaškrtnutý checkbox + prescas_od + prescas_do). Stačí jedno z nich.
    const timeFrom = document.getElementById('f-time-from');
    const timeTo = document.getElementById('f-time-to');
    const otOn = document.getElementById('f-overtime-enabled');
    const otFrom = document.getElementById('f-overtime-from');
    const otTo = document.getElementById('f-overtime-to');
    const hasRegular = !!(timeFrom && timeFrom.value && timeTo && timeTo.value);
    const hasOvertime = !!(otOn && otOn.checked && otFrom && otFrom.value && otTo && otTo.value);
    if (!hasRegular && !hasOvertime) {
      showFeedback('error', 'Vyberte čas pronájmu — buď v rámci provozní doby, nebo zaškrtněte „mimo rozmezí 8:00–22:00" a vyplňte časy.');
      return;
    }

    const labelEl = submit.querySelector('.btn-rust__label');
    const originalLabel = labelEl ? labelEl.textContent : '';
    if (labelEl) labelEl.textContent = 'Odesílám…';
    submit.disabled = true;

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        showSuccessAndReset();
      } else {
        // Pokus o JSON, fallback na text
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = null; }
        console.error('Formspree error', res.status, data || text);
        let msg;
        if (data && data.errors && data.errors.length) {
          msg = data.errors.map((e) => e.message || JSON.stringify(e)).join(' ');
        } else if (data && data.error) {
          msg = data.error;
        } else {
          msg = 'Server vrátil HTTP ' + res.status +
            '. Otevřete prosím F12 → Console a pošlete mi přesný text chyby, nebo napište na info@studiodilna.cz.';
        }
        showFeedback('error', msg);
      }
    } catch (_) {
      showFeedback('error',
        'Nepodařilo se připojit. Zkontrolujte internet a zkuste to znovu.'
      );
    } finally {
      if (labelEl) labelEl.textContent = originalLabel;
      submit.disabled = false;
    }
  });
})();

/* =========================================================
   MAP — Leaflet + Carto Positron, lazy-loaded při dorolování
   ========================================================= */
(function setupMap() {
  const el = document.getElementById('mapCanvas');
  if (!el) return;
  window.dilnaLazyLib.loadOnIntersection(el, '400px', async () => {
    await window.dilnaLazyLib.loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
    await window.dilnaLazyLib.loadJS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    initMap();
  });
})();

function initMap() {
  const el = document.getElementById('mapCanvas');
  if (!el || typeof L === 'undefined') return;

  // Studio Dílna — Přístavní 1315/7, Praha 7-Holešovice
  const COORDS = [50.10422, 14.44843];

  const map = L.map(el, {
    center: COORDS,
    zoom: 16,
    scrollWheelZoom: false,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  const pinIcon = L.divIcon({
    className: 'map-pin',
    html:
      '<span class="map-pin__pulse"></span>' +
      '<span class="map-pin__dot"></span>' +
      '<span class="map-pin__label">Studio Dílna</span>',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
  L.marker(COORDS, { icon: pinIcon, keyboard: false, interactive: false }).addTo(map);
}


/* =========================================================
   CONSENT — GDPR cookie banner + Google Consent Mode v2.
   Banner se ukáže při první návštěvě. Volba se uloží do localStorage
   na 12 měsíců. Footer odkaz „GDPR & cookies" otevře banner znovu.
   ========================================================= */
(function initConsent() {
  const STORAGE_KEY = 'dilna-consent-v1';
  const TTL_MS = 365 * 24 * 60 * 60 * 1000; // 12 měsíců
  // Vyplň, až budeš mít registrovaný Google Analytics 4 účet:
  const GA_MEASUREMENT_ID = 'G-91MF3Y991J';

  const root = document.getElementById('consent');
  const banner = document.getElementById('consentBanner');
  const modal = document.getElementById('consentModal');
  const analyticsToggle = document.getElementById('consentAnalytics');
  const marketingToggle = document.getElementById('consentMarketing');
  if (!root || !banner || !modal) return;

  // ---- Google Consent Mode v2 default state (vše denied) ----
  // Skript gtag se nahraje až po souhlasu, ale i tak inicializujeme dataLayer
  // pro budoucí volání.
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    'analytics_storage': 'denied',
    'ad_storage': 'denied',
    'ad_user_data': 'denied',
    'ad_personalization': 'denied',
    'wait_for_update': 500,
  });
  window.gtag('js', new Date());

  // ---- Storage ----
  function loadConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c.timestamp || Date.now() - c.timestamp > TTL_MS) return null;
      return c;
    } catch (_) { return null; }
  }
  function saveConsent(c) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch (_) {}
  }

  // ---- Apply consent → update gtag + load GA pokud potřeba ----
  let _gaLoaded = false;
  function loadGA() {
    if (_gaLoaded) return;
    if (!GA_MEASUREMENT_ID) return; // ID není nastavené → skript nezatěžovat
    _gaLoaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(s);
    window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
  }
  function applyConsent(c) {
    window.gtag('consent', 'update', {
      'analytics_storage': c.analytics ? 'granted' : 'denied',
      'ad_storage': c.marketing ? 'granted' : 'denied',
      'ad_user_data': c.marketing ? 'granted' : 'denied',
      'ad_personalization': c.marketing ? 'granted' : 'denied',
    });
    if (c.analytics) loadGA();
    document.dispatchEvent(new CustomEvent('consent:change', { detail: c }));
  }

  // ---- UI ----
  function showRoot() {
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('is-visible'));
  }
  function hideRoot() {
    root.classList.remove('is-visible');
    setTimeout(() => { root.hidden = true; }, 320);
  }
  function showBanner() {
    banner.hidden = false;
    modal.hidden = true;
    showRoot();
  }
  function showSettings(prefill) {
    banner.hidden = true;
    modal.hidden = false;
    analyticsToggle.checked = !!(prefill && prefill.analytics);
    marketingToggle.checked = !!(prefill && prefill.marketing);
    showRoot();
  }

  function commit(c) {
    const consent = {
      version: 1,
      timestamp: Date.now(),
      analytics: !!c.analytics,
      marketing: !!c.marketing,
    };
    saveConsent(consent);
    applyConsent(consent);
    hideRoot();
  }

  // ---- Init: pokud uživatel už rozhodl, jen aplikuj. Jinak ukaž banner. ----
  const stored = loadConsent();
  if (stored) {
    applyConsent(stored);
  } else {
    showBanner();
  }

  // ---- Klikací handlery (delegace) ----
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'accept-all') commit({ analytics: true, marketing: true });
    else if (act === 'reject') commit({ analytics: false, marketing: false });
    else if (act === 'settings') showSettings(loadConsent() || {});
    else if (act === 'save') commit({
      analytics: analyticsToggle.checked,
      marketing: marketingToggle.checked,
    });
    else if (act === 'close') hideRoot();
  });

  // ---- Hash trigger: index.html#consent otevře modal s nastavením ----
  // (Použité odkazem „Změnit nastavení cookies" z gdpr.html.)
  function maybeOpenFromHash() {
    if (window.location.hash === '#consent') {
      showSettings(loadConsent() || {});
      history.replaceState(null, '', window.location.pathname);
    }
  }
  maybeOpenFromHash();
  window.addEventListener('hashchange', maybeOpenFromHash);

  // Veřejné API pro budoucí integrace (např. Meta Pixel)
  window.dilnaConsent = {
    get: loadConsent,
    open: () => showSettings(loadConsent() || {}),
  };
})();

/* ===== GOOGLE REVIEWS =====
   Načte recenze studia z Google Places API a vyrenderuje je do .reviews__list.
   Vyžaduje:
     1) GOOGLE_PLACE_ID — Place ID studia (najdete přes Google Place ID Finder).
     2) GOOGLE_MAPS_API_KEY — API klíč s povolenými Maps JavaScript API + Places API,
        omezený na referrer studiodilna.cz/*.
   Lazy-load Maps JS pouze když se sekce dostane do viewportu (úspora ~150 kB
   na první návštěvě). Po načtení API zavolá PlacesService.getDetails. */
(function initGoogleReviews() {
  const PLACE_ID = 'ChIJwWO-2q-VC0cRUxUEKXBwvhw';
  const API_KEY  = 'AIzaSyC9Xh1zP08aeaVJ2Y3_TNSy5qfZaXY0wIQ';
  const MAX_REVIEWS = 5;          // Google API vrací max 5

  const list = document.getElementById('googleReviewsList');
  const ratingBox = document.getElementById('googleRatingSummary');
  const ratingValue = document.getElementById('googleRatingValue');
  const ratingCount = document.getElementById('googleRatingCount');
  const starsFill = document.getElementById('googleStarsFill');
  const allLink = document.getElementById('reviewsAllLink');
  if (!list) return;

  // Pokud klíče zatím nejsou, zobraz „připravujeme" placeholder a nedělej nic.
  if (!PLACE_ID || !API_KEY) {
    list.innerHTML = '<li class="review review--placeholder"><p class="review__quote">Recenze z Google se zobrazí, jakmile bude napojení dokončeno.</p></li>';
    return;
  }

  // Aktualizuj odkazy na Google profil
  if (allLink) allLink.href = 'https://search.google.com/local/reviews?placeid=' + encodeURIComponent(PLACE_ID);
  // Place ID se použije i v modálu pro Google CTA
  window.__dilnaPlaceId = PLACE_ID;

  let mapsLoading = false;
  let mapsLoaded = !!(window.google && window.google.maps && window.google.maps.places && window.google.maps.places.Place);

  function loadMapsApi() {
    return new Promise((resolve, reject) => {
      if (mapsLoaded) return resolve();
      if (mapsLoading) {
        const t = setInterval(() => {
          if (window.google && window.google.maps && window.google.maps.places && window.google.maps.places.Place) {
            clearInterval(t);
            mapsLoaded = true;
            resolve();
          }
        }, 100);
        return;
      }
      mapsLoading = true;
      const cb = '__gmapsReviewsCb_' + Math.random().toString(36).slice(2);
      window[cb] = () => { mapsLoaded = true; resolve(); delete window[cb]; };
      const s = document.createElement('script');
      s.async = true;
      s.defer = true;
      // loading=async — doporučovaný režim, eliminuje warning
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(API_KEY) +
              '&libraries=places&loading=async&callback=' + cb + '&v=weekly&language=cs';
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Nová Places API (Place class) — povinná pro účty po 1. 3. 2025.
  async function fetchPlaceDetails() {
    const Place = window.google.maps.places.Place;
    if (!Place) throw new Error('Places API (Place class) is not available');
    const place = new Place({ id: PLACE_ID, requestedLanguage: 'cs' });
    await place.fetchFields({
      fields: ['rating', 'userRatingCount', 'reviews'],
    });
    return place;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderRating(place) {
    if (!ratingBox || !place.rating) return;
    const pct = Math.max(0, Math.min(100, (place.rating / 5) * 100));
    ratingValue.textContent = place.rating.toFixed(1).replace('.', ',');
    ratingCount.textContent = (place.userRatingCount || 0) + ' recenzí na Google';
    // Drobné zpoždění pro plynulejší fill animaci po vykreslení
    requestAnimationFrame(() => { starsFill.style.width = pct + '%'; });
    ratingBox.hidden = false;
  }

  function renderReviews(reviews) {
    if (!reviews || !reviews.length) {
      list.innerHTML = '<li class="review review--placeholder"><p class="review__quote">Zatím žádné recenze. Buďte první!</p></li>';
      return;
    }
    const html = reviews.slice(0, MAX_REVIEWS).map((r, i) => {
      // Nová Places API: r.authorAttribution.displayName / .photoURI
      const author = (r.authorAttribution && r.authorAttribution.displayName) || '';
      const photo = (r.authorAttribution && r.authorAttribution.photoURI) || '';
      const text = r.text || '';
      const rating = r.rating || 0;
      const dateText = r.relativePublishTimeDescription || '';
      const initials = (author || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const avatar = photo
        ? `<span class="review__avatar" style="background-image:url('${escapeHtml(photo)}')"></span>`
        : `<span class="review__avatar">${escapeHtml(initials)}</span>`;
      const stars = '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating));
      return `
        <li class="review" style="animation-delay:${i * 80}ms">
          <div class="review__top">
            ${avatar}
            <div class="review__author-block">
              <span class="review__author">${escapeHtml(author)}</span>
              <span class="review__date">${escapeHtml(dateText)}</span>
            </div>
            <span class="review__rating" aria-label="${rating} z 5">${stars}</span>
          </div>
          <p class="review__quote">${escapeHtml(text)}</p>
        </li>`;
    }).join('');
    list.innerHTML = html;
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    loadMapsApi()
      .then(fetchPlaceDetails)
      .then(place => {
        renderRating(place);
        renderReviews(place.reviews);
      })
      .catch(err => {
        console.warn('[Google Reviews]', err);
        list.innerHTML = '<li class="review review--placeholder"><p class="review__quote">Recenze se nepodařilo načíst. Podívejte se na <a href="' + (allLink ? allLink.href : '#') + '" target="_blank" rel="noopener">Google profil</a>.</p></li>';
      });
  }

  // Lazy-load: načti až když se reviews dostanou do viewportu
  const reviewsEl = list.closest('.reviews');
  if ('IntersectionObserver' in window && reviewsEl) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { start(); io.disconnect(); break; }
      }
    }, { rootMargin: '200px' });
    io.observe(reviewsEl);
  } else {
    start();
  }
})();

/* ===== REVIEW MODÁL =====
   Modál se třemi kroky: choose (Google vs. napřímo) → form (Formspree) → thanks.
   Na webu se psaná recenze posílá e-mailem (Google neumožňuje API zápis recenzí).
   Po submitu nabízí CTA i k Google profilu pro veřejnou recenzi. */
(function initReviewModal() {
  const modal = document.getElementById('reviewModal');
  const openBtn = document.getElementById('reviewsWriteBtn');
  if (!modal || !openBtn) return;

  const steps = modal.querySelectorAll('[data-step]');
  const closeEls = modal.querySelectorAll('[data-rev-close]');
  const googleOpt = document.getElementById('reviewModalGoogle');
  const directOpt = document.getElementById('reviewModalDirect');
  const backBtn = document.getElementById('reviewModalBack');
  const form = document.getElementById('reviewForm');
  const stars = document.getElementById('revFormStars');
  const ratingInput = document.getElementById('revFormRating');
  const submitBtn = form.querySelector('.rev-form__submit');
  const submitLabel = form.querySelector('.rev-form__submit-label');
  const thanksGoogle = document.getElementById('reviewThanksGoogle');

  function showStep(name) {
    steps.forEach(s => { s.hidden = (s.dataset.step !== name); });
  }

  function googleWriteUrl() {
    const id = window.__dilnaPlaceId;
    return id
      ? 'https://search.google.com/local/writereview?placeid=' + encodeURIComponent(id)
      : 'https://maps.app.goo.gl/gTKptpRTpkgJQnJR6';
  }

  function open() {
    modal.hidden = false;
    showStep('choose');
    if (googleOpt) googleOpt.href = googleWriteUrl();
    if (thanksGoogle) thanksGoogle.href = googleWriteUrl();
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const focusEl = modal.querySelector('.rev-modal__close');
      if (focusEl) focusEl.focus();
    }, 50);
  }
  function close() {
    modal.hidden = true;
    document.body.style.overflow = '';
    // Reset formuláře pro příští otevření
    setTimeout(() => {
      try { form.reset(); } catch (_) {}
      ratingInput.value = '';
      stars.querySelectorAll('.rev-form__star').forEach(s => {
        s.classList.remove('is-active');
        s.setAttribute('aria-checked', 'false');
      });
      submitBtn.classList.remove('is-loading');
      submitBtn.disabled = false;
      submitLabel.textContent = 'Odeslat recenzi';
    }, 200);
  }

  openBtn.addEventListener('click', open);
  closeEls.forEach(el => el.addEventListener('click', close));
  document.addEventListener('keydown', (e) => {
    if (!modal.hidden && e.key === 'Escape') close();
  });

  if (directOpt) directOpt.addEventListener('click', () => showStep('form'));
  if (backBtn) backBtn.addEventListener('click', () => showStep('choose'));

  // Hvězdičky — klik nastaví hodnotu, hover ukazuje preview
  if (stars && ratingInput) {
    const starEls = Array.from(stars.querySelectorAll('.rev-form__star'));
    function paint(activeIdx, hoverIdx) {
      starEls.forEach((el, i) => {
        el.classList.toggle('is-active', i < activeIdx);
        el.classList.toggle('is-hover', hoverIdx >= 0 && i <= hoverIdx && i >= activeIdx);
      });
    }
    starEls.forEach((el, i) => {
      el.addEventListener('click', () => {
        ratingInput.value = String(i + 1);
        starEls.forEach(s => s.setAttribute('aria-checked', 'false'));
        el.setAttribute('aria-checked', 'true');
        paint(i + 1, -1);
      });
      el.addEventListener('mouseenter', () => paint(parseInt(ratingInput.value || '0', 10), i));
      el.addEventListener('focus', () => paint(parseInt(ratingInput.value || '0', 10), i));
    });
    stars.addEventListener('mouseleave', () => paint(parseInt(ratingInput.value || '0', 10), -1));
  }

  // Submit — fetch na Formspree, čekáme JSON odpověď
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!ratingInput.value) {
        alert('Vyberte prosím počet hvězdiček.');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');
      submitLabel.textContent = 'Odesílám…';
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body: new FormData(form),
        });
        if (res.ok) {
          showStep('thanks');
        } else {
          throw new Error('Formspree HTTP ' + res.status);
        }
      } catch (err) {
        console.warn('[Review submit]', err);
        alert('Odeslání se nepodařilo. Zkuste to prosím znovu, nebo nám napište na info@studiodilna.cz.');
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
        submitLabel.textContent = 'Odeslat recenzi';
      }
    });
  }
})();

/* ===== HERO GRID =====
   Statický jemný grid v pozadí hero sekce + vrstva odhalená pod kurzorem
   přes mask-image radial-gradient (CSS proměnné --mx/--my). Bez animace. */
(function initHeroGrid() {
  const grid = document.getElementById('heroGrid');
  if (!grid) return;
  const hero = grid.parentElement;

  hero.addEventListener('pointermove', (e) => {
    const r = grid.getBoundingClientRect();
    grid.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    grid.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  hero.addEventListener('pointerleave', () => {
    grid.style.setProperty('--mx', '-400px');
    grid.style.setProperty('--my', '-400px');
  });
})();
