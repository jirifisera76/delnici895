// Gravity playground — physics chips falling under the logo.
// Vanilla port of the matter-js React component shared by the user.
// Pills are rendered as DOM elements; matter.js drives the physics, we sync transforms each frame.

(function () {
  const container = document.getElementById('gravity');
  if (!container) return;
  if (typeof Matter === 'undefined') {
    console.warn('matter.js not loaded — gravity playground disabled.');
    return;
  }

  // Respect reduced motion preference: don't animate.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    container.style.display = 'none';
    return;
  }

  const { Engine, Render, Runner, Bodies, World, Mouse, MouseConstraint, Events, Query } = Matter;

  const LABELS = [
    'Video produkce',
    'Foto',
    'Podcast',
    'Workshopy',
    'Eventy',
    'Cyklorama',
    'Komerční focení',
    'Komunita',
    '150 m²',
    'Holešovice',
    'Denní světlo',
    'Industriál',
  ];

  // Curated palette — earthy/industrial with a few brighter accents.
  // Each entry: [background, text color, optional border (defaults to bg)].
  const PALETTE = [
    ['#0a0a0a', '#ffffff'],            // black
    ['#ffffff', '#0a0a0a', '#0a0a0a'], // white outlined
    ['#6e3d1e', '#ffffff'],            // brown (brand accent)
    ['#d4a574', '#1a0f08'],            // warm tan
    ['#2a3f4d', '#ffffff'],            // steel blue
    ['#c45a3e', '#ffffff'],            // terracotta
    ['#e8d5b7', '#0a0a0a', '#0a0a0a'], // cream outlined
    ['#5a7a3c', '#ffffff'],            // moss
    ['#f0c14b', '#1a0f08'],            // mustard
    ['#3d2817', '#f4e8d8'],            // espresso
  ];

  let engine, render, runner, mouseConstraint, frameId;
  let pills = [];
  let walls = [];
  let width = 0, height = 0;
  let mouseDown = false;

  function buildPills() {
    pills.forEach(({ el }) => el.remove());
    pills = [];

    LABELS.forEach((text, i) => {
      const el = document.createElement('div');
      el.className = 'gravity__pill';
      el.textContent = text;

      const [bg, fg, borderColor] = PALETTE[i % PALETTE.length];
      el.style.background = bg;
      el.style.color = fg;
      el.style.borderColor = borderColor || bg;

      container.appendChild(el);

      // Force layout so we can read measured dimensions.
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      // Initial position: scatter across the upper half, ready to drift upward and settle.
      const x = w / 2 + 20 + Math.random() * Math.max(40, width - w - 40);
      const y = h / 2 + 40 + Math.random() * Math.max(40, height * 0.55 - h);
      const angle = (Math.random() - 0.5) * 0.6;

      const body = Bodies.rectangle(x, y, w, h, {
        restitution: 0.55,
        friction: 0.05,
        frictionAir: 0.04, // higher air drag → mellow, levitating motion
        density: 0.0009,
        angle,
        chamfer: { radius: h / 2 },
        render: { visible: false },
      });

      World.add(engine.world, body);
      pills.push({ el, body, w, h });
    });
  }

  function buildWalls() {
    walls.forEach((w) => World.remove(engine.world, w));
    const opts = { isStatic: true, friction: 1, render: { visible: false } };
    walls = [
      Bodies.rectangle(width / 2, height + 30, width + 200, 60, opts),  // floor
      Bodies.rectangle(width / 2, -30, width + 200, 60, opts),          // ceiling — pills float against it
      Bodies.rectangle(-30, height / 2, 60, height * 3, opts),           // left
      Bodies.rectangle(width + 30, height / 2, 60, height * 3, opts),    // right
    ];
    World.add(engine.world, walls);
  }

  function syncDom() {
    pills.forEach(({ el, body, w, h }) => {
      const rotDeg = body.angle * (180 / Math.PI);
      el.style.transform = `translate(${body.position.x - w / 2}px, ${body.position.y - h / 2}px) rotate(${rotDeg}deg)`;
    });
    frameId = requestAnimationFrame(syncDom);
  }

  function init() {
    width = container.clientWidth;
    height = container.clientHeight;

    engine = Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = -0.18; // gentle upward pull — pills levitate toward the top

    render = Render.create({
      element: container,
      engine,
      options: { width, height, wireframes: false, background: 'transparent', pixelRatio: window.devicePixelRatio || 1 },
    });
    // Canvas is invisible (visuals come from DOM) but captures pointer events for dragging.
    render.canvas.classList.add('gravity__canvas');

    buildWalls();
    buildPills();

    const mouse = Mouse.create(render.canvas);
    mouseConstraint = MouseConstraint.create(engine, {
      mouse,
      constraint: { stiffness: 0.2, render: { visible: false } },
    });
    World.add(engine.world, mouseConstraint);
    render.mouse = mouse;

    // Cursor: grab when over a draggable body.
    const isOverBody = () => {
      const hits = Query.point(engine.world.bodies, mouseConstraint.mouse.position);
      return hits.some((b) => !b.isStatic);
    };
    Events.on(engine, 'beforeUpdate', () => {
      if (!render.canvas) return;
      if (mouseDown && isOverBody()) render.canvas.style.cursor = 'grabbing';
      else if (isOverBody()) render.canvas.style.cursor = 'grab';
      else render.canvas.style.cursor = 'default';
    });
    render.canvas.addEventListener('mousedown', () => { mouseDown = true; });
    render.canvas.addEventListener('mouseup', () => { mouseDown = false; });
    render.canvas.addEventListener('mouseleave', () => { mouseDown = false; });

    Render.run(render);
    runner = Runner.create();
    Runner.run(runner, engine);
    syncDom();
  }

  function destroy() {
    if (frameId) cancelAnimationFrame(frameId);
    if (mouseConstraint) World.remove(engine.world, mouseConstraint);
    if (render) {
      Mouse.clearSourceEvents(render.mouse);
      Render.stop(render);
      render.canvas && render.canvas.remove();
      render.textures = {};
    }
    if (runner) Runner.stop(runner);
    if (engine) {
      World.clear(engine.world, false);
      Engine.clear(engine);
    }
    pills.forEach(({ el }) => el.remove());
    pills = [];
    walls = [];
  }

  // Debounced resize: reset entirely so walls and spawn area follow the new size.
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      destroy();
      init();
    }, 350);
  });

  init();
})();
