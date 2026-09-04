/* =============================================================================
   Gopher Grid — world.js
   The living backdrop: sky dome, meadow ground, trees, bushes, flowers, grass,
   drifting clouds, a few butterflies, and the giant banner in the clouds.

   Exposes window.GopherWorld.create(scene, shadowGenerator, options) which
   builds everything and returns:
     { obstacleBounds, update(t, dt), banner }
   obstacleBounds holds { minX, maxX, minZ, maxZ, top } boxes for game.js's
   circle-vs-AABB collision (the visual obstacles plus every tree trunk).
   ============================================================================= */
'use strict';

(function () {
  const TWO_PI = Math.PI * 2;

  /** The message. Line 2 gets a drawn red heart after it (the "<3"). */
  const BANNER_LINES = ['Lykke til videre Mira!', 'En siste hilsen fra Ollie'];
  const BANNER = { x: 0, y: 8, z: 10, width: 16, height: 3.4 };

  /** Small deterministic PRNG so the meadow is laid out the same every visit. */
  function mulberry32(seed) {
    return function next() {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function create(scene, shadowGenerator, options) {
    const playHalf = options.playHalf;
    const rng = mulberry32(options.seed || 20260904);
    const rand = (lo, hi) => lo + rng() * (hi - lo);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const { Vector3, Color3, Color4, MeshBuilder, StandardMaterial, TransformNode } = BABYLON;

    const updaters = [];        // (t, dt) => void, run every frame
    const obstacleBounds = [];  // collision boxes handed back to the game
    const blockers = [];        // { x, z, r } circles vegetation must avoid

    const addCaster = (mesh) => { shadowGenerator.addShadowCaster(mesh, false); mesh.receiveShadows = true; };

    /** Bake a pile of static meshes into one (world-space) mesh to keep draw
     *  calls low. Sources are disposed; `roots` (their empty parents) too. */
    function mergeStatic(name, meshes, roots, shadows) {
      if (!meshes.length) return null;
      const merged = BABYLON.Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
      (roots || []).forEach((r) => r.dispose());
      if (!merged) return null;
      merged.name = name;
      merged.isPickable = false;
      if (shadows) addCaster(merged);
      return merged;
    }

    // ---- Shared materials ---------------------------------------------------
    function material(name, color, spec, emissive) {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = color;
      m.specularColor = new Color3(spec, spec, spec);
      if (emissive) m.emissiveColor = emissive;
      return m;
    }
    const M = {
      trunk: material('trunk', new Color3(0.42, 0.29, 0.18), 0.03),
      canopy: [
        material('canopy0', new Color3(0.30, 0.62, 0.30), 0.04),
        material('canopy1', new Color3(0.40, 0.71, 0.34), 0.04),
        material('canopy2', new Color3(0.24, 0.55, 0.33), 0.04),
      ],
      bush: [
        material('bush0', new Color3(0.36, 0.66, 0.33), 0.04),
        material('bush1', new Color3(0.30, 0.58, 0.31), 0.04),
      ],
      hedge: material('hedge', new Color3(0.33, 0.62, 0.31), 0.04),
      rock: material('rock', new Color3(0.60, 0.60, 0.62), 0.10),
      cloud: material('cloud', new Color3(1, 1, 1), 0.02, new Color3(0.32, 0.34, 0.38)),
    };

    // -------------------------------------------------------------------------
    // Sky: gradient dome + sun disc + fog that fades into the horizon colour
    // -------------------------------------------------------------------------
    function createSky() {
      const horizon = new Color3(0.80, 0.89, 0.97);
      const zenith = new Color3(0.34, 0.58, 0.88);
      scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
      scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
      scene.fogColor = horizon;
      scene.fogStart = 30;
      scene.fogEnd = 95;

      // Symmetric gradient (pale at the equator, deep at both poles) so the UV
      // orientation of the sphere does not matter.
      const H = 512;
      const tex = new BABYLON.DynamicTexture('skyGradient', { width: 4, height: H }, scene, false);
      const ctx = tex.getContext();
      for (let y = 0; y < H; y++) {
        const k = Math.pow(Math.abs(y / (H - 1) - 0.5) * 2, 0.75);
        ctx.fillStyle = Color3.Lerp(horizon, zenith, k).toHexString();
        ctx.fillRect(0, y, 4, 1);
      }
      tex.update();

      const dome = MeshBuilder.CreateSphere('sky', { diameter: 400, segments: 24, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
      const mat = new StandardMaterial('skyMat', scene);
      mat.emissiveTexture = tex;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.fogEnabled = false;
      mat.backFaceCulling = false;
      dome.material = mat;
      dome.infiniteDistance = true;
      dome.isPickable = false;
      dome.applyFog = false;

      const sun = MeshBuilder.CreateSphere('sunDisc', { diameter: 14, segments: 12 }, scene);
      sun.position.set(60, 120, 60);
      const sunMat = new StandardMaterial('sunMat', scene);
      sunMat.emissiveColor = new Color3(1, 0.97, 0.85);
      sunMat.diffuseColor = Color3.Black();
      sunMat.specularColor = Color3.Black();
      sunMat.disableLighting = true;
      sunMat.fogEnabled = false;
      sun.material = sunMat;
      sun.isPickable = false;
      sun.applyFog = false;
    }

    // -------------------------------------------------------------------------
    // Ground: blotchy grass, tiled, with the faintest hint of the old grid
    // -------------------------------------------------------------------------
    function createGround() {
      const size = 160;
      const tileUnits = 8;          // one texture tile covers 8 × 8 world units
      const px = 512;
      const tex = new BABYLON.DynamicTexture('grass', { width: px, height: px }, scene, true);
      const ctx = tex.getContext();

      ctx.fillStyle = '#62a24a';
      ctx.fillRect(0, 0, px, px);

      // Blotches, each drawn 9× (wrapped) so the tile repeats seamlessly.
      const greens = ['#559442', '#6cae52', '#4f8a3c', '#76b858', '#5c9c45'];
      for (let i = 0; i < 160; i++) {
        const cx = rand(0, px), cy = rand(0, px);
        const r = rand(14, 70), ry = r * rand(0.5, 1), rot = rand(0, Math.PI);
        ctx.fillStyle = pick(greens);
        ctx.globalAlpha = rand(0.12, 0.35);
        for (let ox = -px; ox <= px; ox += px) {
          for (let oy = -px; oy <= px; oy += px) {
            ctx.beginPath();
            ctx.ellipse(cx + ox, cy + oy, r, ry, rot, 0, TWO_PI);
            ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;

      // A whisper of the grid: 1-unit cells at 4 % darker.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
      const cell = px / tileUnits;
      for (let i = 0; i < tileUnits; i++) {
        ctx.fillRect(i * cell, 0, 1, px);
        ctx.fillRect(0, i * cell, px, 1);
      }
      tex.update();
      tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      tex.uScale = size / tileUnits;
      tex.vScale = size / tileUnits;
      tex.anisotropicFilteringLevel = 8;

      const ground = MeshBuilder.CreateGround('ground', { width: size, height: size, subdivisions: 2 }, scene);
      const mat = new StandardMaterial('groundMat', scene);
      mat.diffuseTexture = tex;
      mat.specularColor = new Color3(0.02, 0.02, 0.02);
      ground.material = mat;
      ground.receiveShadows = true;
      ground.isPickable = false;
    }

    // -------------------------------------------------------------------------
    // Builders: tree, bush, hedge, rock, cloud
    // -------------------------------------------------------------------------
    function buildTree(x, z, scale, options = {}) {
      const root = new TransformNode('tree', scene);
      root.position.set(x, 0, z);
      root.rotation.y = rand(0, TWO_PI);

      const trunkH = 1.1 * scale;
      const trunkD = 0.34 * scale;
      const trunk = MeshBuilder.CreateCylinder('trunk', {
        height: trunkH, diameterTop: trunkD * 0.8, diameterBottom: trunkD, tessellation: 8,
      }, scene);
      trunk.position.y = trunkH / 2;
      trunk.material = M.trunk;
      trunk.parent = root;

      const canopy = new TransformNode('canopy', scene); // pivot at the trunk top → sway
      canopy.parent = root;
      canopy.position.y = trunkH;

      const meshes = [trunk];
      const main = MeshBuilder.CreateSphere('canopyMain', { diameter: 1.9 * scale, segments: 10 }, scene);
      main.position.y = 0.75 * scale;
      main.material = pick(M.canopy);
      main.parent = canopy;
      meshes.push(main);
      for (let k = 0; k < 3; k++) {
        const s = MeshBuilder.CreateSphere('canopyPuff', { diameter: rand(1.0, 1.4) * scale, segments: 8 }, scene);
        s.position.set(rand(-0.6, 0.6) * scale, rand(0.45, 1.15) * scale, rand(-0.6, 0.6) * scale);
        s.material = pick(M.canopy);
        s.parent = canopy;
        meshes.push(s);
      }
      meshes.forEach((m) => { m.isPickable = false; });
      const result = { root, height: trunkH + 1.9 * scale, trunkRadius: trunkD / 2 };

      if (options.collect) {
        // Static scenery: the caller merges these later (no sway, no shadows).
        options.collect.meshes.push(...meshes);
        options.collect.roots.push(root);
        return result;
      }

      meshes.forEach(addCaster);
      const phase = rand(0, TWO_PI);
      updaters.push((t) => {
        canopy.rotation.z = Math.sin(t * 0.9 + phase) * 0.022;
        canopy.rotation.x = Math.cos(t * 0.7 + phase) * 0.016;
      });
      return result;
    }

    /** Bushes are collected and merged into one mesh at the end. */
    const bushParts = { meshes: [], roots: [] };
    function buildBush(x, z, scale) {
      const root = new TransformNode('bush', scene);
      root.position.set(x, 0, z);
      for (let k = 0; k < 3; k++) {
        const d = rand(0.5, 0.8) * scale;
        const s = MeshBuilder.CreateSphere('bushPuff', { diameter: d, segments: 8 }, scene);
        s.position.set(rand(-0.25, 0.25) * scale, d * 0.38, rand(-0.25, 0.25) * scale);
        s.scaling.y = 0.8;
        s.material = pick(M.bush);
        s.parent = root;
        bushParts.meshes.push(s);
      }
      bushParts.roots.push(root);
    }

    /** A box core with a row of spheres along the long axis for a bushy top,
     *  merged into a single mesh. */
    function buildHedge(x, z, w, h, d, shadows = true) {
      const root = new TransformNode('hedge', scene);
      root.position.set(x, 0, z);
      const parts = [];
      const core = MeshBuilder.CreateBox('hedgeCore', { width: w, height: h * 0.8, depth: d }, scene);
      core.position.y = h * 0.4;
      core.material = M.hedge;
      core.parent = root;
      parts.push(core);

      const alongX = w >= d;
      const length = alongX ? w : d;
      const thick = alongX ? d : w;
      const diameter = Math.max(thick * 1.25, h * 0.7);
      const count = Math.max(1, Math.round(length / (diameter * 0.55)));
      for (let k = 0; k < count; k++) {
        const f = count === 1 ? 0.5 : k / (count - 1);
        const s = MeshBuilder.CreateSphere('hedgePuff', { diameter, segments: 8 }, scene);
        const along = (f - 0.5) * (length - diameter * 0.6);
        s.position.set(alongX ? along : 0, h * 0.8 - diameter * 0.25, alongX ? 0 : along);
        s.scaling.y = 0.75;
        s.material = M.hedge;
        s.parent = root;
        parts.push(s);
      }
      return mergeStatic('hedge', parts, [root], shadows);
    }

    const rockParts = { meshes: [], roots: [] };
    function buildRock(x, z, w, h, d) {
      const rock = MeshBuilder.CreateIcoSphere('rock', { radius: 0.5, subdivisions: 2, flat: true }, scene);
      rock.scaling.set(w, h * 1.1, d);
      rock.position.set(x, h * 0.45, z);
      rock.rotation.y = rand(0, TWO_PI);
      rock.material = M.rock;
      rockParts.meshes.push(rock);
    }

    /** One merged mesh per cloud so a drifting cloud is a single draw call. */
    function buildCloud(x, y, z, scale, drift) {
      const parts = [];
      const n = 4 + Math.floor(rng() * 4);
      for (let k = 0; k < n; k++) {
        const d = rand(0.9, 1.8) * scale;
        const s = MeshBuilder.CreateSphere('cloudPuff', { diameter: d, segments: 8 }, scene);
        s.position.set(rand(-1.3, 1.3) * scale, rand(-0.15, 0.35) * scale, rand(-0.55, 0.55) * scale);
        s.scaling.y = 0.72;
        s.material = M.cloud;
        parts.push(s);
      }
      const cloud = mergeStatic('skyCloud', parts, [], false);
      cloud.position.set(x, y, z);
      if (drift) {
        updaters.push((t, dt) => {
          cloud.position.x += drift * dt;
          if (cloud.position.x > 70) cloud.position.x = -70;
        });
      }
      return cloud;
    }

    // -------------------------------------------------------------------------
    // Obstacles (collision + visuals) from the game's layout
    // -------------------------------------------------------------------------
    function addBounds(x, z, w, d, top) {
      obstacleBounds.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top });
    }

    function createObstacles(list) {
      list.forEach((o) => {
        if (o.kind === 'hedge') {
          buildHedge(o.x, o.z, o.w, o.h, o.d);
        } else if (o.kind === 'tree') {
          buildTree(o.x, o.z, o.h / 3.0);
        } else {
          buildRock(o.x, o.z, o.w, o.h, o.d);
        }
        addBounds(o.x, o.z, o.w, o.d, o.h);
        blockers.push({ x: o.x, z: o.z, r: Math.max(o.w, o.d) / 2 + 0.8 });
      });
      mergeStatic('boulders', rockParts.meshes, rockParts.roots, true);
    }

    // -------------------------------------------------------------------------
    // Vegetation scattered with the seeded RNG, kept off obstacles and spawn
    // -------------------------------------------------------------------------
    blockers.push({ x: 0, z: 0, r: 3.5 }); // spawn stays clear

    function isBlocked(x, z, extra) {
      for (const b of blockers) {
        const r = b.r + extra;
        if ((x - b.x) * (x - b.x) + (z - b.z) * (z - b.z) < r * r) return true;
      }
      return false;
    }

    /** Random point in an annulus [minR, maxR] around the origin, not blocked. */
    function findSpot(minR, maxR, extra, tries = 40) {
      for (let i = 0; i < tries; i++) {
        const a = rand(0, TWO_PI);
        const r = Math.sqrt(rand(minR * minR, maxR * maxR));
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (!isBlocked(x, z, extra)) return { x, z };
      }
      return null;
    }

    function createTrees() {
      // Inside the meadow: solid trunks you can bump into.
      for (let i = 0; i < 16; i++) {
        const spot = findSpot(5, playHalf - 1.5, 1.6);
        if (!spot) continue;
        const scale = rand(0.85, 1.4);
        const tree = buildTree(spot.x, spot.z, scale);
        const r = tree.trunkRadius + 0.05;
        addBounds(spot.x, spot.z, r * 2, r * 2, tree.height);
        blockers.push({ x: spot.x, z: spot.z, r: 1.4 * scale });
      }
      // Beyond the hedge ring: a tree line to give the horizon some life
      // (static, merged into one mesh).
      const collect = { meshes: [], roots: [] };
      for (let i = 0; i < 44; i++) {
        const spot = findSpot(playHalf + 3, playHalf + 24, 1.2);
        if (!spot) continue;
        const scale = rand(1.0, 1.9);
        buildTree(spot.x, spot.z, scale, { collect });
        blockers.push({ x: spot.x, z: spot.z, r: 1.6 * scale });
      }
      mergeStatic('treeLine', collect.meshes, collect.roots, false);
    }

    function createBushes() {
      for (let i = 0; i < 26; i++) {
        const spot = findSpot(4, playHalf - 0.8, 0.5);
        if (!spot) continue;
        buildBush(spot.x, spot.z, rand(0.8, 1.3));
        blockers.push({ x: spot.x, z: spot.z, r: 0.7 });
      }
      mergeStatic('bushes', bushParts.meshes, bushParts.roots, true);

      const pebbles = [];
      for (let i = 0; i < 14; i++) {
        const spot = findSpot(0.3, playHalf - 0.6, 0.15);
        if (!spot) continue;
        const pebble = MeshBuilder.CreateIcoSphere('pebble', { radius: rand(0.1, 0.22), subdivisions: 1, flat: true }, scene);
        pebble.position.set(spot.x, 0.05, spot.z);
        pebble.scaling.y = 0.6;
        pebble.rotation.y = rand(0, TWO_PI);
        pebble.material = M.rock;
        pebbles.push(pebble);
      }
      mergeStatic('pebbles', pebbles, [], false);
    }

    /** Thin instances: one draw call for hundreds of flowers / grass tufts. */
    function scatterThin(mesh, count, maxR, extra, place) {
      const matrices = new Float32Array(count * 16);
      const colors = new Float32Array(count * 4);
      const m = new BABYLON.Matrix();
      let n = 0;
      for (let tries = 0; n < count && tries < count * 6; tries++) {
        const x = rand(-maxR, maxR);
        const z = rand(-maxR, maxR);
        if (isBlocked(x, z, extra)) continue;
        const item = place(x, z);
        BABYLON.Matrix.ComposeToRef(item.scale, BABYLON.Quaternion.FromEulerAngles(0, item.yaw, 0), item.position, m);
        m.copyToArray(matrices, n * 16);
        colors.set([item.color.r, item.color.g, item.color.b, 1], n * 4);
        n++;
      }
      mesh.thinInstanceSetBuffer('matrix', matrices.subarray(0, n * 16), 16, true);
      mesh.thinInstanceSetBuffer('color', colors.subarray(0, n * 4), 4, true);
      mesh.isPickable = false;
      return n;
    }

    function createFlowersAndGrass() {
      const plain = new StandardMaterial('thinPlain', scene);
      plain.specularColor = Color3.Black();

      // Flower heads + stems share positions (two thin-instance meshes).
      const petals = [
        new Color3(0.98, 0.55, 0.70), new Color3(0.99, 0.85, 0.35), new Color3(0.97, 0.97, 0.95),
        new Color3(0.75, 0.60, 0.95), new Color3(0.95, 0.40, 0.40), new Color3(0.55, 0.78, 0.98),
      ];
      const head = MeshBuilder.CreateSphere('flowerHead', { diameter: 0.13, segments: 5 }, scene);
      head.material = plain;
      const stem = MeshBuilder.CreateCylinder('flowerStem', { height: 0.22, diameter: 0.025, tessellation: 4 }, scene);
      stem.material = plain;
      const spots = [];
      scatterThin(head, 340, playHalf + 6, 0.2, (x, z) => {
        const h = rand(0.14, 0.26);
        spots.push({ x, z, h });
        return {
          position: new Vector3(x, h + 0.04, z), yaw: 0,
          scale: new Vector3(1, 0.75, 1).scaleInPlace(rand(0.8, 1.3)),
          color: pick(petals),
        };
      });
      const stemColor = new Color3(0.30, 0.60, 0.28);
      let k = 0;
      scatterThin(stem, spots.length, 0, 0, () => {
        const s = spots[k++];
        return { position: new Vector3(s.x, s.h / 2, s.z), yaw: 0, scale: new Vector3(1, s.h / 0.22, 1), color: stemColor };
      });

      // Grass tufts: short cones in a few greens.
      const tuft = MeshBuilder.CreateCylinder('grassTuft', { height: 0.28, diameterTop: 0, diameterBottom: 0.16, tessellation: 5 }, scene);
      tuft.material = plain;
      const grassGreens = [new Color3(0.42, 0.72, 0.36), new Color3(0.35, 0.66, 0.32), new Color3(0.50, 0.78, 0.40)];
      scatterThin(tuft, 700, playHalf + 8, 0.1, (x, z) => {
        const s = rand(0.7, 1.5);
        return {
          position: new Vector3(x, 0.14 * s, z), yaw: rand(0, TWO_PI),
          scale: new Vector3(s, s, s), color: pick(grassGreens),
        };
      });
    }

    // -------------------------------------------------------------------------
    // Hedge ring at the edge of the playable area (the game clamps just inside)
    // -------------------------------------------------------------------------
    function createBoundary() {
      const r = playHalf + 1.0;
      const len = (playHalf + 1.0) * 2 + 0.8;
      buildHedge(0, -r, len, 0.9, 0.8, false);
      buildHedge(0, r, len, 0.9, 0.8, false);
      buildHedge(-r, 0, 0.8, 0.9, len, false);
      buildHedge(r, 0, 0.8, 0.9, len, false);
    }

    // -------------------------------------------------------------------------
    // Sky clouds: drifting at flying altitude, plus two holding the banner
    // -------------------------------------------------------------------------
    function createSkyClouds() {
      for (let i = 0; i < 16; i++) {
        let x, z;
        do {
          x = rand(-55, 55);
          z = rand(-45, 45);
        } while (Math.abs(x) < 12 && Math.abs(z - BANNER.z) < 5); // leave the banner readable
        buildCloud(x, rand(5.5, 11.5), z, rand(0.9, 1.8), rand(0.15, 0.45));
      }
      // Anchors at the banner ends.
      const half = BANNER.width / 2;
      buildCloud(BANNER.x - half - 0.4, BANNER.y + 0.3, BANNER.z, 1.25, 0);
      buildCloud(BANNER.x + half + 0.4, BANNER.y + 0.3, BANNER.z, 1.25, 0);
    }

    // -------------------------------------------------------------------------
    // The banner: waving cloth with the message, readable from both sides
    // -------------------------------------------------------------------------
    function drawHeart(ctx, cx, cy, size, color) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(size / 100, size / 100);
      ctx.beginPath();
      ctx.moveTo(0, 35);
      ctx.bezierCurveTo(-110, -40, -35, -105, 0, -55);
      ctx.bezierCurveTo(35, -105, 110, -40, 0, 35);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /** Pick the largest font size ≤ max that fits the text in `maxWidth`. */
    function fitFont(ctx, text, max, maxWidth) {
      const family = '"Arial Rounded MT Bold", "Helvetica Neue", Helvetica, Arial, sans-serif';
      let size = max;
      for (; size > 20; size -= 4) {
        ctx.font = `bold ${size}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth) break;
      }
      return size;
    }

    function createBannerTexture() {
      const W = 2048, H = 448;
      const tex = new BABYLON.DynamicTexture('bannerTex', { width: W, height: H }, scene, true);
      const ctx = tex.getContext();

      ctx.clearRect(0, 0, W, H);
      roundRect(ctx, 16, 16, W - 32, H - 32, 64);
      ctx.fillStyle = '#fff8ec';
      ctx.fill();
      ctx.lineWidth = 16;
      ctx.strokeStyle = '#e4607a';
      ctx.stroke();
      roundRect(ctx, 44, 44, W - 88, H - 88, 46);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(228, 96, 122, 0.45)';
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fitFont(ctx, BANNER_LINES[0], 170, W - 320);
      ctx.fillStyle = '#2d3d6d';
      ctx.fillText(BANNER_LINES[0], W / 2, 158);

      const size2 = fitFont(ctx, BANNER_LINES[1], 118, W - 480);
      const heart = size2 * 0.62;
      const gap = size2 * 0.35;
      const textW = ctx.measureText(BANNER_LINES[1]).width;
      const startX = W / 2 - (textW + gap + heart) / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#4b5b8c';
      ctx.fillText(BANNER_LINES[1], startX, 318);
      drawHeart(ctx, startX + textW + gap + heart / 2, 318 + size2 * 0.06, heart, '#e4607a');

      tex.update();
      return tex;
    }

    function createBanner() {
      const { x, y, z, width, height } = BANNER;
      const root = new TransformNode('banner', scene);
      root.position.set(x, y, z);

      const tex = createBannerTexture();
      tex.hasAlpha = true;
      const mat = new StandardMaterial('bannerMat', scene);
      // Unlit so the text stays readable; the diffuse slot only supplies alpha
      // (alpha test) so the rounded corners are cut out instead of black.
      mat.diffuseTexture = tex;
      mat.emissiveTexture = tex;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.backFaceCulling = true;

      const subX = 64, subY = 6;
      const makeSide = (name, yaw) => {
        const mesh = MeshBuilder.CreateGround(name, {
          width, height, subdivisionsX: subX, subdivisionsY: subY, updatable: true,
        }, scene);
        mesh.rotation.x = -Math.PI / 2;   // stand it up; its normal now faces -Z
        mesh.rotation.y = yaw;            // π for the back side → faces +Z
        mesh.material = mat;
        mesh.parent = root;
        mesh.isPickable = false;
        mesh.applyFog = false;
        return mesh;
      };
      const front = makeSide('bannerFront', 0);
      const back = makeSide('bannerBack', Math.PI);

      const base = front.getVerticesData(BABYLON.VertexBuffer.PositionKind).slice();
      const posF = base.slice();
      const posB = base.slice();
      const ripple = (wx, wz, t) => {
        const f = wx / width + 0.5; // 0..1 across the banner
        const amp = 0.16 * (0.35 + 0.65 * Math.sin(Math.PI * f));
        return amp * Math.sin(wx * 1.15 - t * 2.4) + 0.05 * Math.sin(wx * 2.6 + wz * 1.7 - t * 3.3);
      };
      updaters.push((t) => {
        for (let i = 0; i < base.length; i += 3) {
          const lx = base[i], lz = base[i + 2];
          // Front: local +y is world -Z. Back: local +x is world -X and local +y is world +Z,
          // so mirror x and negate the displacement to move both faces together.
          posF[i + 1] = ripple(lx, lz, t) + 0.01;
          posB[i + 1] = -ripple(-lx, lz, t) + 0.01;
        }
        front.updateVerticesData(BABYLON.VertexBuffer.PositionKind, posF);
        back.updateVerticesData(BABYLON.VertexBuffer.PositionKind, posB);
      });

      return root;
    }

    // -------------------------------------------------------------------------
    // Butterflies: two flapping wings on a wandering lissajous path
    // -------------------------------------------------------------------------
    function createButterflies(count) {
      const wingColors = [
        new Color3(1.0, 0.62, 0.20), new Color3(0.45, 0.70, 1.0),
        new Color3(0.98, 0.98, 0.95), new Color3(0.98, 0.55, 0.75),
      ];
      const mats = wingColors.map((c, i) => {
        const m = new StandardMaterial('wing' + i, scene);
        m.emissiveColor = c.scale(0.8);
        m.diffuseColor = c;
        m.specularColor = Color3.Black();
        m.backFaceCulling = false;
        return m;
      });
      for (let i = 0; i < count; i++) {
        const body = new TransformNode('butterfly', scene);
        const hinges = [1, -1].map((side) => {
          const hinge = new TransformNode('wingHinge', scene);
          hinge.parent = body;
          const wing = MeshBuilder.CreatePlane('wing', { width: 0.16, height: 0.13, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
          wing.rotation.x = Math.PI / 2;      // lie flat
          wing.position.x = side * 0.085;
          wing.material = mats[i % mats.length];
          wing.parent = hinge;
          wing.isPickable = false;
          return { hinge, side };
        });
        // Wander somewhere away from the spawn so nobody starts with a wing in their face.
        const spot = findSpot(5, 16, 0) || { x: rand(-15, 15), z: rand(-15, 15) };
        const cx = spot.x, cz = spot.z;
        const R = rand(1.2, 3.0), h = rand(0.5, 1.6), speed = rand(0.5, 0.9), phase = rand(0, TWO_PI);
        let prev = new Vector3(cx + R, h, cz);
        updaters.push((t) => {
          const a = t * speed + phase;
          const p = new Vector3(cx + Math.cos(a) * R, h + Math.sin(a * 2.3) * 0.25, cz + Math.sin(a) * R * 0.7);
          body.position.copyFrom(p);
          body.rotation.y = Math.atan2(p.x - prev.x, p.z - prev.z);
          prev = p;
          const flap = Math.sin(t * 18 + phase) * 0.9;
          hinges.forEach(({ hinge, side }) => { hinge.rotation.z = side * flap; });
        });
      }
    }

    // ---- Build everything ---------------------------------------------------
    createSky();
    createGround();
    createObstacles(options.obstacles || []);
    createTrees();
    createBushes();
    createFlowersAndGrass();
    createBoundary();
    createSkyClouds();
    const banner = createBanner();
    createButterflies(7);

    return {
      obstacleBounds,
      banner,
      update(t, dt) {
        for (const fn of updaters) fn(t, dt);
      },
    };
  }

  window.GopherWorld = { create, BANNER, BANNER_LINES };
})();
