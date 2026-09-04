/* =============================================================================
   Gopher Grid — game.js
   A cute gopher running around a bare-bones grid world. Vanilla JS + Babylon.js
   from CDN, no build step. Works from file:// (model is embedded as base64 in
   gopher-model.js, which may be missing — we fall back gracefully).

   Sections: config · helpers · boot · world · gopher model · input · movement
             & collision · procedural animation · main loop
   ============================================================================= */
'use strict';

(function main() {
  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /** Yaw correction (radians) for the loaded model, applied in ONE place
   *  (the `gopherModelYaw` node between the pivot and the glTF `__root__`).
   *  Model is authored to face +Z, so 0 is expected. */
  const MODEL_YAW_OFFSET = 0;

  const GROUND_SIZE = 40;
  const WORLD_HALF = 19.5;           // gopher clamped to ±WORLD_HALF on X/Z
  const GOPHER_RADIUS = 0.35;        // XZ collision circle
  const WALK_SPEED = 4;              // units/s
  const SPRINT_MULT = 1.7;
  const ACCEL = 20;                  // units/s² toward target velocity
  const DECEL = 24;
  const TURN_RATE = 12;              // 1/s exponential yaw smoothing
  const JUMP_SPEED = 6;              // apex ≈ 1 unit with GRAVITY = 18
  const GRAVITY = 18;
  const MAX_DT = 0.05;
  const CAMERA_TARGET_HEIGHT = 0.6;

  /** Node names inside the model (contract with the Blender side). */
  const NODE_NAMES = ['Gopher', 'Body', 'Head', 'ArmL', 'ArmR', 'LegL', 'LegR', 'Tail', 'EyeL', 'EyeR'];

  /** Deterministic obstacle layout: centre x/z + size w/h/d. Origin stays clear. */
  const OBSTACLES = [
    // cubes
    { x:   6, z:   5, w: 1.5, h: 1.5, d: 1.5 },
    { x:  -7, z:   6, w: 1.0, h: 1.0, d: 1.0 },
    { x:   8, z:  -6, w: 2.0, h: 2.0, d: 2.0 },
    { x:  -5, z:  -8, w: 1.2, h: 1.2, d: 1.2 },
    { x:  12, z:  11, w: 1.8, h: 1.8, d: 1.8 },
    { x: -13, z:  -4, w: 1.0, h: 1.0, d: 1.0 },
    { x:   3, z: -13, w: 1.4, h: 1.4, d: 1.4 },
    { x: -10, z:  13, w: 2.0, h: 2.0, d: 2.0 },
    // low walls
    { x:   0, z:  10, w: 6.0, h: 0.8, d: 0.6 },
    { x: -12, z:   0, w: 0.6, h: 0.8, d: 6.0 },
    { x:  13, z:  -2, w: 0.6, h: 1.0, d: 5.0 },
    { x:   4, z:  -4, w: 4.0, h: 0.6, d: 0.6 },
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

  /** Shortest-arc angle lerp in radians (Scalar.LerpAngle works in degrees). */
  function lerpAngle(a, b, t) {
    let d = (b - a) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    else if (d < -Math.PI) d += TWO_PI;
    return a + d * t;
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
  };
  const hideLoading = () => { if (ui.loading) ui.loading.hidden = true; };
  const setStatus = (text) => {
    if (!ui.status) return;
    ui.status.textContent = text || '';
    ui.status.hidden = !text;
  };

  const canvas = document.getElementById('renderCanvas');
  if (typeof BABYLON === 'undefined') {
    if (ui.loading) ui.loading.textContent = 'Babylon.js failed to load (offline?)';
    return;
  }

  const engine = new BABYLON.Engine(canvas, true, { stencil: false });
  const scene = new BABYLON.Scene(engine);

  const skyColor = new BABYLON.Color3(0.13, 0.15, 0.19);
  scene.clearColor = new BABYLON.Color4(skyColor.r, skyColor.g, skyColor.b, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
  scene.fogColor = skyColor;
  scene.fogStart = 22;
  scene.fogEnd = 58;

  // ---- Camera: orbit around a point just above the gopher -------------------
  const cameraTarget = new BABYLON.TransformNode('cameraTarget', scene);
  cameraTarget.position.set(0, CAMERA_TARGET_HEIGHT, 0);

  const camera = new BABYLON.ArcRotateCamera(
    'camera', -Math.PI / 2, 1.1, 6, cameraTarget.position.clone(), scene
  );
  camera.lockedTarget = cameraTarget;
  camera.lowerRadiusLimit = 3;
  camera.upperRadiusLimit = 12;
  camera.lowerBetaLimit = 0.3;
  camera.upperBetaLimit = 1.45;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0;   // target is locked, no panning
  camera.minZ = 0.1;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput'); // WASD/arrows are ours

  // ---- Lights & shadows -----------------------------------------------------
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.45;
  hemi.groundColor = new BABYLON.Color3(0.25, 0.25, 0.3);

  const sunDir = new BABYLON.Vector3(-1, -2, -1).normalize();
  const sun = new BABYLON.DirectionalLight('sun', sunDir, scene);
  sun.position = sunDir.scale(-40);
  sun.intensity = 1.0;
  sun.autoCalcShadowZBounds = true;

  const shadowGenerator = new BABYLON.ShadowGenerator(1024, sun);
  shadowGenerator.usePercentageCloserFiltering = true;
  shadowGenerator.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
  shadowGenerator.bias = 0.003;
  shadowGenerator.normalBias = 0.05; // stops acne on faces lit at a grazing angle
  shadowGenerator.normalBias = 0.02;

  // ---------------------------------------------------------------------------
  // World: grid ground + box obstacles
  // ---------------------------------------------------------------------------

  /** Grid drawn on a 2D canvas: 5×5 cells per tile, heavier line on the tile
   *  edge → one heavy line every 5 cells once tiled across the ground. */
  function createGridMaterial() {
    const CELL_PX = 64;
    const CELLS_PER_TILE = 5;
    const size = CELL_PX * CELLS_PER_TILE;

    const tex = new BABYLON.DynamicTexture(
      'gridTexture', { width: size, height: size }, scene, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE
    );
    const ctx = tex.getContext();
    ctx.fillStyle = '#d7dbe0';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#b6bdc6';
    for (let i = 1; i < CELLS_PER_TILE; i++) {
      const p = i * CELL_PX;
      ctx.fillRect(p - 1, 0, 2, size);
      ctx.fillRect(0, p - 1, size, 2);
    }
    ctx.fillStyle = '#8b949f';
    ctx.fillRect(0, 0, 2, size);
    ctx.fillRect(size - 2, 0, 2, size);
    ctx.fillRect(0, 0, size, 2);
    ctx.fillRect(0, size - 2, size, 2);
    tex.update();

    // Dynamic textures default to clamping; the grid must tile across the ground.
    tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.uScale = GROUND_SIZE / CELLS_PER_TILE; // one cell = one world unit
    tex.vScale = GROUND_SIZE / CELLS_PER_TILE;
    tex.anisotropicFilteringLevel = 8;

    const mat = new BABYLON.StandardMaterial('gridMaterial', scene);
    mat.diffuseTexture = tex;
    mat.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);
    return mat;
  }

  const ground = BABYLON.MeshBuilder.CreateGround(
    'ground', { width: GROUND_SIZE, height: GROUND_SIZE, subdivisions: 1 }, scene
  );
  ground.material = createGridMaterial();
  ground.receiveShadows = true;

  /** AABBs on the XZ plane for collision. */
  const obstacleBounds = [];

  function createObstacles() {
    const palette = [
      new BABYLON.Color3(0.86, 0.87, 0.89),
      new BABYLON.Color3(0.72, 0.74, 0.77),
      new BABYLON.Color3(0.93, 0.93, 0.94),
    ];
    OBSTACLES.forEach((o, i) => {
      const box = BABYLON.MeshBuilder.CreateBox(
        'obstacle' + i, { width: o.w, height: o.h, depth: o.d }, scene
      );
      box.position.set(o.x, o.h / 2, o.z);

      const mat = new BABYLON.StandardMaterial('obstacleMat' + i, scene);
      mat.diffuseColor = palette[i % palette.length];
      mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
      box.material = mat;

      box.receiveShadows = true;
      shadowGenerator.addShadowCaster(box);

      obstacleBounds.push({
        minX: o.x - o.w / 2, maxX: o.x + o.w / 2,
        minZ: o.z - o.d / 2, maxZ: o.z + o.d / 2,
      });
    });
  }
  createObstacles();

  // ---------------------------------------------------------------------------
  // Gopher: pivot, model loading (embedded → ../assets → placeholder), rest pose
  // ---------------------------------------------------------------------------

  /** All movement / rotation is applied to this pivot; the model hangs below. */
  const gopher = new BABYLON.TransformNode('gopherPivot', scene);

  /** NODE_NAME -> { node, pos, rot, scl } rest transforms captured after load. */
  const parts = {};

  /** Parent the glTF `__root__` under the pivot via a yaw-correction node. */
  function attachLoadedModel(result, sourceLabel) {
    const root = result.meshes.find((m) => m.name === '__root__') || result.meshes[0];

    // `__root__` carries a rotationQuaternion + (1,1,-1) scaling that convert
    // glTF's right-handed space to Babylon's; we leave that untouched and put
    // the yaw offset on its own Euler node so the fix stays in one place.
    const modelYaw = new BABYLON.TransformNode('gopherModelYaw', scene);
    modelYaw.parent = gopher;
    modelYaw.rotation.y = MODEL_YAW_OFFSET;
    root.parent = modelYaw;

    // We animate procedurally; make sure baked clips (if any) don't fight us.
    (result.animationGroups || []).forEach((g) => g.stop());

    result.meshes.forEach((m) => {
      if (m.getTotalVertices && m.getTotalVertices() > 0) shadowGenerator.addShadowCaster(m, false);
    });
    console.info(`[gopher] model loaded from ${sourceLabel} (${result.meshes.length} meshes)`);
  }

  /** Brown capsule + sphere head, with the contract's node names so the same
   *  animation code drives it. Used only when no model can be loaded. */
  function buildPlaceholderGopher() {
    const fur = new BABYLON.StandardMaterial('placeholderFur', scene);
    fur.diffuseColor = new BABYLON.Color3(0.48, 0.32, 0.18);
    fur.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    const dark = new BABYLON.StandardMaterial('placeholderDark', scene);
    dark.diffuseColor = new BABYLON.Color3(0.05, 0.04, 0.04);
    dark.specularColor = new BABYLON.Color3(0.4, 0.4, 0.4);

    const root = new BABYLON.TransformNode('Gopher', scene);
    root.parent = gopher;

    const body = BABYLON.MeshBuilder.CreateCapsule('Body', { height: 0.62, radius: 0.22 }, scene);
    body.position.y = 0.42;
    body.material = fur;
    body.parent = root;

    // Head pivot at the neck, sphere above it, eyes + nose on the front (+Z).
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

    // Limbs: pivot node at the joint, capsule hanging down from it.
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

    root.getChildMeshes().forEach((m) => shadowGenerator.addShadowCaster(m, false));
  }

  async function loadGopherModel() {
    // 1) Embedded base64 GLB from gopher-model.js (works from file://).
    if (typeof window.GOPHER_GLB_B64 === 'string' && window.GOPHER_GLB_B64.length > 0) {
      try {
        const bytes = base64ToBytes(window.GOPHER_GLB_B64);
        const file = new File([bytes], 'gopher.glb');
        const result = await BABYLON.SceneLoader.ImportMeshAsync('', '', file, scene);
        if (result.meshes.length) return attachLoadedModel(result, 'gopher-model.js (embedded)');
      } catch (err) {
        console.warn('[gopher] embedded model failed to load:', err);
      }
    } else {
      console.info('[gopher] window.GOPHER_GLB_B64 is not defined (gopher-model.js missing?)');
    }

    // 2) Sibling asset over http.
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', '../assets/', 'gopher.glb', scene);
      if (result.meshes.length) return attachLoadedModel(result, '../assets/gopher.glb');
    } catch (err) {
      console.warn('[gopher] ../assets/gopher.glb failed to load:', err);
    }

    // 3) Placeholder so the game is always playable.
    console.warn('[gopher] no model available – using placeholder gopher');
    buildPlaceholderGopher();
    setStatus('model missing – placeholder gopher');
  }

  /** Look up the contract nodes, convert quaternion rotation to Euler (the glTF
   *  loader sets rotationQuaternion, which makes `.rotation` writes a no-op),
   *  then store rest transforms. Animation is always rest + offset. */
  function captureRestPose() {
    const found = [];
    const missing = [];
    NODE_NAMES.forEach((name) => {
      const node = scene.getNodeByName(name);
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
    console.info(`[gopher] nodes found: ${found.join(', ') || '(none)'}` +
                 (missing.length ? ` | missing: ${missing.join(', ')}` : ''));
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  const input = { keys: new Set(), jumpRequested: false };
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

  window.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.code)) e.preventDefault(); // keep the page from scrolling
    if (e.repeat) return;
    input.keys.add(e.code);
    if (e.code === 'Space') input.jumpRequested = true;
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));
  window.addEventListener('blur', () => input.keys.clear());

  const isDown = (code) => input.keys.has(code);

  // ---------------------------------------------------------------------------
  // Movement & collision
  // ---------------------------------------------------------------------------

  const state = { vx: 0, vz: 0, vy: 0, grounded: true, yaw: 0, speed01: 0 };

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

  /** Circle-vs-AABB push-out on XZ, then clamp to the world. Also removes the
   *  velocity component pointing into whatever we hit so we slide along it. */
  function resolveCollisions(pos) {
    const r = GOPHER_RADIUS;
    for (const b of obstacleBounds) {
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

  function updateMovement(dt) {
    // Input → world direction relative to the camera yaw (W = away from camera).
    const ix = (isDown('KeyD') || isDown('ArrowRight') ? 1 : 0) - (isDown('KeyA') || isDown('ArrowLeft') ? 1 : 0);
    const iz = (isDown('KeyW') || isDown('ArrowUp') ? 1 : 0) - (isDown('KeyS') || isDown('ArrowDown') ? 1 : 0);
    const sprint = isDown('ShiftLeft') || isDown('ShiftRight');

    const fwd = cameraForwardXZ();
    const dirX = fwd.x * iz + fwd.z * ix;  // right = (fwd.z, -fwd.x)
    const dirZ = fwd.z * iz - fwd.x * ix;
    const len = Math.hypot(dirX, dirZ);
    const hasInput = len > 1e-6;

    const maxSpeed = WALK_SPEED * (sprint ? SPRINT_MULT : 1);
    const tx = hasInput ? (dirX / len) * maxSpeed : 0;
    const tz = hasInput ? (dirZ / len) * maxSpeed : 0;
    accelerateToward(tx, tz, (hasInput ? ACCEL : DECEL) * dt);

    // Horizontal integration + collision.
    const pos = gopher.position;
    pos.x += state.vx * dt;
    pos.z += state.vz * dt;
    resolveCollisions(pos);

    // Jump / gravity / landing at y = 0.
    if (state.grounded && input.jumpRequested) {
      state.vy = JUMP_SPEED;
      state.grounded = false;
      triggerSquash();
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

    // Face the direction of travel (local +Z forward).
    const hSpeed = Math.hypot(state.vx, state.vz);
    if (hSpeed > 0.3) {
      const targetYaw = Math.atan2(state.vx, state.vz);
      state.yaw = lerpAngle(state.yaw, targetYaw, 1 - Math.exp(-TURN_RATE * dt));
      gopher.rotation.y = state.yaw;
    }
    state.speed01 = clamp(hSpeed / WALK_SPEED, 0, 1.7);
  }

  function updateCamera(dt) {
    const p = gopher.position;
    cameraTarget.position.x = p.x;
    cameraTarget.position.z = p.z;
    cameraTarget.position.y = damp(cameraTarget.position.y, p.y + CAMERA_TARGET_HEIGHT, 8, dt);
  }

  // ---------------------------------------------------------------------------
  // Procedural animation
  // ---------------------------------------------------------------------------

  const anim = {
    phase: 0,                          // run-cycle phase
    run: 0,                            // blended run weight (0..1.7)
    air: 0,                            // blended airborne weight (0..1)
    squash: 0,                         // 1 → 0 after takeoff / landing
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

  /**
   * @param {number} t        total time (s)
   * @param {number} dt       frame delta (s)
   * @param {number} speed01  current speed / walk speed, 0..1.7
   * @param {boolean} grounded
   */
  function animateGopher(t, dt, speed01, grounded) {
    // Blend weights are lerped, never switched.
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
    setRotation(parts.LegL,  legSwing + tuck, 0, 0);
    setRotation(parts.LegR, -legSwing + tuck, 0, 0);
    setRotation(parts.ArmL, -armSwing, 0, 0);
    setRotation(parts.ArmR,  armSwing, 0, 0);

    // Body: bob while running, breathe while idle.
    const breath = Math.sin(t * TWO_PI * 1.5) * 0.015 * idle;
    setPosition(parts.Body, 0, Math.abs(s) * 0.06 * run, 0);
    setScaling(parts.Body, 1 - breath, 1 + breath, 1);

    // Head: forward lean + pitch bob while running, gentle sway while idle.
    const headPitch = 0.12 * run + s2 * 0.05 * run + Math.sin(t * 0.9) * 0.03 * idle;
    const headYaw = Math.sin(t * 0.5) * 0.06 * idle;
    const headRoll = Math.sin(t * 0.7) * 0.05 * idle;
    setRotation(parts.Head, headPitch, headYaw, headRoll);

    // Tail: double-frequency sway while running, slow wag while idle.
    const tailYaw = s2 * 0.35 * run + Math.sin(t * 2.2) * 0.25 * idle;
    setRotation(parts.Tail, 0, tailYaw, 0);

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
    setScaling(parts.EyeL, 1, eyeY, 1);
    setScaling(parts.EyeR, 1, eyeY, 1);

    // Jump squash on the pivot: a short 0→1→0 pulse (y 0.85 / xz 1.1 at peak).
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
    updateMovement(dt);
    updateCamera(dt);
    animateGopher(time, dt, state.speed01, state.grounded);
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  loadGopherModel()
    .catch((err) => {
      // Belt and braces: never leave the world empty.
      console.error('[gopher] unexpected load error:', err);
      if (!scene.getNodeByName('Gopher')) buildPlaceholderGopher();
      setStatus('model failed – placeholder gopher');
    })
    .then(() => {
      captureRestPose();
      hideLoading();
    });
})();
