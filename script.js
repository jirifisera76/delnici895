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

  // Lerp factor pro plynulý reverse — ~1.5s na úplnou změnu směru
  const SMOOTHING = 0.04;

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (!isHovered) {
      if (direction !== targetDirection) {
        direction += (targetDirection - direction) * SMOOTHING;
        if (Math.abs(direction - targetDirection) < 0.005) direction = targetDirection;
      }

      position += direction * speedPxPerSec * dt;

      // Wrap-around — duplikáty zaručují seamless přechod oběma směry
      if (position > 0) position -= wrapDist;
      else if (position < -wrapDist) position += wrapDist;

      track.style.transform = 'translateX(' + position.toFixed(2) + 'px)';
    }

    requestAnimationFrame(tick);
  }

  function scheduleReverse() {
    // 10–45 sekund
    const interval = 10000 + Math.random() * 35000;
    setTimeout(() => {
      targetDirection = -targetDirection;
      scheduleReverse();
    }, interval);
  }

  viewport.addEventListener('mouseenter', () => { isHovered = true; });
  viewport.addEventListener('mouseleave', () => {
    isHovered = false;
    lastTime = performance.now(); // restart dt clock
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
  const original = document.querySelector('.nav__menu a[href="#rezervace"]');
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

    const label = [space, tier].filter(Boolean).join(' · ');
    variantValue.textContent = label;
    variantPrice.textContent = price;
    if (variantInput) variantInput.value = `${label} — ${price}`;
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

  // Deterministický hash → mock vytíženost. Stejný den+prostor+varianta
  // dává vždy stejný stav (jinak by se kalendář mezi rendery „měnil sám").
  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function getStatus(date, space, tier) {
    const dow = date.getDay();
    if (dow === 0) return 'busy'; // neděle zavřeno
    const seed = hashCode(`${iso(date)}|${space || 'any'}|${tier || 'any'}`);
    const r = (seed % 100) / 100;
    if (r < 0.55) return 'free';
    if (r < 0.85) return 'partial';
    return 'busy';
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
        'Vyber cenu výše — kalendář ti ukáže vytíženost vybraného prostoru.';
    }
    render();
    document.dispatchEvent(new CustomEvent('calendar:rerender'));
  });

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
   DATE INPUT — varování když je termín pravděpodobně obsazený
   ========================================================= */
(function initDateWarning() {
  const dateInput = document.getElementById('f-date');
  const warning = document.getElementById('dateWarning');
  if (!dateInput || !warning) return;

  function check() {
    const val = dateInput.value;
    if (!val || typeof window.dilnaGetDayStatus !== 'function') {
      warning.hidden = true;
      return;
    }
    const status = window.dilnaGetDayStatus(val);
    warning.hidden = !(status === 'busy');
  }
  dateInput.addEventListener('change', check);
  dateInput.addEventListener('input', check);
  // varianta změnila vytíženost → re-check
  document.addEventListener('calendar:rerender', check);
})();
