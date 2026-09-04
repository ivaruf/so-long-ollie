/* =============================================================================
   Gopher Grid — game.js
   A cute gopher running around a bare-bones grid world. Vanilla JS + Babylon.js
   from CDN, no build step. Works from file:// (models are embedded as base64 in
   gopher-model.js, which may be missing — we fall back gracefully).

   Two forms share one pivot:
     walk  – the scarf gopher on foot (jump, sprint)
     fly   – the same gopher riding a cloud; entered with a double jump,
             hold Space to rise, Shift to sink, touch the ground to land

   The scenery (sky, meadow, clouds, banner) lives in world.js.

   Sections: config · helpers · boot · world · effects · characters · input ·
             movement & collision · procedural animation · main loop
   ============================================================================= */
'use strict';

(function main() {
  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /** Yaw correction (radians) for loaded models, applied in ONE place (the
   *  `modelYaw` node between each character holder and the glTF `__root__`).
   *  Models are authored to face +Z, so 0 is expected. */
  const MODEL_YAW_OFFSET = 0;

  /** Model names (assets/<name>.glb / keys in window.GOPHER_MODELS), in order of
   *  preference. The first one that loads wins. */
  const WALK_MODELS = ['gopher-scarf', 'gopher'];
  const FLY_MODELS = ['gopher-scarf-cloud'];

  const GROUND_SIZE = 40;
  const WORLD_HALF = 19.5;           // gopher clamped to ±WORLD_HALF on X/Z
  const GOPHER_RADIUS = 0.35;        // XZ collision circle

  // On foot
  const WALK_SPEED = 4;              // units/s
  const SPRINT_MULT = 1.7;
  const ACCEL = 20;                  // units/s² toward target velocity
  const DECEL = 24;
  const JUMP_SPEED = 6;              // apex ≈ 1 unit with GRAVITY = 18
  const GRAVITY = 18;

  // On the cloud
  const FLY_SPEED = 7;
  const FLY_ACCEL = 12;
  const FLY_DECEL = 9;
  const ASCEND_SPEED = 4.5;
  const DESCEND_SPEED = 5;
  const VERTICAL_RATE = 6;           // 1/s smoothing toward the wanted vertical speed
  const TAKEOFF_BOOST = 3;           // upward speed granted by the transformation
  const MAX_ALTITUDE = 12;
  const FALLBACK_CLOUD_LIFT = 0.28;  // rider height when the cloud is procedural

  const TURN_RATE = 12;              // 1/s exponential yaw smoothing
  const MAX_DT = 0.05;
  const CAMERA_TARGET_HEIGHT = 0.6;

  /** Node names inside the models (contract with the Blender side). Any of them
   *  may be missing in a given model; animation simply skips those. */
  const NODE_NAMES = [
    'Gopher', 'Body', 'Head', 'ArmL', 'ArmR', 'LegL', 'LegR', 'Tail', 'EyeL', 'EyeR',
    'Scarf', 'ScarfTailUpper', 'ScarfTailLower', 'Cloud',
  ];

  /** Deterministic obstacle layout: centre x/z + size w/h/d + look. Origin stays
   *  clear. world.js draws them; collision uses the box regardless of kind. */
  const OBSTACLES = [
    // boulders
    { kind: 'rock', x:   6, z:   5, w: 1.5, h: 1.5, d: 1.5 },
    { kind: 'rock', x:  -7, z:   6, w: 1.0, h: 1.0, d: 1.0 },
    { kind: 'rock', x:   8, z:  -6, w: 2.0, h: 2.0, d: 2.0 },
    { kind: 'rock', x:  -5, z:  -8, w: 1.2, h: 1.2, d: 1.2 },
    { kind: 'rock', x:  12, z:  11, w: 1.8, h: 1.8, d: 1.8 },
    { kind: 'rock', x: -13, z:  -4, w: 1.0, h: 1.0, d: 1.0 },
    { kind: 'rock', x:   3, z: -13, w: 1.4, h: 1.4, d: 1.4 },
    { kind: 'rock', x: -10, z:  13, w: 2.0, h: 2.0, d: 2.0 },
    // hedges (hoppable: jump apex is 1 unit)
    { kind: 'hedge', x:   0, z:  10, w: 6.0, h: 0.8, d: 0.6 },
    { kind: 'hedge', x: -12, z:   0, w: 0.6, h: 0.8, d: 6.0 },
    { kind: 'hedge', x:  13, z:  -2, w: 0.6, h: 1.0, d: 5.0 },
    { kind: 'hedge', x:   4, z:  -4, w: 4.0, h: 0.6, d: 0.6 },
    // a big tree to fly over (collision box is its trunk)
    { kind: 'tree', x:  -3, z: -15, w: 1.0, h: 4.5, d: 1.0 },
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const TWO_PI = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const randomRange = (lo, hi) => lo + Math.random() * (hi - lo);

  /** Frame-rate independent exponential smoothing toward `target`. */
  function damp(current, target, rate, dt) {
    return BABYLON.Scalar.Lerp(current, target, 1 - Math.exp(-rate * dt));
  }

  /** Wrap an angle to (-π, π]. */
  function wrapAngle(a) {
    let d = a % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    else if (d < -Math.PI) d += TWO_PI;
    return d;
  }

  /** Shortest-arc angle lerp in radians (Scalar.LerpAngle works in degrees). */
  function lerpAngle(a, b, t) {
    return a + wrapAngle(b - a) * t;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // Boot: engine, scene, UI handles
  // ---------------------------------------------------------------------------

  const ui = {
    loading: document.getElementById('loading'),
    status: document.getElementById('status'),
    mode: document.getElementById('mode'),
    hud: document.getElementById('hud'),
    btnB: document.querySelector('#touch .tbtn-b span'),
  };
  const hideLoading = () => { if (ui.loading) ui.loading.hidden = true; };
  const setStatus = (text) => {
    if (!ui.status) return;
    ui.status.textContent = text || '';
    ui.status.hidden = !text;
  };
  const setModeBadge = (text, flying) => {
    if (!ui.mode) return;
    ui.mode.textContent = text;
    ui.mode.classList.toggle('flying', flying);
    if (ui.btnB) ui.btnB.textContent = flying ? '\u25BC' : '\u00BB'; // sink / sprint
  };

  /** Touch device? Coarse pointer, or touch points on a phone/tablet-sized screen. */
  const IS_TOUCH = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    ((navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && Math.min(window.innerWidth, window.innerHeight) < 900);

  const canvas = document.getElementById('renderCanvas');
  if (typeof BABYLON === 'undefined') {
    if (ui.loading) ui.loading.textContent = 'Babylon.js failed to load (offline?)';
    return;
  }

  const engine = new BABYLON.Engine(canvas, true, { stencil: false });
  const scene = new BABYLON.Scene(engine);

  // ---- Camera: orbit around a point just above the gopher -------------------
  const cameraTarget = new BABYLON.TransformNode('cameraTarget', scene);
  cameraTarget.position.set(0, CAMERA_TARGET_HEIGHT, 0);

  const camera = new BABYLON.ArcRotateCamera(
    'camera', -Math.PI / 2, 1.1, 6, cameraTarget.position.clone(), scene
  );
  camera.lockedTarget = cameraTarget;
  camera.lowerRadiusLimit = 3;
  camera.upperRadiusLimit = 14;
  camera.lowerBetaLimit = 0.3;
  camera.upperBetaLimit = 1.5;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0;   // target is locked, no panning
  camera.minZ = 0.1;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput'); // WASD/arrows are ours

  // ---- Lights & shadows -----------------------------------------------------
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  hemi.diffuse = new BABYLON.Color3(0.78, 0.86, 1.0);
  hemi.groundColor = new BABYLON.Color3(0.30, 0.38, 0.26);

  const sunDir = new BABYLON.Vector3(-1, -2, -1).normalize();
  const sun = new BABYLON.DirectionalLight('sun', sunDir, scene);
  sun.position = sunDir.scale(-40);
  sun.intensity = 1.15;
  sun.diffuse = new BABYLON.Color3(1.0, 0.96, 0.88);
  sun.autoCalcShadowZBounds = true;

  const shadowGenerator = new BABYLON.ShadowGenerator(IS_TOUCH ? 1024 : 2048, sun);
  shadowGenerator.usePercentageCloserFiltering = true;
  shadowGenerator.filteringQuality = IS_TOUCH ? BABYLON.ShadowGenerator.QUALITY_LOW : BABYLON.ShadowGenerator.QUALITY_MEDIUM;
  shadowGenerator.bias = 0.003;
  shadowGenerator.normalBias = 0.03; // stops acne on faces lit at a grazing angle

  // ---------------------------------------------------------------------------
  // World: sky, meadow, obstacles, clouds and the banner (see world.js)
  // ---------------------------------------------------------------------------

  const world = window.GopherWorld.create(scene, shadowGenerator, {
    playHalf: WORLD_HALF,
    obstacles: OBSTACLES,
  });

  /** AABBs on the XZ plane for collision, with the top height (fly over). */
  const obstacleBounds = world.obstacleBounds;

  // ---------------------------------------------------------------------------
  // Effects: a white "poof" for the transformation
  // ---------------------------------------------------------------------------

  const poof = (() => {
    const COUNT = 14;
    const LIFETIME = 0.55;
    const mat = new BABYLON.StandardMaterial('poofMat', scene);
    mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
    mat.emissiveColor = new BABYLON.Color3(0.55, 0.57, 0.62);
    mat.specularColor = BABYLON.Color3.Black();

    const puffs = [];
    for (let i = 0; i < COUNT; i++) {
      const mesh = BABYLON.MeshBuilder.CreateSphere('poof' + i, { diameter: 1, segments: 6 }, scene);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.isVisible = false;
      puffs.push({ mesh, vel: new BABYLON.Vector3(), life: 0, size: 0.3 });
    }

    /** `momentum` (optional) is added to every puff so the burst travels with
     *  a moving gopher instead of being left behind. */
    function burst(center, momentum) {
      for (const p of puffs) {
        const dir = new BABYLON.Vector3(randomRange(-1, 1), randomRange(-0.3, 1), randomRange(-1, 1)).normalize();
        p.mesh.position.copyFrom(center).addInPlace(dir.scale(randomRange(0.05, 0.3)));
        p.mesh.position.y += 0.35;
        p.vel.copyFrom(dir).scaleInPlace(randomRange(1.5, 3.5));
        if (momentum) p.vel.addInPlace(momentum);
        p.size = randomRange(0.25, 0.5);
        p.life = 1;
        p.mesh.isVisible = true;
      }
    }

    function update(dt) {
      for (const p of puffs) {
        if (p.life <= 0) continue;
        p.life -= dt / LIFETIME;
        if (p.life <= 0) { p.mesh.isVisible = false; continue; }
        p.mesh.position.addInPlace(p.vel.scale(dt));
        p.vel.scaleInPlace(Math.max(0, 1 - 4 * dt)); // drag
        const s = p.size * (0.5 + 0.5 * p.life);
        p.mesh.scaling.set(s, s, s);
        p.mesh.visibility = Math.min(1, p.life * 1.5);
      }
    }

    return { burst, update };
  })();

  // ---------------------------------------------------------------------------
  // Characters: model loading (embedded → ../assets → fallbacks) and rest poses
  // ---------------------------------------------------------------------------

  /** All movement / yaw is applied to this pivot; the active character hangs below. */
  const gopher = new BABYLON.TransformNode('gopherPivot', scene);

  /** Base64 models from gopher-model.js (generated), if present. */
  const embeddedModels = (() => {
    if (window.GOPHER_MODELS && typeof window.GOPHER_MODELS === 'object') return window.GOPHER_MODELS;
    if (typeof window.GOPHER_GLB_B64 === 'string') return { gopher: window.GOPHER_GLB_B64 };
    return {};
  })();

  /** Try the embedded copy, then the sibling asset over http. Null if neither works. */
  async function importModel(name) {
    const b64 = embeddedModels[name];
    if (typeof b64 === 'string' && b64.length > 0) {
      try {
        const file = new File([base64ToBytes(b64)], name + '.glb');
        const result = await BABYLON.SceneLoader.ImportMeshAsync('', '', file, scene);
        if (result.meshes.length) return { result, source: 'gopher-model.js (embedded)' };
      } catch (err) {
        console.warn(`[gopher] embedded ${name} failed to load:`, err);
      }
    }
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', '../assets/', name + '.glb', scene);
      if (result.meshes.length) return { result, source: '../assets/' + name + '.glb' };
    } catch (err) {
      console.warn(`[gopher] ../assets/${name}.glb failed to load:`, err);
    }
    return null;
  }

  async function importFirst(names) {
    for (const name of names) {
      const loaded = await importModel(name);
      if (loaded) {
        console.info(`[gopher] ${name} loaded from ${loaded.source} (${loaded.result.meshes.length} meshes)`);
        return { name, ...loaded };
      }
    }
    return null;
  }

  /** Look up the contract nodes under `root`, convert quaternion rotation to
   *  Euler (the glTF loader sets rotationQuaternion, which makes `.rotation`
   *  writes a no-op), then store rest transforms. Animation is rest + offset. */
  function captureRestPose(root, label) {
    const byName = new Map();
    for (const node of root.getDescendants(false)) {
      if (!byName.has(node.name)) byName.set(node.name, node);
    }
    const parts = {};
    const found = [];
    const missing = [];
    NODE_NAMES.forEach((name) => {
      const node = byName.get(name);
      if (!node || !(node instanceof BABYLON.TransformNode)) {
        parts[name] = null;
        missing.push(name);
        return;
      }
      if (node.rotationQuaternion) {
        node.rotation = node.rotationQuaternion.toEulerAngles();
        node.rotationQuaternion = null;
      }
      parts[name] = {
        node,
        pos: node.position.clone(),
        rot: node.rotation.clone(),
        scl: node.scaling.clone(),
      };
      found.push(name);
    });
    console.info(`[gopher] ${label}: nodes found: ${found.join(', ') || '(none)'}` +
                 (missing.length ? ` | missing: ${missing.join(', ')}` : ''));
    return parts;
  }

  /**
   * Wrap a model root as a playable character:
   *   pivot → holder (pitch/roll/bob) → modelYaw (MODEL_YAW_OFFSET) → root
   * `__root__` from the glTF loader carries a rotationQuaternion + (1,1,-1)
   * scaling for the handedness conversion, so we never touch its transform.
   */
  function makeCharacter(name, root, meshes, animationGroups) {
    const holder = new BABYLON.TransformNode('holder:' + name, scene);
    holder.parent = gopher;
    const modelYaw = new BABYLON.TransformNode('modelYaw:' + name, scene);
    modelYaw.parent = holder;
    modelYaw.rotation.y = MODEL_YAW_OFFSET;
    root.parent = modelYaw;

    (animationGroups || []).forEach((g) => g.stop()); // procedural animation only
    meshes.forEach((m) => {
      if (m.getTotalVertices && m.getTotalVertices() > 0) shadowGenerator.addShadowCaster(m, false);
    });

    return { name, holder, root, parts: captureRestPose(root, name), lift: 0 };
  }

  function characterFromImport(loaded) {
    const root = loaded.result.meshes.find((m) => m.name === '__root__') || loaded.result.meshes[0];
    return makeCharacter(loaded.name, root, loaded.result.meshes, loaded.result.animationGroups);
  }

  /** Brown capsule + sphere head with the contract's node names. Last resort. */
  function buildPlaceholderGopher() {
    const fur = new BABYLON.StandardMaterial('placeholderFur', scene);
    fur.diffuseColor = new BABYLON.Color3(0.48, 0.32, 0.18);
    fur.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    const dark = new BABYLON.StandardMaterial('placeholderDark', scene);
    dark.diffuseColor = new BABYLON.Color3(0.05, 0.04, 0.04);
    dark.specularColor = new BABYLON.Color3(0.4, 0.4, 0.4);

    const root = new BABYLON.TransformNode('Gopher', scene);

    const body = BABYLON.MeshBuilder.CreateCapsule('Body', { height: 0.62, radius: 0.22 }, scene);
    body.position.y = 0.42;
    body.material = fur;
    body.parent = root;

    const head = new BABYLON.TransformNode('Head', scene);
    head.position.y = 0.68;
    head.parent = root;
    const headMesh = BABYLON.MeshBuilder.CreateSphere('HeadMesh', { diameter: 0.36 }, scene);
    headMesh.position.y = 0.14;
    headMesh.material = fur;
    headMesh.parent = head;
    [['EyeL', -0.07], ['EyeR', 0.07]].forEach(([name, x]) => {
      const eye = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 0.07 }, scene);
      eye.position.set(x, 0.18, 0.15);
      eye.material = dark;
      eye.parent = head;
    });
    const nose = BABYLON.MeshBuilder.CreateSphere('Nose', { diameter: 0.05 }, scene);
    nose.position.set(0, 0.11, 0.18);
    nose.material = dark;
    nose.parent = head;

    const limb = (name, x, y, z, length, radius) => {
      const joint = new BABYLON.TransformNode(name, scene);
      joint.position.set(x, y, z);
      joint.parent = root;
      const mesh = BABYLON.MeshBuilder.CreateCapsule(name + 'Mesh', { height: length, radius }, scene);
      mesh.position.y = -length / 2 + radius;
      mesh.material = fur;
      mesh.parent = joint;
    };
    limb('ArmL', -0.24, 0.56, 0.05, 0.28, 0.06);
    limb('ArmR',  0.24, 0.56, 0.05, 0.28, 0.06);
    limb('LegL', -0.11, 0.20, 0.00, 0.26, 0.075);
    limb('LegR',  0.11, 0.20, 0.00, 0.26, 0.075);

    const tail = new BABYLON.TransformNode('Tail', scene);
    tail.position.set(0, 0.3, -0.2);
    tail.parent = root;
    const tailMesh = BABYLON.MeshBuilder.CreateSphere('TailMesh', { diameter: 0.12 }, scene);
    tailMesh.position.z = -0.06;
    tailMesh.material = fur;
    tailMesh.parent = tail;

    return makeCharacter('placeholder', root, root.getChildMeshes(), []);
  }

  /** Procedural cloud (a fat ellipsoid plus puffs), bottom at y = 0. Used when
   *  the cloud-riding model is unavailable: the walking character sits on it. */
  function buildProceduralCloud() {
    const mat = new BABYLON.StandardMaterial('cloudMat', scene);
    mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
    mat.emissiveColor = new BABYLON.Color3(0.25, 0.26, 0.3);
    mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);

    const cloud = new BABYLON.TransformNode('Cloud', scene);
    cloud.parent = gopher;
    const base = BABYLON.MeshBuilder.CreateSphere('CloudBase', { diameter: 1, segments: 12 }, scene);
    base.scaling.set(0.95, 0.3, 0.6);
    base.position.y = 0.15;
    base.material = mat;
    base.parent = cloud;
    shadowGenerator.addShadowCaster(base, false);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TWO_PI;
      const puff = BABYLON.MeshBuilder.CreateSphere('CloudPuff' + i, { diameter: randomRange(0.25, 0.4), segments: 8 }, scene);
      puff.position.set(Math.cos(a) * 0.38, 0.14 + randomRange(0, 0.06), Math.sin(a) * 0.22);
      puff.material = mat;
      puff.parent = cloud;
      shadowGenerator.addShadowCaster(puff, false);
    }
    return cloud;
  }

  /** The two forms; `active` is whichever is currently shown. */
  const characters = { walk: null, fly: null };
  let fallbackCloud = null;   // only when fly reuses the walk character
  let active = null;

  function setActiveCharacter(which) {
    const next = characters[which];
    for (const c of new Set([characters.walk, characters.fly])) {
      if (c) c.holder.setEnabled(c === next);
    }
    if (fallbackCloud) fallbackCloud.setEnabled(which === 'fly');
    next.lift = (which === 'fly' && fallbackCloud) ? FALLBACK_CLOUD_LIFT : 0;
    // Reset any pose left over from the other mode.
    next.holder.rotation.set(0, 0, 0);
    next.holder.position.set(0, next.lift, 0);
    active = next;
  }

  async function loadCharacters() {
    const walk = await importFirst(WALK_MODELS);
    characters.walk = walk ? characterFromImport(walk) : buildPlaceholderGopher();
    if (!walk) setStatus('model missing – placeholder gopher');

    const fly = await importFirst(FLY_MODELS);
    if (fly) {
      characters.fly = characterFromImport(fly);
    } else {
      console.warn('[gopher] no cloud model – using the walking gopher on a procedural cloud');
      characters.fly = characters.walk;
      fallbackCloud = buildProceduralCloud();
    }
    setActiveCharacter('walk');
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  const input = { keys: new Set(), jumpRequested: false };
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

  function pressKey(code) {
    if (input.keys.has(code)) return;
    input.keys.add(code);
    if (code === 'Space') input.jumpRequested = true;
  }
  const releaseKey = (code) => input.keys.delete(code);

  window.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.code)) e.preventDefault(); // keep the page from scrolling
    if (e.repeat) return;
    pressKey(e.code);
  });
  window.addEventListener('keyup', (e) => releaseKey(e.code));
  window.addEventListener('blur', () => input.keys.clear());

  const isDown = (code) => input.keys.has(code);

  // ---------------------------------------------------------------------------
  // Touch controls: a floating stick on the left half, two buttons on the right.
  // Space (jump / rise) and Shift (sprint / sink) are the same as on a keyboard.
  // The info box is hidden on touch devices: figuring it out is part of the fun.
  // ---------------------------------------------------------------------------

  const touch = { active: false, x: 0, y: 0 }; // x: right, y: forward, each -1..1

  function setupTouchControls() {
    const root = document.getElementById('touch');
    if (!IS_TOUCH || !root) return;
    root.hidden = false;
    if (ui.hud) ui.hud.hidden = true;

    const zone = root.querySelector('.stick-zone');
    const base = root.querySelector('.stick-base');
    const knob = root.querySelector('.stick-knob');
    const RADIUS = 42;     // knob travel in px
    const DEAD = 0.12;
    let pointerId = null;
    let centre = { x: 0, y: 0 };

    const home = () => {
      const r = zone.getBoundingClientRect();
      return { x: r.left + 96, y: r.bottom - 96 };
    };
    // Client coords → zone-relative (the zone starts part-way down the screen).
    const placeBase = (x, y) => {
      const r = zone.getBoundingClientRect();
      base.style.left = (x - r.left) + 'px';
      base.style.top = (y - r.top) + 'px';
    };
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const rest = () => { const h = home(); placeBase(h.x, h.y); setKnob(0, 0); };
    rest();

    zone.addEventListener('pointerdown', (e) => {
      if (pointerId !== null) return;
      e.preventDefault();
      pointerId = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      centre = { x: e.clientX, y: e.clientY };
      placeBase(centre.x, centre.y);
      setKnob(0, 0);
      base.classList.add('live');
      touch.active = true;
      touch.x = 0;
      touch.y = 0;
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      let dx = e.clientX - centre.x;
      let dy = e.clientY - centre.y;
      const d = Math.hypot(dx, dy);
      if (d > RADIUS) { dx *= RADIUS / d; dy *= RADIUS / d; }
      setKnob(dx, dy);
      const nx = dx / RADIUS, ny = dy / RADIUS;
      const mag = Math.hypot(nx, ny);
      if (mag < DEAD) { touch.x = 0; touch.y = 0; return; }
      const k = ((mag - DEAD) / (1 - DEAD)) / mag; // rescale past the dead zone
      touch.x = nx * k;
      touch.y = -ny * k;                            // screen up = forward
    });
    const release = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      touch.active = false;
      touch.x = 0;
      touch.y = 0;
      base.classList.remove('live');
      rest();
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
    window.addEventListener('resize', () => { if (!touch.active) rest(); });

    const bindButton = (el, code) => {
      if (!el) return;
      const down = (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
        el.classList.add('active');
        pressKey(code);
      };
      const up = () => { el.classList.remove('active'); releaseKey(code); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    bindButton(root.querySelector('.tbtn-a'), 'Space');
    bindButton(root.querySelector('.tbtn-b'), 'ShiftLeft');
  }
  setupTouchControls();

  // ---------------------------------------------------------------------------
  // Movement & collision
  // ---------------------------------------------------------------------------

  const state = {
    mode: 'walk',        // 'walk' | 'fly'
    vx: 0, vz: 0, vy: 0,
    grounded: true,
    yaw: 0,
    yawRate: 0,          // smoothed rad/s, drives banking
    speed01: 0,          // horizontal speed / walk speed (0..1.7 on foot, 0..1 flying)
    vertical01: 0,       // flying: -1 sinking .. +1 rising
  };

  /** Camera forward projected on XZ, derived from the orbit angle. */
  function cameraForwardXZ() {
    return { x: -Math.cos(camera.alpha), z: -Math.sin(camera.alpha) };
  }

  /** Move horizontal velocity toward (tx, tz) by at most `maxDelta`. */
  function accelerateToward(tx, tz, maxDelta) {
    const dx = tx - state.vx;
    const dz = tz - state.vz;
    const d = Math.hypot(dx, dz);
    if (d <= maxDelta || d < 1e-9) {
      state.vx = tx;
      state.vz = tz;
      return;
    }
    state.vx += (dx / d) * maxDelta;
    state.vz += (dz / d) * maxDelta;
  }

  /** WASD/arrows → target horizontal velocity relative to the camera yaw. */
  function steerHorizontal(dt, maxSpeed, accel, decel) {
    let ix = (isDown('KeyD') || isDown('ArrowRight') ? 1 : 0) - (isDown('KeyA') || isDown('ArrowLeft') ? 1 : 0);
    let iz = (isDown('KeyW') || isDown('ArrowUp') ? 1 : 0) - (isDown('KeyS') || isDown('ArrowDown') ? 1 : 0);
    if (touch.active) { ix = touch.x; iz = touch.y; } // analog stick overrides keys

    const fwd = cameraForwardXZ();
    const dirX = fwd.x * iz + fwd.z * ix;  // right = (fwd.z, -fwd.x)
    const dirZ = fwd.z * iz - fwd.x * ix;
    const len = Math.hypot(dirX, dirZ);
    const hasInput = len > 1e-6;
    const strength = Math.min(1, len);      // partial stick deflection = slower

    const tx = hasInput ? (dirX / len) * maxSpeed * strength : 0;
    const tz = hasInput ? (dirZ / len) * maxSpeed * strength : 0;
    accelerateToward(tx, tz, (hasInput ? accel : decel) * dt);

    const pos = gopher.position;
    pos.x += state.vx * dt;
    pos.z += state.vz * dt;
  }

  /** Circle-vs-AABB push-out on XZ for boxes we are not above, then clamp to the
   *  world. Also removes the velocity component pointing into whatever we hit. */
  function resolveCollisions(pos) {
    const r = GOPHER_RADIUS;
    for (const b of obstacleBounds) {
      if (pos.y >= b.top) continue; // above it: fly (or hop) over
      const cx = clamp(pos.x, b.minX, b.maxX);
      const cz = clamp(pos.z, b.minZ, b.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;

      let nx;
      let nz;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        nz = dz / d;
        pos.x += nx * (r - d);
        pos.z += nz * (r - d);
      } else {
        // Centre is inside the box: leave through the nearest face.
        const toMinX = pos.x - b.minX;
        const toMaxX = b.maxX - pos.x;
        const toMinZ = pos.z - b.minZ;
        const toMaxZ = b.maxZ - pos.z;
        const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (m === toMinX)      { nx = -1; nz = 0; pos.x = b.minX - r; }
        else if (m === toMaxX) { nx = 1;  nz = 0; pos.x = b.maxX + r; }
        else if (m === toMinZ) { nx = 0;  nz = -1; pos.z = b.minZ - r; }
        else                   { nx = 0;  nz = 1;  pos.z = b.maxZ + r; }
      }
      const into = state.vx * nx + state.vz * nz;
      if (into < 0) {
        state.vx -= nx * into;
        state.vz -= nz * into;
      }
    }

    if (pos.x < -WORLD_HALF || pos.x > WORLD_HALF) {
      pos.x = clamp(pos.x, -WORLD_HALF, WORLD_HALF);
      state.vx = 0;
    }
    if (pos.z < -WORLD_HALF || pos.z > WORLD_HALF) {
      pos.z = clamp(pos.z, -WORLD_HALF, WORLD_HALF);
      state.vz = 0;
    }
  }

  /** Turn toward the direction of travel (local +Z forward); track the yaw rate. */
  function faceTravelDirection(dt, minSpeed) {
    const hSpeed = Math.hypot(state.vx, state.vz);
    const prevYaw = state.yaw;
    if (hSpeed > minSpeed) {
      const targetYaw = Math.atan2(state.vx, state.vz);
      state.yaw = lerpAngle(state.yaw, targetYaw, 1 - Math.exp(-TURN_RATE * dt));
    }
    state.yawRate = damp(state.yawRate, wrapAngle(state.yaw - prevYaw) / dt, 10, dt);
    gopher.rotation.y = state.yaw;
    return hSpeed;
  }

  // ---- Mode transitions -----------------------------------------------------

  function enterFlight() {
    state.mode = 'fly';
    state.grounded = false;
    state.vy = Math.max(state.vy, TAKEOFF_BOOST);
    setActiveCharacter('fly');
    poof.burst(gopher.position, new BABYLON.Vector3(state.vx, state.vy * 0.5, state.vz));
    triggerSquash();
    setModeBadge('on a cloud', true);
    cameraEaseUntil = time + 2.5;
    setStatus('hold Space to rise · Shift to sink · touch the ground to land');
  }

  function land() {
    state.mode = 'walk';
    state.grounded = true;
    state.vy = 0;
    state.vertical01 = 0;
    gopher.position.y = 0;
    setActiveCharacter('walk');
    poof.burst(gopher.position, new BABYLON.Vector3(state.vx, 0, state.vz));
    triggerSquash();
    setModeBadge('on foot', false);
    setStatus('');
    cameraEaseUntil = time + 2.0;
  }

  // ---- Per-mode updates -----------------------------------------------------

  function updateWalk(dt) {
    const sprint = isDown('ShiftLeft') || isDown('ShiftRight');
    steerHorizontal(dt, WALK_SPEED * (sprint ? SPRINT_MULT : 1), ACCEL, DECEL);
    const pos = gopher.position;
    resolveCollisions(pos);

    // Space: jump from the ground, or transform on a second press in the air.
    if (input.jumpRequested) {
      if (state.grounded) {
        state.vy = JUMP_SPEED;
        state.grounded = false;
        triggerSquash();
      } else {
        input.jumpRequested = false;
        enterFlight();
        return;
      }
    }
    input.jumpRequested = false;

    if (!state.grounded) {
      state.vy -= GRAVITY * dt;
      pos.y += state.vy * dt;
      if (pos.y <= 0) {
        pos.y = 0;
        state.vy = 0;
        state.grounded = true;
        triggerSquash();
      }
    }

    const hSpeed = faceTravelDirection(dt, 0.3);
    state.speed01 = clamp(hSpeed / WALK_SPEED, 0, 1.7);
  }

  function updateFly(dt) {
    input.jumpRequested = false; // Space is "rise" while flying
    steerHorizontal(dt, FLY_SPEED, FLY_ACCEL, FLY_DECEL);
    const pos = gopher.position;

    const up = isDown('Space');
    const down = isDown('ShiftLeft') || isDown('ShiftRight');
    const wantVy = up && !down ? ASCEND_SPEED : down && !up ? -DESCEND_SPEED : 0;
    state.vy = damp(state.vy, wantVy, VERTICAL_RATE, dt);
    pos.y += state.vy * dt;
    if (pos.y > MAX_ALTITUDE) {
      pos.y = MAX_ALTITUDE;
      state.vy = Math.min(state.vy, 0);
    }

    resolveCollisions(pos);
    const hSpeed = faceTravelDirection(dt, 0.3);
    state.speed01 = clamp(hSpeed / FLY_SPEED, 0, 1);
    state.vertical01 = clamp(state.vy / ASCEND_SPEED, -1, 1);

    if (pos.y <= 0) land();
  }

  /** For a couple of seconds after a transformation the camera eases to a
   *  framing that suits the new mode (more level and further back in the air),
   *  unless the player is dragging it. Otherwise it is left alone. */
  let cameraEaseUntil = 0;
  let pointerDown = false;
  scene.onPointerObservable.add((info) => {
    if (info.type === BABYLON.PointerEventTypes.POINTERDOWN) pointerDown = true;
    else if (info.type === BABYLON.PointerEventTypes.POINTERUP) pointerDown = false;
  });

  function updateCamera(dt) {
    const p = gopher.position;
    cameraTarget.position.x = p.x;
    cameraTarget.position.z = p.z;
    cameraTarget.position.y = damp(cameraTarget.position.y, p.y + CAMERA_TARGET_HEIGHT, 8, dt);

    if (time < cameraEaseUntil && !pointerDown) {
      const flying = state.mode === 'fly';
      camera.beta = damp(camera.beta, flying ? 1.42 : 1.1, 2.5, dt);
      camera.radius = damp(camera.radius, flying ? 8 : 6, 2.5, dt);
    }
  }

  // ---------------------------------------------------------------------------
  // Procedural animation
  // ---------------------------------------------------------------------------

  const anim = {
    phase: 0,                          // run-cycle phase
    run: 0,                            // blended run weight (0..1.7)
    air: 0,                            // blended airborne weight (0..1)
    fly: 0,                            // blended flying weight (0..1)
    squash: 0,                         // 1 → 0 after takeoff / landing / transform
    pitch: 0, roll: 0,                 // smoothed holder tilt while flying
    blinkTimer: randomRange(2.5, 5),
    blinkLeft: 0,
  };

  const triggerSquash = () => { anim.squash = 1; };

  // Every write is rest + offset (or rest × factor): nothing accumulates.
  function setRotation(part, dx, dy, dz) {
    if (part) part.node.rotation.set(part.rot.x + dx, part.rot.y + dy, part.rot.z + dz);
  }
  function setPosition(part, dx, dy, dz) {
    if (part) part.node.position.set(part.pos.x + dx, part.pos.y + dy, part.pos.z + dz);
  }
  function setScaling(part, sx, sy, sz) {
    if (part) part.node.scaling.set(part.scl.x * sx, part.scl.y * sy, part.scl.z * sz);
  }

  /** Shared by both forms: blink, scarf flutter, tail. */
  function animateCommon(P, t, dt, flutter) {
    // Blink: every 2.5–5 s, eyes squash to 10% height for ~120 ms.
    anim.blinkTimer -= dt;
    if (anim.blinkTimer <= 0) {
      anim.blinkLeft = 0.12;
      anim.blinkTimer = randomRange(2.5, 5);
    }
    let eyeY = 1;
    if (anim.blinkLeft > 0) {
      anim.blinkLeft -= dt;
      eyeY = 0.1;
    }
    setScaling(P.EyeL, 1, eyeY, 1);
    setScaling(P.EyeR, 1, eyeY, 1);

    // Scarf tails flap harder the faster we go (they stream out sideways).
    const f1 = Math.sin(t * 9 + 0.3) * (0.06 + 0.22 * flutter);
    const f2 = Math.sin(t * 11 + 1.7) * (0.08 + 0.28 * flutter);
    setRotation(P.ScarfTailUpper, 0, Math.cos(t * 6.5) * 0.12 * flutter, f1);
    setRotation(P.ScarfTailLower, 0, Math.cos(t * 7.3 + 0.9) * 0.16 * flutter, f2);
  }

  /** On foot: run cycle, idle breathing, jump tuck. */
  function animateWalk(P, t, dt, speed01, grounded) {
    anim.run = damp(anim.run, speed01, 10, dt);
    anim.air = damp(anim.air, grounded ? 0 : 1, 14, dt);
    const run = anim.run;
    const idle = 1 - Math.min(run, 1);
    const onGround = 1 - anim.air;

    if (speed01 >= 0.05) anim.phase += dt * (6 + 8 * speed01);
    const s = Math.sin(anim.phase);
    const s2 = Math.sin(anim.phase * 2);

    // Limbs: legs antiphase, arms antiphase to same-side leg; tuck when airborne.
    const legSwing = s * 0.9 * run * onGround;
    const armSwing = s * 0.6 * run;
    const tuck = -0.9 * anim.air;
    setRotation(P.LegL,  legSwing + tuck, 0, 0);
    setRotation(P.LegR, -legSwing + tuck, 0, 0);
    setRotation(P.ArmL, -armSwing, 0, 0);
    setRotation(P.ArmR,  armSwing, 0, 0);

    // Body: bob while running, breathe while idle.
    const breath = Math.sin(t * TWO_PI * 1.5) * 0.015 * idle;
    setPosition(P.Body, 0, Math.abs(s) * 0.06 * run, 0);
    setScaling(P.Body, 1 - breath, 1 + breath, 1);

    // Head: forward lean + pitch bob while running, gentle sway while idle.
    const headPitch = 0.12 * run + s2 * 0.05 * run + Math.sin(t * 0.9) * 0.03 * idle;
    const headYaw = Math.sin(t * 0.5) * 0.06 * idle;
    const headRoll = Math.sin(t * 0.7) * 0.05 * idle;
    setRotation(P.Head, headPitch, headYaw, headRoll);

    // Tail: double-frequency sway while running, slow wag while idle.
    setRotation(P.Tail, 0, s2 * 0.35 * run + Math.sin(t * 2.2) * 0.25 * idle, 0);

    animateCommon(P, t, dt, Math.min(run, 1) * 0.6);

    // Holder: level, at rest height.
    active.holder.rotation.set(0, 0, 0);
    active.holder.position.set(0, active.lift, 0);
  }

  /** On the cloud: hover bob, lean into speed, bank into turns, tucked legs,
   *  flapping arms while rising, pulsing cloud. */
  function animateFly(P, t, dt, speed01, vertical01) {
    anim.run = damp(anim.run, 0, 10, dt);
    anim.air = damp(anim.air, 0, 14, dt);
    const rise = Math.max(0, vertical01);
    const sink = Math.max(0, -vertical01);

    // Whole rider+cloud: bob, pitch and roll on the holder.
    const bob = Math.sin(t * 2.4) * 0.05 + Math.sin(t * 3.7) * 0.02;
    const wantPitch = 0.22 * speed01 - 0.18 * vertical01;       // +x pitches the nose down
    const wantRoll = clamp(-state.yawRate * 0.22, -0.4, 0.4);   // dip the inside of the turn
    anim.pitch = damp(anim.pitch, wantPitch, 6, dt);
    anim.roll = damp(anim.roll, wantRoll, 6, dt);
    active.holder.rotation.set(anim.pitch, 0, anim.roll);
    active.holder.position.set(0, active.lift + bob, 0);

    // Rider: sit with legs tucked, arms out; flap a little while rising.
    const flap = Math.sin(t * 13) * 0.35 * rise;
    setRotation(P.LegL, -1.2, 0, 0);
    setRotation(P.LegR, -1.2, 0, 0);
    setRotation(P.ArmL, -0.5 - 0.3 * speed01, 0, -0.55 - flap);
    setRotation(P.ArmR, -0.5 - 0.3 * speed01, 0,  0.55 + flap);

    const breath = Math.sin(t * TWO_PI * 1.2) * 0.012;
    setPosition(P.Body, 0, 0, 0);
    setScaling(P.Body, 1 - breath, 1 + breath, 1);

    // Head: look up when rising, down when sinking, gentle curiosity otherwise.
    const headPitch = -0.28 * rise + 0.22 * sink + Math.sin(t * 1.1) * 0.03;
    setRotation(P.Head, headPitch, Math.sin(t * 0.6) * 0.08 * (1 - speed01), 0);

    // Tail: happy wag, quicker with speed.
    setRotation(P.Tail, 0, Math.sin(t * (3 + 4 * speed01)) * 0.35, 0);

    // Cloud: soft pulse.
    const pulse = 1 + Math.sin(t * 3.1) * 0.03;
    setScaling(P.Cloud, pulse, 1 / pulse, pulse);
    if (fallbackCloud) {
      fallbackCloud.scaling.set(pulse, 1 / pulse, pulse);
      fallbackCloud.position.y = bob;
      fallbackCloud.rotation.set(anim.pitch, state.yaw, anim.roll);
    }

    animateCommon(P, t, dt, 0.4 + 0.6 * speed01);
  }

  function animateGopher(t, dt) {
    if (!active) return;
    const P = active.parts;

    if (state.mode === 'fly') animateFly(P, t, dt, state.speed01, state.vertical01);
    else animateWalk(P, t, dt, state.speed01, state.grounded);

    // Squash/stretch pulse on the pivot: 0→1→0 (y 0.85 / xz 1.1 at peak).
    anim.squash = Math.max(0, anim.squash - dt / 0.18);
    const k = Math.sin(anim.squash * Math.PI);
    gopher.scaling.set(1 + 0.1 * k, 1 - 0.15 * k, 1 + 0.1 * k);
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  let time = 0;

  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, MAX_DT);
    if (dt <= 0) return;
    time += dt;
    if (state.mode === 'fly') updateFly(dt);
    else updateWalk(dt);
    updateCamera(dt);
    animateGopher(time, dt);
    poof.update(dt);
    world.update(time, dt);
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  loadCharacters()
    .catch((err) => {
      // Belt and braces: never leave the world empty.
      console.error('[gopher] unexpected load error:', err);
      if (!characters.walk) characters.walk = buildPlaceholderGopher();
      if (!characters.fly) {
        characters.fly = characters.walk;
        if (!fallbackCloud) fallbackCloud = buildProceduralCloud();
      }
      setActiveCharacter('walk');
      setStatus('model failed – placeholder gopher');
    })
    .then(() => {
      setModeBadge('on foot', false);
      setStatus('psst… something is floating up in the clouds. Jump, then jump again!');
      hideLoading();
    });
})();
