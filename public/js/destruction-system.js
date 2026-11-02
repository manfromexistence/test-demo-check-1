import * as THREE from 'three/webgpu';
import { hideInstancedSlot } from './scene-culling.js';
import { BODY_SPECS, CAR_PARTS, createLoftedCarMaterial } from './cars.js';

const CELL_SIZE = 16;
const STORAGE_KEY = 'nyc-persistent-destruction-v2';
const LEGACY_STORAGE_KEY = 'nyc-persistent-destruction-v1';

const MAX_SOLID_DEBRIS = 512;
const MAX_GLASS_SHARDS = 256;
const MAX_SPARKS = 192;
const MAX_LEAVES = 256;
const MAX_CRATERS = 64;
const MAX_SMOKE_PLUMES = 160;
const MAX_FIRE_PLUMES = 80;

function createProceduralSmokeTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const hash = (x, y) => {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return h - Math.floor(h);
  };
  const noise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (x, y) => {
    let v = 0;
    let amp = 0.5;
    let freq = 1;
    for (let i = 0; i < 5; i++) {
      v += amp * noise(x * freq, y * freq);
      freq *= 2.03;
      amp *= 0.5;
    }
    return v;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * 2 - 1;
      const ny = (y / size) * 2 - 1;
      const angle = Math.atan2(ny, nx);
      const lobe =
        0.16 * Math.sin(angle * 3 + 0.7) +
        0.11 * Math.cos(angle * 5 - 1.2) +
        0.07 * Math.sin(angle * 7 + 2.1);
      const r = Math.hypot(nx, ny) / Math.max(0.35, 0.88 + lobe);
      if (r >= 1.0) continue;

      const falloff = Math.pow(1 - r * r, 1.85);
      const n1 = fbm(nx * 2.8 + 4.3, ny * 2.8 + 7.1);
      const n2 = fbm(nx * 5.6 + n1 * 1.8, ny * 5.6 - n1 * 1.8);
      const density = Math.max(0, Math.min(1, falloff * (0.45 + 0.75 * n2)));

      const shade = Math.floor(185 + 60 * n1 - 30 * Math.max(0, ny));
      const idx = (y * size + x) * 4;
      data[idx] = shade;
      data[idx + 1] = shade;
      data[idx + 2] = Math.min(255, shade + 6);
      data[idx + 3] = Math.floor(density * 235);
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createProceduralFlameTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const hash = (x, y) => {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return h - Math.floor(h);
  };
  const noise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (x, y) => {
    let v = 0;
    let amp = 0.5;
    let freq = 1;
    for (let i = 0; i < 4; i++) {
      v += amp * noise(x * freq, y * freq);
      freq *= 2.1;
      amp *= 0.5;
    }
    return v;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * 2 - 1;
      const ny = (y / size) * 2 - 1;
      const taper = 0.58 + 0.38 * ((ny + 1) * 0.5);
      const turb = (fbm(nx * 3.5 + 2.1, ny * 4.5 + 5.7) - 0.5) * 0.42;
      const rx = (nx + turb * (1 - ny * 0.4)) / taper;
      const ry = ny;
      const r = Math.hypot(rx, ry);
      if (r >= 1.0) continue;

      const n = fbm(nx * 4.8 + 8.2, ny * 6.2 + 1.9);
      const core = Math.pow(Math.max(0, 1 - r), 1.65) * (0.55 + 0.65 * n);
      const alpha = Math.min(1, core * 1.35);

      const heat = Math.min(1, core * 1.4);
      const red = Math.min(255, Math.floor(255 * Math.min(1, heat * 1.8)));
      const green = Math.min(255, Math.floor(255 * Math.pow(heat, 1.55) * 0.92));
      const blue = Math.min(255, Math.floor(255 * Math.pow(heat, 3.2) * 0.75));

      const idx = (y * size + x) * 4;
      data[idx] = red;
      data[idx + 1] = green;
      data[idx + 2] = blue;
      data[idx + 3] = Math.floor(alpha * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function flagInstRange(attr, count) {
  if (!attr || count <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

/**
 * Real-Time Building Wall Fracturing (Voronoi / Radial Convex Break) with Full TSL Material & UV/Attribute Inheritance.
 * Subdivides the impacted building wall mesh at the exact world-space contactPoint and impactNormal.
 * Every fractured shard and intact flanking wall segment inherits the parent building's exact exterior TSL Material
 * (`createPreWarBuildingMaterial` / `createCurtainWallMaterial`) and interpolated `box` (vec4) + `facadeWall` (vec3)
 * vertex attributes on its exterior faces, while applying an interior concrete/brick core material to internal fracture faces.
 */
export class DestructibleBuildingManager {
  constructor(system) {
    this.system = system;
    this.activeShards = [];
    this.maxActiveShards = 192;
  }

  /**
   * Builds a 2-material 3D convex wall slab geometry from a 2D polygon `poly2D = [[s, y], ...]` in the wall plane,
   * baked directly in world-aligned orientation (`ux, uz`, `wallNx, wallNz`) so `normalGeometry` in `tsl-materials.js`
   * matches the parent building's world-space normal `(wallNx, 0, wallNz)` 100% identically.
   * - Group 0 (Exterior & Back Wall Faces): uses the parent building's exact TSL material with interpolated `box` and `facadeWall` attributes.
   * - Group 1 (Internal Fracture Cross-Section Faces): uses the rough interior concrete/brick core material.
   */
  buildWallPrismGeometry(
    poly2D,
    bestLen,
    topY,
    boxTuple,
    wallKind,
    ux = 1,
    uz = 0,
    wallNx = 0,
    wallNz = 1,
    reverse = false,
    thickness = 0.36
  ) {
    const n = poly2D.length;
    if (n < 3) return null;

    let sCenter = 0;
    let yCenter = 0;
    for (let i = 0; i < n; i++) {
      sCenter += poly2D[i][0];
      yCenter += poly2D[i][1];
    }
    sCenter /= n;
    yCenter /= n;

    const halfT = thickness * 0.5;
    const positions = [];
    const normals = [];
    const uvs = [];
    const boxes = [];
    const facadeWalls = [];
    const indices = [];

    const bW = boxTuple[0] || bestLen;
    const bH = boxTuple[1] || Math.max(1, topY - 0.22);
    const bExp = boxTuple[2] || bH;
    const bSeed = boxTuple[3] || 0.5;

    const pushVert = (ds, dy, dn, nx, ny, nz, s, y) => {
      const idx = positions.length / 3;
      const lx = ux * ds + wallNx * dn;
      const ly = dy;
      const lz = uz * ds + wallNz * dn;
      positions.push(lx, ly, lz);
      normals.push(nx, ny, nz);
      const u01 = Math.max(0, Math.min(1, s / Math.max(0.1, bestLen)));
      const along01 = reverse ? 1 - u01 : u01;
      const fromTop = Math.max(0, bH + 0.22 - y);
      uvs.push(along01, Math.max(0, Math.min(1, y / Math.max(0.1, topY))));
      boxes.push(bW, bH, bExp, bSeed);
      facadeWalls.push(along01, fromTop, wallKind);
      return idx;
    };

    // Group 0: Exterior (+dn) and Back (-dn) faces using parent building's exact TSL material & world-space normal
    const frontStart = 0;
    for (let i = 0; i < n; i++) {
      const [s, y] = poly2D[i];
      pushVert(s - sCenter, y - yCenter, halfT, wallNx, 0, wallNz, s, y);
    }
    for (let i = 1; i < n - 1; i++) {
      indices.push(frontStart, frontStart + i, frontStart + i + 1);
    }

    const backStart = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const [s, y] = poly2D[i];
      // Keep normalGeometry = (wallNx, 0, wallNz) on Group 0 so TSL wallSeed is identical on both faces
      pushVert(s - sCenter, y - yCenter, -halfT, wallNx, 0, wallNz, s, y);
    }
    for (let i = 1; i < n - 1; i++) {
      indices.push(backStart, backStart + i + 1, backStart + i);
    }
    const group0Count = indices.length;

    // Group 1: Internal fracture cross-section rim faces using interior concrete/brick core material
    const group1Start = indices.length;
    for (let i = 0; i < n; i++) {
      const [s0, y0] = poly2D[i];
      const [s1, y1] = poly2D[(i + 1) % n];
      const dS = s1 - s0;
      const dY = y1 - y0;
      const len = Math.hypot(dS, dY) || 1;
      const es = dY / len;
      const ey = -dS / len;
      const enx = ux * es;
      const eny = ey;
      const enz = uz * es;

      const v0 = pushVert(s0 - sCenter, y0 - yCenter, halfT, enx, eny, enz, s0, y0);
      const v1 = pushVert(s1 - sCenter, y1 - yCenter, halfT, enx, eny, enz, s1, y1);
      const v2 = pushVert(s1 - sCenter, y1 - yCenter, -halfT, enx, eny, enz, s1, y1);
      const v3 = pushVert(s0 - sCenter, y0 - yCenter, -halfT, enx, eny, enz, s0, y0);
      indices.push(v0, v1, v2, v0, v2, v3);
    }
    const group1Count = indices.length - group1Start;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('box', new THREE.Float32BufferAttribute(boxes, 4));
    geo.setAttribute('facadeWall', new THREE.Float32BufferAttribute(facadeWalls, 3));
    geo.setIndex(indices);
    geo.clearGroups();
    geo.addGroup(0, group0Count, 0);
    geo.addGroup(group1Start, group1Count, 1);
    geo.computeBoundingSphere();
    return { geo, sCenter, yCenter };
  }

  /**
   * Slices a rectangular wall region `[s0, s1] x [y0, y1]` around impact point `(impactS, impactY)` into
   * convex Voronoi-like radial & perimeter polygonal cells and spawns 3D textured rigid-body wall shards.
   */
  fractureWallSection({
    s0,
    s1,
    y0,
    y1,
    impactS,
    impactY,
    bestAx,
    bestAz,
    ux,
    uz,
    wallNx,
    wallNz,
    bestLen,
    topY,
    boxTuple,
    wallKind,
    reverse = false,
    exteriorMat,
    interiorMat,
    impactSpeed,
    inwardBias = 1,
  }) {
    const spanS = s1 - s0;
    const spanY = y1 - y0;
    if (spanS < 0.45 || spanY < 0.45) return;

    const cx = Math.max(s0 + spanS * 0.22, Math.min(s1 - spanS * 0.22, impactS));
    const cy = Math.max(y0 + spanY * 0.22, Math.min(y1 - spanY * 0.22, impactY));

    // Construct 8 perimeter boundary vertices + 8 intermediate ring vertices around (cx, cy)
    // forming 16 convex polygonal shards (8 inner impact core wedges + 8 outer masonry/glazing slabs)
    const perim = [
      [s0, y0],
      [(s0 + cx) * 0.5, y0],
      [s1, y0],
      [s1, (y0 + cy) * 0.5],
      [s1, y1],
      [(s1 + cx) * 0.5, y1],
      [s0, y1],
      [s0, (y1 + cy) * 0.5],
    ];

    const ring = perim.map(([ps, py], idx) => {
      const jitter = 0.42 + ((idx * 37 + 13) % 19) * 0.012;
      return [cx + (ps - cx) * jitter, cy + (py - cy) * jitter];
    });

    const cells = [];
    for (let i = 0; i < 8; i++) {
      const next = (i + 1) % 8;
      cells.push({ poly: [[cx, cy], ring[i], ring[next]], isInner: true, idx: i });
      cells.push({ poly: [ring[i], perim[i], perim[next], ring[next]], isInner: false, idx: i });
    }

    const matArray = [exteriorMat, interiorMat];

    for (const cell of cells) {
      const built = this.buildWallPrismGeometry(
        cell.poly,
        bestLen,
        topY,
        boxTuple,
        wallKind,
        ux,
        uz,
        wallNx,
        wallNz,
        reverse,
        0.34
      );
      if (!built) continue;

      const { geo, sCenter, yCenter } = built;
      const worldX = bestAx + ux * sCenter + wallNx * 0.12;
      const worldY = yCenter;
      const worldZ = bestAz + uz * sCenter + wallNz * 0.12;

      const shardMesh = new THREE.Mesh(geo, matArray);
      shardMesh.castShadow = true;
      shardMesh.receiveShadow = true;
      shardMesh.position.set(worldX, worldY, worldZ);
      shardMesh.rotation.set(0, 0, 0, 'YXZ');
      this.system.group.add(shardMesh);

      const ds = sCenter - cx;
      const dy = yCenter - cy;
      const distFromImpact = Math.hypot(ds, dy) || 0.25;
      const radialBoost = Math.max(0.25, 1.0 - distFromImpact / Math.max(2.0, Math.hypot(spanS, spanY) * 0.6));
      const baseSpd = Math.min(85.0, Math.max(4.5, Math.sqrt(impactSpeed) * (cell.isInner ? 4.2 : 2.8)));

      const normalDir = cell.isInner ? (inwardBias < 0 ? 1.0 : -0.65) : (cell.idx % 2 === 0 ? 0.95 : 0.55);
      const vx =
        wallNx * normalDir * baseSpd * (0.55 + 0.65 * radialBoost) +
        ux * (ds / distFromImpact) * baseSpd * 0.45 +
        (Math.random() - 0.5) * 1.8;
      const vy = 1.8 + (dy / distFromImpact) * 2.4 + Math.random() * 2.5;
      const vz =
        wallNz * normalDir * baseSpd * (0.55 + 0.65 * radialBoost) +
        uz * (ds / distFromImpact) * baseSpd * 0.45 +
        (Math.random() - 0.5) * 1.8;

      if (this.activeShards.length >= this.maxActiveShards) {
        const oldest = this.activeShards.shift();
        if (oldest && oldest.mesh) {
          this.system.group.remove(oldest.mesh);
          oldest.mesh.geometry?.dispose();
        }
      }

      this.activeShards.push({
        mesh: shardMesh,
        vx,
        vy,
        vz,
        rx: (Math.random() - 0.5) * 5.8,
        ry: (Math.random() - 0.5) * 4.5,
        rz: (Math.random() - 0.5) * 5.8,
        restY: 0.18,
        age: 0,
        maxAge: 14.0,
        sleeping: false,
      });
    }
  }

  update(dt) {
    for (let i = this.activeShards.length - 1; i >= 0; i--) {
      const s = this.activeShards[i];
      s.age += dt;
      if (s.age >= s.maxAge) {
        this.system.group.remove(s.mesh);
        s.mesh.geometry?.dispose();
        this.activeShards.splice(i, 1);
        continue;
      }
      if (s.sleeping) {
        if (s.age > s.maxAge - 1.2) {
          s.mesh.position.y -= dt * 0.35;
        }
        continue;
      }

      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.vy -= 17.5 * dt;

      s.mesh.rotation.x += s.rx * dt;
      s.mesh.rotation.y += s.ry * dt;
      s.mesh.rotation.z += s.rz * dt;

      if (s.mesh.position.y <= s.restY) {
        s.mesh.position.y = s.restY;
        s.vy = Math.abs(s.vy) * 0.26;
        s.vx *= 0.62;
        s.vz *= 0.62;
        s.rx *= 0.55;
        s.ry *= 0.55;
        s.rz *= 0.55;
        if (s.vy < 0.42 && Math.hypot(s.vx, s.vz) < 0.25) {
          s.vx = s.vy = s.vz = 0;
          s.rx = s.ry = s.rz = 0;
          s.sleeping = true;
        }
      }
    }
  }
}

/**
 * Authentic Vehicle Sub-Mesh Detachment & Crumple-Zone Controller.
 * Identifies detachable structural components (`Bumper_Front`, `Bumper_Rear`, `Hood`, `Trunk`, `Door_FL`, `Door_FR`,
 * `Fender_L`, `Fender_R`, `Windshield`) from the vehicle's lofted geometry, extracts the exact triangles with their
 * original PBR/TSL `createLoftedCarMaterial`, `paintColor`, `carState`, and `partId` attributes, promotes them to
 * world-space dynamic rigid bodies, and recesses the detached cavity on the parent vehicle mesh.
 */
export class VehicleDamageController {
  constructor(system) {
    this.system = system;
    this.detachedParts = [];
    this.maxDetachedParts = 48;
    this._dummy = new THREE.Object3D();
  }

  getComponentDefinitions(spec) {
    const zF = spec.zFront || 2.25;
    const zR = spec.zRear || -2.25;
    const cowl = spec.cabin?.cowl ?? 0.92;
    const roofFront = spec.cabin?.roofFront ?? 0.35;
    const deck = spec.cabin?.deck ?? -1.45;
    const doorF = spec.doors?.[0] ?? 0.82;
    const doorR = spec.doors?.[1] ?? -0.15;
    const shoulderF = spec.shoulder?.[0]?.[1] ?? 0.72;
    const shoulderR = spec.shoulder?.[spec.shoulder.length - 1]?.[1] ?? 0.80;

    return [
      {
        name: 'Bumper_Front',
        threshold: 3.8,
        center: [0, 0.46, zF - 0.18],
        match: (cx, cy, cz, partId) =>
          partId !== CAR_PARTS.TYRE && partId !== CAR_PARTS.ALLOY && cz > zF - 0.52 && cy < shoulderF + 0.04,
      },
      {
        name: 'Hood',
        threshold: 4.8,
        center: [0, shoulderF + 0.12, (cowl + zF) * 0.5],
        match: (cx, cy, cz, partId) =>
          partId === CAR_PARTS.BODY && cz > cowl - 0.06 && cz <= zF - 0.28 && cy >= shoulderF - 0.05 && Math.abs(cx) < 0.76,
      },
      {
        name: 'Bumper_Rear',
        threshold: 3.8,
        center: [0, 0.48, zR + 0.18],
        match: (cx, cy, cz, partId) =>
          partId !== CAR_PARTS.TYRE && partId !== CAR_PARTS.ALLOY && cz < zR + 0.52 && cy < shoulderR + 0.04,
      },
      {
        name: 'Trunk',
        threshold: 5.0,
        center: [0, shoulderR + 0.12, (deck + zR) * 0.5],
        match: (cx, cy, cz, partId) =>
          partId === CAR_PARTS.BODY && cz < deck + 0.08 && cz >= zR + 0.26 && cy >= shoulderR - 0.06 && Math.abs(cx) < 0.76,
      },
      {
        name: 'Door_FL',
        threshold: 4.2,
        center: [0.86, 0.72, (doorF + doorR) * 0.5],
        match: (cx, cy, cz, partId) =>
          (partId === CAR_PARTS.BODY || partId === CAR_PARTS.MIRROR) &&
          cx > 0.56 &&
          cz <= doorF + 0.06 &&
          cz >= doorR - 0.06 &&
          cy > 0.30 &&
          cy < 1.18,
      },
      {
        name: 'Door_FR',
        threshold: 4.2,
        center: [-0.86, 0.72, (doorF + doorR) * 0.5],
        match: (cx, cy, cz, partId) =>
          (partId === CAR_PARTS.BODY || partId === CAR_PARTS.MIRROR) &&
          cx < -0.56 &&
          cz <= doorF + 0.06 &&
          cz >= doorR - 0.06 &&
          cy > 0.30 &&
          cy < 1.18,
      },
      {
        name: 'Fender_L',
        threshold: 4.6,
        center: [0.86, 0.68, (doorF + zF) * 0.5],
        match: (cx, cy, cz, partId) =>
          partId === CAR_PARTS.BODY && cx > 0.58 && cz > doorF && cz <= zF - 0.32 && cy > 0.32 && cy < 1.05,
      },
      {
        name: 'Fender_R',
        threshold: 4.6,
        center: [-0.86, 0.68, (doorF + zF) * 0.5],
        match: (cx, cy, cz, partId) =>
          partId === CAR_PARTS.BODY && cx < -0.58 && cz > doorF && cz <= zF - 0.32 && cy > 0.32 && cy < 1.05,
      },
      {
        name: 'Windshield',
        threshold: 5.8,
        center: [0, 1.24, (cowl + roofFront) * 0.5],
        match: (cx, cy, cz, partId) =>
          partId === CAR_PARTS.WINDOW && cz > roofFront - 0.04 && cz <= cowl + 0.05 && Math.abs(cx) < 0.74,
      },
    ];
  }

  tryDetachImpactComponent(entity, localX, localY, localZ, worldX, worldY, worldZ, worldNx, worldNz, severity) {
    if (!entity || entity.bus || !entity._deformMesh || !entity._origPositions) return null;
    const spec = entity._spec || BODY_SPECS[entity.bodyType || 'sedan'] || BODY_SPECS.sedan;
    entity._detachedParts = entity._detachedParts || new Set();

    const defs = this.getComponentDefinitions(spec);
    let bestDef = null;
    let bestDistSq = 1.75 * 1.75;

    for (const def of defs) {
      if (entity._detachedParts.has(def.name)) continue;
      if (severity < def.threshold) continue;
      const dx = localX - def.center[0];
      const dy = (localY - def.center[1]) * 0.85;
      const dz = localZ - def.center[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestDef = def;
      }
    }

    if (!bestDef) return null;

    const parentGeo = entity._deformMesh.geometry;
    const posAttr = parentGeo.attributes.position;
    const normAttr = parentGeo.attributes.normal;
    const uvAttr = parentGeo.attributes.uv;
    const partAttr = parentGeo.attributes.partId;
    const idxAttr = parentGeo.index;
    if (!posAttr || !normAttr || !partAttr || !idxAttr) return null;

    const orig = entity._origPositions;
    const posArr = posAttr.array;
    const normArr = normAttr.array;
    const uvArr = uvAttr ? uvAttr.array : null;
    const partArr = partAttr.array;
    const indices = idxAttr.array;

    const subPos = [];
    const subNorm = [];
    const subUv = [];
    const subPart = [];
    const subIdx = [];
    const matchedVerts = new Set();

    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let vertCount = 0;

    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];

      const cx = (orig[i0 * 3] + orig[i1 * 3] + orig[i2 * 3]) / 3;
      const cy = (orig[i0 * 3 + 1] + orig[i1 * 3 + 1] + orig[i2 * 3 + 1]) / 3;
      const cz = (orig[i0 * 3 + 2] + orig[i1 * 3 + 2] + orig[i2 * 3 + 2]) / 3;
      const pId = partArr[i0];

      if (bestDef.match(cx, cy, cz, pId)) {
        const baseV = subPos.length / 3;
        for (const vi of [i0, i1, i2]) {
          const ox = orig[vi * 3];
          const oy = orig[vi * 3 + 1];
          const oz = orig[vi * 3 + 2];
          subPos.push(ox, oy, oz);
          subNorm.push(normArr[vi * 3], normArr[vi * 3 + 1], normArr[vi * 3 + 2]);
          if (uvArr) subUv.push(uvArr[vi * 2], uvArr[vi * 2 + 1]);
          else subUv.push(0, 0);
          subPart.push(partArr[vi]);
          sumX += ox;
          sumY += oy;
          sumZ += oz;
          vertCount++;
          matchedVerts.add(vi);
        }
        subIdx.push(baseV, baseV + 1, baseV + 2);
      }
    }

    if (vertCount < 3) return null;
    entity._detachedParts.add(bestDef.name);

    const pCx = sumX / vertCount;

    // Recess detached component vertices on the parent vehicle mesh into the dark structural chassis bay
    for (const vi of matchedVerts) {
      const ox = orig[vi * 3];
      const oy = orig[vi * 3 + 1];
      const oz = orig[vi * 3 + 2];
      posArr[vi * 3] = ox * 0.62;
      posArr[vi * 3 + 1] = Math.max(0.32, oy * 0.72);
      posArr[vi * 3 + 2] = oz * 0.78;
      partArr[vi] = CAR_PARTS.TRIM;
    }
    posAttr.needsUpdate = true;
    partAttr.needsUpdate = true;
    parentGeo.computeVertexNormals();

    // Build standalone sub-mesh BufferGeometry retaining exact original attributes for createLoftedCarMaterial
    const partGeo = new THREE.BufferGeometry();
    partGeo.setAttribute('position', new THREE.Float32BufferAttribute(subPos, 3));
    partGeo.setAttribute('normal', new THREE.Float32BufferAttribute(subNorm, 3));
    partGeo.setAttribute('uv', new THREE.Float32BufferAttribute(subUv, 2));
    partGeo.setAttribute('partId', new THREE.Float32BufferAttribute(subPart, 1));
    partGeo.setIndex(subIdx);

    const paint = entity.paint || [1.0, 0.75, 0.08];
    const style = (entity.style || 0) + 0.55;
    partGeo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(paint), 3));
    partGeo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, style]), 4));
    partGeo.setAttribute('carDent', new THREE.InstancedBufferAttribute(new Float32Array(4), 4));

    const partMat = createLoftedCarMaterial(spec);
    const partMesh = new THREE.InstancedMesh(partGeo, partMat, 1);
    partMesh.count = 1;
    partMesh.castShadow = true;
    partMesh.receiveShadow = true;
    partMesh.frustumCulled = false;

    const ex = entity.x !== undefined ? entity.x : (entity.position ? entity.position.x : worldX);
    const ey = entity.y !== undefined ? entity.y : (entity.position ? entity.position.y : 0);
    const ez = entity.z !== undefined ? entity.z : (entity.position ? entity.position.z : worldZ);
    const heading = entity.heading !== undefined ? entity.heading : ((entity.yaw || 0) + (entity.yawOffset || 0));

    this._dummy.position.set(ex, ey + 0.08, ez);
    this._dummy.rotation.set(entity.pitch || 0, heading, entity.roll || 0, 'YXZ');
    this._dummy.scale.set(1, 1, 1);
    this._dummy.updateMatrix();
    partMesh.setMatrixAt(0, this._dummy.matrix);
    partMesh.instanceMatrix.needsUpdate = true;

    this.system.group.add(partMesh);

    if (this.detachedParts.length >= this.maxDetachedParts) {
      const oldest = this.detachedParts.shift();
      if (oldest && oldest.mesh) {
        this.system.group.remove(oldest.mesh);
        oldest.mesh.geometry?.dispose();
      }
    }

    const impulseSpd = Math.min(14.5, Math.max(4.5, severity * 0.72));
    const sideSign = Math.sign(pCx || localX || (Math.random() - 0.5));
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const outX = cosH * sideSign * 0.55 + worldNx * 0.75;
    const outZ = -sinH * sideSign * 0.55 + worldNz * 0.75;

    this.detachedParts.push({
      name: bestDef.name,
      mesh: partMesh,
      x: ex,
      y: ey + 0.14,
      z: ez,
      rotX: entity.pitch || 0,
      rotY: heading,
      rotZ: entity.roll || 0,
      vx: outX * impulseSpd + (entity.vx || 0) * 0.45 + (Math.random() - 0.5) * 2.2,
      vy: 2.6 + Math.min(4.8, severity * 0.28) + Math.random() * 1.4,
      vz: outZ * impulseSpd + (entity.vz || 0) * 0.45 + (Math.random() - 0.5) * 2.2,
      rx: (Math.random() - 0.5) * 5.8,
      ry: (Math.random() - 0.5) * 6.4,
      rz: sideSign * (2.4 + Math.random() * 3.8),
      restY: 0.04,
      age: 0,
      maxAge: 14.0,
      sleeping: false,
    });

    return bestDef.name;
  }

  update(dt) {
    for (let i = this.detachedParts.length - 1; i >= 0; i--) {
      const p = this.detachedParts[i];
      p.age += dt;
      if (p.age >= p.maxAge) {
        this.system.group.remove(p.mesh);
        p.mesh.geometry?.dispose();
        this.detachedParts.splice(i, 1);
        continue;
      }
      if (p.sleeping) continue;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy -= 16.8 * dt;

      p.rotX += p.rx * dt;
      p.rotY += p.ry * dt;
      p.rotZ += p.rz * dt;

      if (p.y <= p.restY) {
        p.y = p.restY;
        const impactVy = Math.abs(p.vy);
        p.vy = impactVy * 0.28;
        p.vx *= 0.68;
        p.vz *= 0.68;
        p.rx *= 0.52;
        p.ry *= 0.65;
        p.rz *= 0.52;
        p.rotX *= 0.65;
        p.rotZ *= 0.65;

        if (impactVy > 2.2 && Math.hypot(p.vx, p.vz) > 2.5) {
          this.system._spawnSparkStreaks(p.x, 0.15, p.z, p.vx, p.vz, Math.hypot(p.vx, p.vz), 4);
        }

        if (p.vy < 0.38 && Math.hypot(p.vx, p.vz) < 0.22) {
          p.vx = p.vy = p.vz = 0;
          p.rx = p.ry = p.rz = 0;
          p.rotX = 0;
          p.rotZ = 0;
          p.sleeping = true;
        }
      }

      this._dummy.position.set(p.x, p.y, p.z);
      this._dummy.rotation.set(p.rotX, p.rotY, p.rotZ, 'YXZ');
      this._dummy.scale.set(1, 1, 1);
      this._dummy.updateMatrix();
      p.mesh.setMatrixAt(0, this._dummy.matrix);
      p.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

export class DestructionSystem {
  constructor(scene, streetDetails, reportCollision, cityBlocks = null, allColliders = null) {
    this.scene = scene;
    this.streetDetails = streetDetails;
    this.treeField = streetDetails?.treeField || null;
    this.reportCollision = reportCollision;
    this.cityBlocks = cityBlocks;
    this.allColliders = allColliders || [];

    this.group = new THREE.Group();
    this.group.name = 'DestructionSystem';
    this.scene.add(this.group);

    this._dummy = new THREE.Object3D();
    this._zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    this._tmpColor = new THREE.Color();
    this._tmpMat4 = new THREE.Matrix4();
    this._tmpQuat = new THREE.Quaternion();

    this.cells = new Map();
    this.allProps = [];
    this.fallingProps = [];
    this.swayingTrees = [];
    this.geysers = [];
    this.smokeEmitters = new Map();
    this.damagedTrafficOverlays = new Map();
    this.collapsingBuildings = [];
    this.shudderingBuildings = [];
    this.collapsedTargets = new Set();
    this.roadCraters = [];
    this.destructibleBuildingManager = new DestructibleBuildingManager(this);
    this.vehicleDamageController = new VehicleDamageController(this);

    // Ring-buffer particle pools (zero runtime Mesh/Group creation)
    this.solidDebrisPool = [];
    this.solidDebrisCursor = 0;
    this.glassShardPool = [];
    this.glassShardCursor = 0;
    this.sparkPool = [];
    this.sparkCursor = 0;
    this.leafPool = [];
    this.leafCursor = 0;
    this.smokePlumePool = [];
    this.smokePlumeCursor = 0;
    this.firePlumePool = [];
    this.firePlumeCursor = 0;
    this.craterCursor = 0;

    // Persistent records saved to localStorage across restarts
    this.savedState = {
      version: 2,
      destroyedProps: [], // [{ id, fx, fz, speed }]
      collapsedBuildings: [], // [{ cx, cz, nx, nz, impact }]
      roadCraters: [], // [{ x, z, impact }]
      stats: {
        propsDestroyed: 0,
        pedestriansStruck: 0,
        pedestriansHurt: 0,
        pedestriansKilled: 0,
        buildingsDamaged: 0,
        roadsBroken: 0,
      },
    };
    this._savePending = false;
    this._saveTimer = 0;

    this.brokenObjectsCount = 0;
    this.pedestriansStruckCount = 0;
    this.stats = {
      propsDestroyed: 0,
      pedestriansStruck: 0,
      pedestriansHurt: 0,
      pedestriansKilled: 0,
      buildingsDamaged: 0,
      roadsBroken: 0,
    };
    this.lastImpactLabel = '';
    this.lastImpactTimer = 0;

    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }

    this._initMaterialsAndPools();
    this._indexProps(streetDetails?.destructibles || []);
    this._restorePersistentState();
  }

  _initMaterialsAndPools() {
    const glassShardGeo = new THREE.BoxGeometry(0.32, 0.022, 0.24);
    const branchStickGeo = new THREE.CylinderGeometry(0.032, 0.068, 0.95, 7);
    const leafClusterGeo = new THREE.PlaneGeometry(0.46, 0.46);
    const sparkStreakGeo = new THREE.BoxGeometry(0.04, 0.04, 0.56);
    const tireGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.24, 14);
    tireGeo.rotateZ(Math.PI * 0.5);
    const bumperGeo = new THREE.BoxGeometry(1.48, 0.18, 0.24);
    const rebarGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.95, 6);
    const craterGeo = new THREE.CircleGeometry(1, 16);
    craterGeo.rotateX(-Math.PI * 0.5);

    this.geoms = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
      taperedTrunk: new THREE.CylinderGeometry(0.34, 0.52, 1, 10),
      cone: new THREE.ConeGeometry(0.6, 1, 10),
      shard: glassShardGeo,
      branch: branchStickGeo,
      leaf: leafClusterGeo,
      sparkStreak: sparkStreakGeo,
      tire: tireGeo,
      bumper: bumperGeo,
      rebar: rebarGeo,
      plane: new THREE.PlaneGeometry(1, 1),
      circle: craterGeo,
    };

    const smokeTex = createProceduralSmokeTexture();
    const flameTex = createProceduralFlameTexture();

    // Shared palette colors for instanced debris (avoids compiling 28 separate materials)
    this.colors = {
      woodBark: new THREE.Color(0x4b3828),
      woodSplinter: new THREE.Color(0xc49a62),
      leafGreen: new THREE.Color(0x3f6e28),
      leafGold: new THREE.Color(0xc28124),
      poleMetal: new THREE.Color(0x363b42),
      pedPostMetal: new THREE.Color(0x1b1f24),
      signalYellow: new THREE.Color(0xd99b1a),
      hydrantRed: new THREE.Color(0xb02720),
      mailboxBlue: new THREE.Color(0x1b3b73),
      cartSteel: new THREE.Color(0xd0d7de),
      umbrellaBlue: new THREE.Color(0x1d4ed8),
      umbrellaYellow: new THREE.Color(0xeab308),
      orangeStripe: new THREE.Color(0xea580c),
      whiteStripe: new THREE.Color(0xf1f5f9),
      concrete: new THREE.Color(0x8e8a82),
      limestone: new THREE.Color(0xbcb4a5),
      mortar: new THREE.Color(0xa6a198),
      brick: new THREE.Color(0x8b3a2b),
      brickDark: new THREE.Color(0x63281e),
      steelGirder: new THREE.Color(0x2c323b),
      rustedRebar: new THREE.Color(0x5c3424),
      asphaltTop: new THREE.Color(0x23272e),
      asphaltSubbase: new THREE.Color(0x45433e),
      roadPaintYellow: new THREE.Color(0xeab308),
      charcoal: new THREE.Color(0x1a1d22),
      taxiYellow: new THREE.Color(0xffbe14),
      sparkGold: new THREE.Color(0xffd866),
      waterDrop: new THREE.Color(0x88dcff),
      dustSmoke: new THREE.Color(0xb8c2cc),
      blackSmoke: new THREE.Color(0x1a1e26),
      fireCore: new THREE.Color(0xfde047),
      fireEdge: new THREE.Color(0xea580c),
    };

    // Keep lightweight material references for prop/tree fallbacks & compatibility
    const sharedStandardMat = new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.22,
    });
    const glassShardMat = new THREE.MeshStandardNodeMaterial({
      color: 0xdbeafe,
      emissive: 0x60a5fa,
      emissiveIntensity: 0.22,
      roughness: 0.12,
      metalness: 0.25,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const sparkMat = new THREE.MeshBasicNodeMaterial({
      color: 0xffffff,
    });
    const leafMat = new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: 0.78,
      side: THREE.DoubleSide,
    });
    const craterMat = new THREE.MeshBasicNodeMaterial({
      map: smokeTex,
      color: 0x0b0d11,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
    });
    const smokePlumeMat = new THREE.MeshBasicNodeMaterial({
      map: smokeTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const firePlumeMat = new THREE.MeshBasicNodeMaterial({
      map: flameTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mats = {
      sharedStandard: sharedStandardMat,
      woodBark: new THREE.MeshStandardNodeMaterial({ color: 0x4b3828, roughness: 0.9 }),
      woodSplinter: new THREE.MeshStandardNodeMaterial({ color: 0xc49a62, roughness: 0.85 }),
      leafGreen: this.colors.leafGreen,
      leafGold: this.colors.leafGold,
      poleMetal: new THREE.MeshStandardNodeMaterial({ color: 0x363b42, roughness: 0.38, metalness: 0.78 }),
      pedPostMetal: new THREE.MeshStandardNodeMaterial({ color: 0x1b1f24, roughness: 0.35, metalness: 0.82 }),
      signalYellow: new THREE.MeshStandardNodeMaterial({ color: 0xd99b1a, roughness: 0.4, metalness: 0.35 }),
      hydrantRed: this.colors.hydrantRed,
      mailboxBlue: this.colors.mailboxBlue,
      cartSteel: this.colors.cartSteel,
      umbrellaBlue: this.colors.umbrellaBlue,
      umbrellaYellow: this.colors.umbrellaYellow,
      orangeStripe: this.colors.orangeStripe,
      whiteStripe: this.colors.whiteStripe,
      concrete: this.colors.concrete,
      limestone: this.colors.limestone,
      mortar: this.colors.mortar,
      brick: this.colors.brick,
      brickDark: this.colors.brickDark,
      steelGirder: this.colors.steelGirder,
      rustedRebar: this.colors.rustedRebar,
      asphaltTop: this.colors.asphaltTop,
      asphaltSubbase: this.colors.asphaltSubbase,
      roadPaintYellow: this.colors.roadPaintYellow,
      charcoal: new THREE.MeshStandardNodeMaterial({ color: 0x1a1d22, roughness: 0.68, metalness: 0.35 }),
      taxiYellow: this.colors.taxiYellow,
      glassShard: glassShardMat,
      spark: sparkMat,
      waterDrop: this.colors.waterDrop,
      crackDecal: craterMat,
      furnitureOak: new THREE.MeshStandardNodeMaterial({ color: 0xa47148, roughness: 0.62, metalness: 0.08 }),
      furnitureWalnut: new THREE.MeshStandardNodeMaterial({ color: 0x5c3d28, roughness: 0.56, metalness: 0.10 }),
      furnitureFabricNavy: new THREE.MeshStandardNodeMaterial({ color: 0x26466d, roughness: 0.86, metalness: 0.04 }),
      furnitureFabricRust: new THREE.MeshStandardNodeMaterial({ color: 0xb5533c, roughness: 0.86, metalness: 0.04 }),
      furnitureChrome: new THREE.MeshStandardNodeMaterial({ color: 0xcbd5e1, roughness: 0.30, metalness: 0.78 }),
      furnitureScreen: new THREE.MeshStandardNodeMaterial({ color: 0x0f172a, emissive: 0x1e3a8a, emissiveIntensity: 0.35, roughness: 0.22 }),
      roomFloorOak: new THREE.MeshStandardNodeMaterial({ color: 0x8d6240, roughness: 0.64 }),
      roomFloorSlate: new THREE.MeshStandardNodeMaterial({ color: 0x475569, roughness: 0.44, metalness: 0.15 }),
      roomWallCream: new THREE.MeshStandardNodeMaterial({ color: 0xe5e0d8, roughness: 0.88 }),
      roomWallOffice: new THREE.MeshStandardNodeMaterial({ color: 0xcbd5e1, roughness: 0.82 }),
      roomCeilingGlow: new THREE.MeshBasicNodeMaterial({ color: 0xfff4d6 }),
    };

    // 1. Solid Debris InstancedMesh Pool (masonry blocks, bricks, steel beams, wood splinters, asphalt chunks, prop parts)
    this.solidDebrisInst = new THREE.InstancedMesh(this.geoms.box, sharedStandardMat, MAX_SOLID_DEBRIS);
    this.solidDebrisInst.frustumCulled = false;
    this.solidDebrisInst.castShadow = true;
    this.solidDebrisInst.receiveShadow = true;
    for (let i = 0; i < MAX_SOLID_DEBRIS; i++) {
      this.solidDebrisInst.setMatrixAt(i, this._zeroMatrix);
      this.solidDebrisInst.setColorAt(i, this.colors.concrete);
      this.solidDebrisPool.push({
        active: false, settled: false, persistent: true,
        x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, rotX: 0, rotY: 0, rotZ: 0,
        sx: 0.25, sy: 0.25, sz: 0.25, gravity: 16.5, restY: 0.08, age: 0, maxAge: 12,
      });
    }

    // 2. Glass Shard InstancedMesh Pool
    this.glassShardInst = new THREE.InstancedMesh(this.geoms.shard, glassShardMat, MAX_GLASS_SHARDS);
    this.glassShardInst.frustumCulled = false;
    for (let i = 0; i < MAX_GLASS_SHARDS; i++) {
      this.glassShardInst.setMatrixAt(i, this._zeroMatrix);
      this.glassShardPool.push({
        active: false, settled: false,
        x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, rotX: 0, rotY: 0, rotZ: 0,
        sx: 0.3, sy: 0.3, sz: 0.3, gravity: 15.5, restY: 0.03, age: 0, maxAge: 10,
      });
    }

    // 3. Spark & Water Droplet InstancedMesh Pool
    this.sparkInst = new THREE.InstancedMesh(this.geoms.sparkStreak, sparkMat, MAX_SPARKS);
    this.sparkInst.frustumCulled = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparkInst.setMatrixAt(i, this._zeroMatrix);
      this.sparkInst.setColorAt(i, this.colors.sparkGold);
      this.sparkPool.push({
        active: false,
        x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
        sx: 0.8, sy: 0.8, sz: 0.8, gravity: 18.5, age: 0, maxAge: 0.45,
      });
    }

    // 4. Fluttering Leaf InstancedMesh Pool
    this.leafInst = new THREE.InstancedMesh(this.geoms.leaf, leafMat, MAX_LEAVES);
    this.leafInst.frustumCulled = false;
    for (let i = 0; i < MAX_LEAVES; i++) {
      this.leafInst.setMatrixAt(i, this._zeroMatrix);
      this.leafInst.setColorAt(i, this.colors.leafGreen);
      this.leafPool.push({
        active: false, settled: false,
        x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, rotX: 0, rotY: 0, rotZ: 0,
        scale: 0.3, age: 0,
      });
    }

    // 5. Road Crater Decal InstancedMesh Pool
    this.craterInst = new THREE.InstancedMesh(this.geoms.circle, craterMat, MAX_CRATERS);
    this.craterInst.frustumCulled = false;
    this.craterInst.renderOrder = 996;
    for (let i = 0; i < MAX_CRATERS; i++) {
      this.craterInst.setMatrixAt(i, this._zeroMatrix);
    }

    // 6. Volumetric Smoke & Dust Plume InstancedMesh Pool
    this.smokePlumeInst = new THREE.InstancedMesh(this.geoms.plane, smokePlumeMat, MAX_SMOKE_PLUMES);
    this.smokePlumeInst.frustumCulled = false;
    this.smokePlumeInst.renderOrder = 1001;
    for (let i = 0; i < MAX_SMOKE_PLUMES; i++) {
      this.smokePlumeInst.setMatrixAt(i, this._zeroMatrix);
      this.smokePlumeInst.setColorAt(i, this.colors.dustSmoke);
      this.smokePlumePool.push({
        active: false,
        x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
        scale: 1, aspect: 1, expandRate: 1.2, roll: 0, rollVel: 0,
        turbulencePhase: 0, age: 0, maxAge: 2.2,
      });
    }

    // 7. Volumetric Fire Plume InstancedMesh Pool
    this.firePlumeInst = new THREE.InstancedMesh(this.geoms.plane, firePlumeMat, MAX_FIRE_PLUMES);
    this.firePlumeInst.frustumCulled = false;
    this.firePlumeInst.renderOrder = 1002;
    for (let i = 0; i < MAX_FIRE_PLUMES; i++) {
      this.firePlumeInst.setMatrixAt(i, this._zeroMatrix);
      this.firePlumeInst.setColorAt(i, this.colors.fireCore);
      this.firePlumePool.push({
        active: false,
        x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
        scale: 0.7, aspect: 1.35, expandRate: 0.8, roll: 0, rollVel: 0,
        turbulencePhase: 0, age: 0, maxAge: 0.65,
      });
    }

    this.group.add(
      this.solidDebrisInst,
      this.glassShardInst,
      this.sparkInst,
      this.leafInst,
      this.craterInst,
      this.smokePlumeInst,
      this.firePlumeInst
    );
  }

  _resolveColor(matOrColor) {
    if (!matOrColor) return this.colors.concrete;
    if (matOrColor.isColor) return matOrColor;
    if (matOrColor.color && matOrColor.color.isColor) return matOrColor.color;
    return this.colors.concrete;
  }

  _spawnSolidDebrisItem(x, y, z, vx, vy, vz, sx, sy, sz, colorObj, restY = 0.08, persistent = true) {
    const slot = this.solidDebrisCursor;
    this.solidDebrisCursor = (this.solidDebrisCursor + 1) % MAX_SOLID_DEBRIS;
    const item = this.solidDebrisPool[slot];
    item.active = true;
    item.settled = false;
    item.persistent = persistent;
    item.x = x;
    item.y = y;
    item.z = z;
    item.vx = vx;
    item.vy = vy;
    item.vz = vz;
    item.rotX = Math.random() * 6.28;
    item.rotY = Math.random() * 6.28;
    item.rotZ = Math.random() * 6.28;
    item.rx = (Math.random() - 0.5) * 9.5;
    item.ry = (Math.random() - 0.5) * 9.5;
    item.rz = (Math.random() - 0.5) * 9.5;
    item.sx = sx;
    item.sy = sy;
    item.sz = sz;
    item.gravity = 16.5;
    item.restY = restY;
    item.age = 0;
    item.maxAge = persistent ? 60 : 6.0;

    this.solidDebrisInst.setColorAt(slot, this._resolveColor(colorObj));
    if (this.solidDebrisInst.instanceColor) this.solidDebrisInst.instanceColor.needsUpdate = true;
    this._dirtySolidDebris = true;
  }

  _spawnSettledRubbleItem(x, y, z, sx, sy, sz, colorObj, rotX = null, rotY = null, rotZ = null) {
    const slot = this.solidDebrisCursor;
    this.solidDebrisCursor = (this.solidDebrisCursor + 1) % MAX_SOLID_DEBRIS;
    const item = this.solidDebrisPool[slot];
    item.active = true;
    item.settled = true;
    item.persistent = true;
    item.x = x;
    item.y = y;
    item.z = z;
    item.vx = item.vy = item.vz = 0;
    item.rx = item.ry = item.rz = 0;
    item.rotX = rotX !== null ? rotX : (Math.random() - 0.5) * 0.45;
    item.rotY = rotY !== null ? rotY : Math.random() * 6.28;
    item.rotZ = rotZ !== null ? rotZ : (Math.random() - 0.5) * 0.45;
    item.sx = sx;
    item.sy = sy;
    item.sz = sz;
    item.restY = y;
    item.age = 0;

    this._dummy.position.set(x, y, z);
    this._dummy.rotation.set(item.rotX, item.rotY, item.rotZ);
    this._dummy.scale.set(sx, sy, sz);
    this._dummy.updateMatrix();
    this.solidDebrisInst.setMatrixAt(slot, this._dummy.matrix);
    this.solidDebrisInst.setColorAt(slot, this._resolveColor(colorObj));
    this.solidDebrisInst.instanceMatrix.needsUpdate = true;
    if (this.solidDebrisInst.instanceColor) this.solidDebrisInst.instanceColor.needsUpdate = true;
  }

  _cellKey(x, z) {
    return `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
  }

  _indexProps(destructibles) {
    this.allProps = destructibles;
    for (let i = 0; i < destructibles.length; i++) {
      const p = destructibles[i];
      p._persistId = i;
      const k = this._cellKey(p.x, p.z);
      let list = this.cells.get(k);
      if (!list) {
        list = [];
        this.cells.set(k, list);
      }
      list.push(p);
    }
  }

  _scheduleSave() {
    this._savePending = true;
  }

  _flushSave() {
    if (!this._savePending) return;
    this._savePending = false;
    try {
      this.savedState.stats = { ...this.stats };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.savedState));
    } catch {
      /* Storage full or unavailable */
    }
  }

  _findBuildingColliderNear(x, z) {
    let best = null;
    let bestDistSq = 18 * 18;
    for (let i = 0; i < this.allColliders.length; i++) {
      const c = this.allColliders[i];
      if (!c.buildingRecord && !c._landmarkSlices) continue;
      const cx = Math.max(c.minX, Math.min(x, c.maxX));
      const cz = Math.max(c.minZ, Math.min(z, c.maxZ));
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = c;
      }
    }
    return best;
  }

  _restorePersistentState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 2) return;

      if (Array.isArray(parsed.destroyedProps)) {
        for (const item of parsed.destroyedProps) {
          const prop = this.allProps[item.id];
          if (prop && !prop.destroyed) {
            this.destroyProp(prop, item.fx || 1, item.fz || 0, item.speed || 8, false, true);
          }
        }
      }

      if (Array.isArray(parsed.collapsedBuildings)) {
        for (const cb of parsed.collapsedBuildings) {
          const col = this._findBuildingColliderNear(cb.cx, cb.cz);
          if (col) {
            const target = col.buildingRecord || col;
            this.collapseBuilding(target, cb.cx, 1.0, cb.cz, cb.nx || 1, cb.nz || 0, cb.impact || 12, false, true);
          }
        }
      }

      if (Array.isArray(parsed.roadCraters)) {
        for (const rc of parsed.roadCraters) {
          this.damageRoadSurface(rc.x, rc.z, rc.impact, false, true);
        }
      }

      if (parsed.stats) {
        this.stats.propsDestroyed = Math.max(this.stats.propsDestroyed, parsed.stats.propsDestroyed || 0);
        this.stats.pedestriansStruck = Math.max(this.stats.pedestriansStruck, parsed.stats.pedestriansStruck || 0);
        this.stats.pedestriansHurt = Math.max(this.stats.pedestriansHurt, parsed.stats.pedestriansHurt || 0);
        this.stats.pedestriansKilled = Math.max(this.stats.pedestriansKilled, parsed.stats.pedestriansKilled || 0);
        this.stats.buildingsDamaged = Math.max(this.stats.buildingsDamaged, parsed.stats.buildingsDamaged || 0);
        this.stats.roadsBroken = Math.max(this.stats.roadsBroken, parsed.stats.roadsBroken || 0);
        this.brokenObjectsCount = this.stats.propsDestroyed;
        this.pedestriansStruckCount = this.stats.pedestriansStruck;
      }
    } catch (e) {
      console.warn('[DestructionSystem] Failed to restore persistent state:', e);
    }
  }

  resetWorldDestruction() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    window.location.reload();
  }

  getEntityRadius(mode) {
    switch (mode) {
      case 'car':
      case 'traffic':
        return 1.38;
      case 'helicopter':
        return 2.4;
      case 'cyclist':
        return 0.65;
      case 'person':
      default:
        return 0.48;
    }
  }

  checkEntityPropCollisions(entity, mode, dt, isPlayer = false) {
    if (!entity || !entity.position) return;
    const pos = entity.position;
    if (pos.y > 9.5) return;

    const ex = pos.x;
    const ez = pos.z;
    const ey = pos.y;
    const entityRadius = this.getEntityRadius(mode);

    const minCx = Math.floor((ex - entityRadius - 2.5) / CELL_SIZE);
    const maxCx = Math.floor((ex + entityRadius + 2.5) / CELL_SIZE);
    const minCz = Math.floor((ez - entityRadius - 2.5) / CELL_SIZE);
    const maxCz = Math.floor((ez + entityRadius + 2.5) / CELL_SIZE);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;

        for (let i = 0; i < list.length; i++) {
          const prop = list[i];
          if (prop.destroyed) continue;
          if (ey > (prop.height || 4.5) + 1.2) continue;

          const dx = ex - prop.x;
          const dz = ez - prop.z;
          const minDist = entityRadius + (prop.radius || 0.4);
          const d2 = dx * dx + dz * dz;
          if (d2 >= minDist * minDist) continue;

          const dist = Math.sqrt(d2) || 0.001;
          const nx = dx / dist;
          const nz = dz / dist;

          const rawSpeed = Math.abs(entity.speed || 0);
          const kvx = entity.vx || 0;
          const kvz = entity.vz || 0;
          const kSpeed = Math.hypot(kvx, kvz);
          const sign = (entity.speed || 0) < -0.1 ? -1 : 1;
          const fwdX = Math.sin(entity.heading || 0) * sign;
          const fwdZ = Math.cos(entity.heading || 0) * sign;
          const moveSpeed = Math.max(rawSpeed, kSpeed, mode === 'person' ? 2.5 : 3.8);

          const hitDirX = rawSpeed >= kSpeed ? fwdX : kvx / (kSpeed || 1);
          const hitDirZ = rawSpeed >= kSpeed ? fwdZ : kvz / (kSpeed || 1);

          const overlap = minDist - dist;
          pos.x += nx * overlap * 0.75;
          pos.z += nz * overlap * 0.75;

          if (prop.kind === 'tree' && (mode === 'person' || (moveSpeed < 4.5 && !prop._crackedOnce))) {
            prop._crackedOnce = true;
            this._triggerTreeShudderReaction(prop, hitDirX - nx * 0.35, hitDirZ - nz * 0.35, moveSpeed, isPlayer);
          } else {
            this.destroyProp(prop, hitDirX - nx * 0.35, hitDirZ - nz * 0.35, moveSpeed, isPlayer, false);
          }

          // Equal & opposite Newton's 3rd Law reaction on the colliding vehicle/character
          const massRatio = this._getPropResistance(prop.kind, mode);
          const recoil = Math.max(1.5, moveSpeed * massRatio * 0.95);
          entity.vx = (entity.vx || 0) + nx * recoil;
          entity.vz = (entity.vz || 0) + nz * recoil;
          if (typeof entity.speed === 'number') {
            entity.speed *= Math.max(0.22, 1.0 - massRatio * 0.78);
          }
          if (typeof entity.angularVel === 'number') {
            const cross = dx * hitDirZ - dz * hitDirX;
            entity.angularVel += Math.sign(cross || 1) * Math.min(3.2, recoil * 0.28);
          }
          if (entity.pitchVel !== undefined) {
            entity.pitchVel += 0.16 * Math.min(1.8, moveSpeed * 0.14);
            entity.heaveVel = (entity.heaveVel || 0) + 0.18;
          }

          this.applyEntityDamage(
            entity,
            mode,
            moveSpeed * (0.52 + massRatio),
            prop.x,
            Math.max(0.5, ey + 0.5),
            prop.z,
            nx,
            nz,
            isPlayer,
            false
          );

          const soundKind = this._getPropSoundKind(prop.kind);
          if (this.reportCollision) {
            this.reportCollision(
              soundKind,
              prop.x,
              Math.max(0.4, ey),
              prop.z,
              Math.max(3.5, moveSpeed * 1.2)
            );
          }
        }
      }
    }
  }

  _getPropResistance(kind, mode) {
    const base =
      {
        tree: 0.52,
        signal: 0.40,
        lamp: 0.35,
        pedLamp: 0.28,
        cart: 0.42,
        steam: 0.32,
        hydrant: 0.34,
        mailbox: 0.28,
        furniture: 0.26,
      }[kind] || 0.32;

    if (mode === 'person') return Math.min(0.88, base * 1.5);
    if (mode === 'cyclist') return Math.min(0.80, base * 1.25);
    if (mode === 'helicopter') return base * 0.68;
    return base;
  }

  _getPropSoundKind(kind) {
    switch (kind) {
      case 'tree':
        return 'tree';
      case 'hydrant':
        return 'hydrant';
      case 'lamp':
      case 'pedLamp':
      case 'signal':
        return 'lamp';
      default:
        return 'prop';
    }
  }

  _getPropLabel(kind, subKind = '') {
    if (kind === 'furniture') {
      const subLabels = {
        desk: 'OFFICE DESK',
        chair: 'SWIVEL CHAIR',
        sofa: 'LOUNGE SOFA',
        bookshelf: 'BOOKSHELF',
        table: 'COFFEE TABLE',
        counter: 'STORE COUNTER',
        plant: 'INDOOR PLANTER',
      };
      return subLabels[subKind] || 'INTERIOR FURNITURE';
    }
    switch (kind) {
      case 'tree':
        return 'TREE';
      case 'lamp':
        return 'STREETLIGHT';
      case 'pedLamp':
        return 'LAMP POST';
      case 'signal':
        return 'TRAFFIC SIGNAL';
      case 'hydrant':
        return 'FIRE HYDRANT';
      case 'mailbox':
        return 'MAILBOX';
      case 'cart':
        return 'FOOD CART';
      case 'steam':
        return 'STEAM STACK';
      default:
        return 'STREET PROP';
    }
  }

  _createRealTreeMesh(prop) {
    if (!this.treeField || !this.treeField.geos || !this.treeField.material) return null;
    const sp = Math.min(2, Math.max(0, prop.species || 0));
    const variant = prop.variant ? 1 : 0;
    const srcGeo =
      this.treeField.geos[sp]?.[variant]?.[0] ||
      this.treeField.geos[sp]?.[variant]?.[1];
    if (!srcGeo) return null;

    const geo = new THREE.BufferGeometry();
    for (const name of Object.keys(srcGeo.attributes)) {
      geo.setAttribute(name, srcGeo.attributes[name]);
    }
    geo.setIndex(srcGeo.index);
    geo.boundingSphere = srcGeo.boundingSphere;
    geo.boundingBox = srcGeo.boundingBox;

    const td = prop.treeData || [0.35, 0.55, 0.25, sp + 0.25];
    const treeDataAttr = new THREE.InstancedBufferAttribute(new Float32Array(td), 4);
    geo.setAttribute('aTreeData', treeDataAttr);

    const mesh = new THREE.InstancedMesh(geo, this.treeField.material, 1);
    mesh.count = 1;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const s = prop.scale || 1.0;
    this._dummy.position.set(0, 0, 0);
    this._dummy.rotation.set(0, prop.yaw || 0, 0);
    this._dummy.scale.set(prop.sx || s, prop.sy || s, prop.sz || s);
    this._dummy.updateMatrix();
    mesh.setMatrixAt(0, this._dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  _triggerTreeShudderReaction(prop, dirX, dirZ, impactSpeed, isPlayer) {
    const len = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / len;
    const fz = dirZ / len;
    const s = prop.scale || 1.0;
    const leafCol = prop.species === 1 ? this.colors.leafGold : this.colors.leafGreen;

    if (isPlayer) {
      this.lastImpactLabel = 'TREE SHUDDERED — BARK CRACKED';
      this.lastImpactTimer = 2.0;
    }

    if (!prop._swayGroup && this.treeField && typeof this.treeField.destroyTree === 'function') {
      const realMesh = this._createRealTreeMesh(prop);
      if (realMesh) {
        this.treeField.destroyTree(prop.treeIndex, prop.cell);
        const swayPivot = new THREE.Group();
        swayPivot.position.set(prop.x, prop.y || 0.2, prop.z);
        swayPivot.add(realMesh);
        this.group.add(swayPivot);
        prop._swayGroup = swayPivot;
        const entry = {
          prop,
          pivot: swayPivot,
          fx,
          fz,
          amp: Math.min(0.24, 0.08 + impactSpeed * 0.025),
          phase: 0,
          decay: 1.85,
        };
        prop._swayEntry = entry;
        this.swayingTrees.push(entry);
      }
    } else if (prop._swayEntry) {
      prop._swayEntry.fx = fx;
      prop._swayEntry.fz = fz;
      prop._swayEntry.amp = Math.min(0.28, prop._swayEntry.amp + 0.12);
      prop._swayEntry.phase = 0;
    }

    this._spawnFlutteringLeaves(prop.x, 3.2 * s, prop.z, fx, fz, 14, leafCol);
    this.spawnDebrisBurst(prop.x, 1.4 * s, prop.z, fx, fz, impactSpeed * 0.7, {
      count: 4,
      matA: this.colors.woodBark,
      matB: this.colors.woodSplinter,
      scaleMin: 0.18,
      scaleMax: 0.36,
      persistent: true,
    });
  }

  destroyProp(prop, dirX, dirZ, impactSpeed, isPlayer = false, isRestoring = false) {
    if (prop.destroyed) return;
    prop.destroyed = true;
    this.brokenObjectsCount++;
    this.stats.propsDestroyed = this.brokenObjectsCount;

    if (isPlayer && !isRestoring) {
      this.lastImpactLabel = `${this._getPropLabel(prop.kind)} SMASHED`;
      this.lastImpactTimer = 2.6;
    }

    const len = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / len;
    const fz = dirZ / len;
    const speed = Math.max(4.5, impactSpeed);

    if (!isRestoring && prop._persistId !== undefined) {
      this.savedState.destroyedProps.push({
        id: prop._persistId,
        fx: Math.round(fx * 100) / 100,
        fz: Math.round(fz * 100) / 100,
        speed: Math.round(speed * 10) / 10,
      });
      this._scheduleSave();
    }

    if (prop.kind === 'tree') {
      if (prop._swayGroup) {
        this.group.remove(prop._swayGroup);
        prop._swayGroup = null;
      }
      if (this.treeField && typeof this.treeField.destroyTree === 'function') {
        this.treeField.destroyTree(prop.treeIndex, prop.cell);
      }
    } else if (prop.slots) {
      for (const s of prop.slots) {
        hideInstancedSlot(s.mesh, s.index);
      }
    }

    if (prop.lightSite) prop.lightSite.disabled = true;
    if (prop.light) prop.light.disabled = true;

    this._spawnBrokenPropVisuals(prop, fx, fz, speed, isRestoring);
  }

  _spawnBrokenPropVisuals(prop, fx, fz, speed, isRestoring = false) {
    const { x, z, kind } = prop;

    if (kind === 'tree') {
      const s = prop.scale || 1.0;
      const baseY = prop.y || 0.2;

      // Grounded stump via instanced solid pool
      this._spawnSettledRubbleItem(x, baseY + 0.18 * s, z, 0.36 * s, 0.38 * s, 0.36 * s, this.colors.woodBark);

      const pivot = new THREE.Group();
      pivot.position.set(x, baseY + 0.32 * s, z);

      const realTreeMesh = this._createRealTreeMesh(prop);
      if (realTreeMesh) {
        realTreeMesh.position.y = -0.28 * s;
        pivot.add(realTreeMesh);
      }

      const leafCol = prop.species === 1 ? this.colors.leafGold : this.colors.leafGreen;
      const restTilt = Math.PI * 0.465;

      if (isRestoring) {
        pivot.rotation.order = 'YXZ';
        pivot.rotation.z = -fx * restTilt;
        pivot.rotation.x = fz * restTilt;
        pivot.position.x += fx * 0.45;
        pivot.position.z += fz * 0.45;
        this.group.add(pivot);
        return;
      }

      this.group.add(pivot);
      this.fallingProps.push({
        group: pivot,
        fx,
        fz,
        vx: fx * Math.min(4.8, speed * 0.22),
        vz: fz * Math.min(4.8, speed * 0.22),
        vy: Math.min(1.6, speed * 0.09),
        tiltAngle: prop._swayEntry ? Math.max(0.08, prop._swayEntry.amp) : 0.05,
        tiltVel: Math.max(1.35, speed * 0.20),
        restTilt,
        settled: false,
        groundBurstDone: false,
        burstKind: 'tree',
        poleHeight: Math.max(4.2, (prop.height || 5.5) * 0.72),
        leafMat: leafCol,
      });

      this.spawnDebrisBurst(x, 1.3 * s, z, fx, fz, speed * 0.85, {
        count: 6,
        matA: this.colors.woodSplinter,
        matB: this.colors.woodBark,
        scaleMin: 0.22,
        scaleMax: 0.55,
        persistent: true,
      });
      this._spawnFlutteringLeaves(x, 3.2 * s, z, fx, fz, 18, leafCol);
      return;
    }

    if (kind === 'lamp' || kind === 'pedLamp' || kind === 'signal') {
      const h = kind === 'pedLamp' ? 3.9 : 6.8;
      const poleMat = kind === 'pedLamp' ? this.mats.pedPostMetal : this.mats.poleMetal;
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.14, z);

      const pole = new THREE.Mesh(this.geoms.taperedTrunk, poleMat);
      pole.scale.set(0.18, h, 0.18);
      pole.position.y = h * 0.5;
      pivot.add(pole);

      if (kind === 'signal') {
        const housing = new THREE.Mesh(this.geoms.box, this.mats.signalYellow);
        housing.scale.set(0.34, 0.96, 0.34);
        housing.position.set(1.2, h - 0.6, 0);
        pivot.add(housing);
      }

      const restTilt = Math.PI * 0.485;
      if (isRestoring) {
        pivot.rotation.order = 'YXZ';
        pivot.rotation.z = -fx * restTilt;
        pivot.rotation.x = fz * restTilt;
        pivot.position.x += fx * 0.6;
        pivot.position.z += fz * 0.6;
        this.group.add(pivot);
        return;
      }

      this.group.add(pivot);
      this.fallingProps.push({
        group: pivot,
        fx,
        fz,
        vx: fx * Math.min(6.2, speed * 0.30),
        vz: fz * Math.min(6.2, speed * 0.30),
        vy: Math.min(2.2, speed * 0.14),
        tiltAngle: 0.06,
        tiltVel: Math.max(1.85, speed * 0.26),
        restTilt,
        settled: false,
        groundBurstDone: false,
        burstKind: kind,
        poleHeight: h,
      });

      this._spawnSparkStreaks(x, 0.35, z, fx, fz, speed, 12);
      this.spawnDebrisBurst(x, 0.45, z, fx, fz, speed, {
        count: 6,
        matA: this.mats.glassShard,
        matB: this.colors.poleMetal,
        geom: this.geoms.shard,
        scaleMin: 0.18,
        scaleMax: 0.36,
        persistent: true,
      });
      return;
    }

    if (kind === 'hydrant') {
      if (isRestoring) {
        this._spawnSettledRubbleItem(x + fx * 1.5, 0.22, z + fz * 1.5, 0.32, 0.68, 0.32, this.colors.hydrantRed);
        return;
      }
      this._spawnSolidDebrisItem(
        x, 0.45, z,
        fx * Math.max(5.5, speed * 0.8), Math.max(3.5, speed * 0.38), fz * Math.max(5.5, speed * 0.8),
        0.32, 0.68, 0.32, this.colors.hydrantRed, 0.22, true
      );
      this._spawnSparkStreaks(x, 0.35, z, fx, fz, speed, 10);
      this.geysers.push({ x, z, age: 0, maxAge: 14.0, emitAccum: 0, mistAccum: 0 });
      return;
    }

    if (kind === 'mailbox') {
      if (isRestoring) {
        this._spawnSettledRubbleItem(x + fx * 1.4, 0.28, z + fz * 1.4, 0.52, 0.95, 0.48, this.colors.mailboxBlue);
        return;
      }
      this._spawnSolidDebrisItem(
        x, 0.55, z,
        fx * Math.max(4.8, speed * 0.72), Math.max(3.0, speed * 0.32), fz * Math.max(4.8, speed * 0.72),
        0.52, 0.95, 0.48, this.colors.mailboxBlue, 0.28, true
      );
      this._spawnSparkStreaks(x, 0.4, z, fx, fz, speed, 10);
      return;
    }

    if (kind === 'cart') {
      if (isRestoring) {
        this._spawnSettledRubbleItem(x + fx * 1.8, 0.42, z + fz * 1.8, 1.35, 0.88, 0.92, this.colors.cartSteel);
        return;
      }
      this._spawnSolidDebrisItem(
        x, 0.65, z,
        fx * Math.max(4.0, speed * 0.62), Math.max(2.6, speed * 0.25), fz * Math.max(4.0, speed * 0.62),
        1.35, 0.88, 0.92, this.colors.cartSteel, 0.42, true
      );
      this._spawnSolidDebrisItem(
        x, 1.85, z,
        fx * Math.max(3.5, speed * 0.55), Math.max(3.8, speed * 0.35), fz * Math.max(3.5, speed * 0.55),
        1.1, 0.35, 1.1, this.colors.umbrellaBlue, 0.22, true
      );
      this._spawnSparkStreaks(x, 0.7, z, fx, fz, speed, 10);
      this.spawnDebrisBurst(x, 1.1, z, fx, fz, speed, {
        count: 8,
        matA: this.mats.glassShard,
        matB: this.colors.cartSteel,
        geom: this.geoms.shard,
        scaleMin: 0.20,
        scaleMax: 0.42,
        persistent: true,
      });
      for (let i = 0; i < 3; i++) {
        this._spawnVolumetricPlume(x + (Math.random() - 0.5) * 0.7, 1.0 + i * 0.25, z + (Math.random() - 0.5) * 0.7, 'dust', 0.85, 2.2);
      }
      return;
    }

    if (kind === 'steam') {
      if (isRestoring) {
        this._spawnSettledRubbleItem(x + fx * 2.0, 0.24, z + fz * 2.0, 0.42, 1.65, 0.42, this.colors.orangeStripe);
        return;
      }
      this._spawnSolidDebrisItem(
        x, 0.95, z,
        fx * Math.max(5.0, speed * 0.7), Math.max(3.5, speed * 0.32), fz * Math.max(5.0, speed * 0.7),
        0.42, 1.65, 0.42, this.colors.orangeStripe, 0.24, true
      );
      for (let i = 0; i < 5; i++) {
        this._spawnVolumetricPlume(x + (Math.random() - 0.5) * 0.8, 0.5 + i * 0.3, z + (Math.random() - 0.5) * 0.8, 'dust', 0.95 + i * 0.12, 2.4);
      }
      return;
    }

    if (kind === 'furniture') {
      const { subKind } = prop;
      if (isRestoring) {
        this._spawnSettledRubbleItem(x + fx * 0.8, 0.22, z + fz * 0.8, 0.75, 0.35, 0.75, prop.primaryColor || this.colors.woodBark);
        return;
      }
      this.spawnDebrisBurst(x, Math.max(0.4, (prop.height || 1.0) * 0.5), z, fx, fz, speed, {
        count: 8,
        matA: prop.primaryColor || this.colors.woodSplinter,
        matB: prop.secondaryColor || this.colors.woodBark,
        geom: this.geoms.box,
        scaleMin: 0.14,
        scaleMax: 0.36,
        persistent: true,
      });
      if (subKind === 'desk' || subKind === 'counter') {
        this.spawnDebrisBurst(x, 0.85, z, fx, fz, speed * 0.8, {
          count: 5,
          matA: this.mats.glassShard,
          matB: this.mats.furnitureChrome,
          scaleMin: 0.12,
          scaleMax: 0.28,
          persistent: true,
        });
      }
      this._spawnSolidDebrisItem(
        x, 0.35, z,
        fx * Math.max(4.0, speed * 0.45) + (Math.random() - 0.5) * 2.0,
        1.8 + Math.random() * 2.5,
        fz * Math.max(4.0, speed * 0.45) + (Math.random() - 0.5) * 2.0,
        0.55, 0.24, 0.48,
        prop.primaryColor || this.colors.woodBark,
        0.22,
        true
      );
      this._spawnVolumetricPlume(x, 0.65, z, 'dust', 0.85, 2.0);
    }
  }

  /**
   * Fractures and craters the asphalt road or concrete sidewalk at `(x, z)` using instanced pools.
   */
  damageRoadSurface(x, z, rawImpact, isPlayer = false, isRestoring = false) {
    const impact = Math.max(4.5, rawImpact);
    for (const c of this.roadCraters) {
      const dx = c.x - x;
      const dz = c.z - z;
      if (dx * dx + dz * dz < 4.5) return;
    }

    const radius = Math.min(2.5, Math.max(0.95, 0.65 + impact * 0.08));
    const slot = this.craterCursor;
    this.craterCursor = (this.craterCursor + 1) % MAX_CRATERS;
    this._dummy.position.set(x, 0.022, z);
    this._dummy.rotation.set(0, (x * 1.7 + z * 2.3) % 6.28, 0);
    this._dummy.scale.set(radius, 1, radius);
    this._dummy.updateMatrix();
    this.craterInst.setMatrixAt(slot, this._dummy.matrix);
    this.craterInst.instanceMatrix.needsUpdate = true;

    this.roadCraters.push({ x, z, radius, impact });
    if (this.roadCraters.length > MAX_CRATERS) this.roadCraters.shift();
    this.brokenObjectsCount++;
    this.stats.propsDestroyed = this.brokenObjectsCount;
    this.stats.roadsBroken = (this.stats.roadsBroken || 0) + 1;

    if (!isRestoring) {
      this.savedState.roadCraters.push({
        x: Math.round(x * 10) / 10,
        z: Math.round(z * 10) / 10,
        impact: Math.round(impact * 10) / 10,
      });
      if (this.savedState.roadCraters.length > MAX_CRATERS) this.savedState.roadCraters.shift();
      this._scheduleSave();

      for (let k = 0; k < 5; k++) {
        const ang = (k / 5) * Math.PI * 2 + Math.random() * 0.5;
        const spd = 2.2 + Math.random() * Math.min(6.5, impact * 0.4);
        const col = k === 0 ? this.colors.roadPaintYellow : k % 2 === 0 ? this.colors.asphaltTop : this.colors.asphaltSubbase;
        this._spawnSolidDebrisItem(
          x + Math.cos(ang) * 0.45, 0.16, z + Math.sin(ang) * 0.45,
          Math.cos(ang) * spd, 1.8 + Math.random() * 2.8, Math.sin(ang) * spd,
          0.42 + Math.random() * 0.25, 0.10, 0.36 + Math.random() * 0.22,
          col, 0.06, true
        );
      }
      this._spawnVolumetricPlume(x, 0.45, z, 'dust', 0.95, 2.0);
    }
  }

  applyCraterSuspensionJolt(entity, mode, dt) {
    if (!entity || !entity.position || (mode !== 'car' && mode !== 'cyclist')) return;
    const speed = Math.abs(entity.speed || 0);
    if (speed < 1.2 || this.roadCraters.length === 0) return;

    const ex = entity.position.x;
    const ez = entity.position.z;
    for (let i = 0; i < this.roadCraters.length; i++) {
      const c = this.roadCraters[i];
      const dx = ex - c.x;
      const dz = ez - c.z;
      const r = c.radius + 0.65;
      if (dx * dx + dz * dz < r * r) {
        const now = performance.now();
        if (now - (entity._lastCraterJoltMs || 0) > 180) {
          entity._lastCraterJoltMs = now;
          const jolt = Math.min(1.2, speed * 0.08);
          if (mode === 'car') {
            entity.heaveVel = (entity.heaveVel || 0) + (Math.random() > 0.4 ? 0.55 : -0.45) * jolt;
            entity.pitchVel = (entity.pitchVel || 0) + (Math.random() - 0.5) * 1.4 * jolt;
            entity.rollVel = (entity.rollVel || 0) + (Math.random() - 0.5) * 1.8 * jolt;
          } else if (mode === 'cyclist') {
            entity.leanAngle = (entity.leanAngle || 0) + (Math.random() - 0.5) * 0.16 * jolt;
          }
        }
        break;
      }
    }
  }

  _spawnFlutteringLeaves(x, y, z, fx, fz, count, leafCol) {
    const col = this._resolveColor(leafCol || this.colors.leafGreen);
    for (let i = 0; i < count; i++) {
      const slot = this.leafCursor;
      this.leafCursor = (this.leafCursor + 1) % MAX_LEAVES;
      const item = this.leafPool[slot];
      item.active = true;
      item.settled = false;
      item.x = x + (Math.random() - 0.5) * 2.2;
      item.y = y + (Math.random() - 0.4) * 1.6;
      item.z = z + (Math.random() - 0.5) * 2.2;
      item.vx = fx * (1.2 + Math.random() * 2.4) + (Math.random() - 0.5) * 3.0;
      item.vy = 0.8 + Math.random() * 2.2;
      item.vz = fz * (1.2 + Math.random() * 2.4) + (Math.random() - 0.5) * 3.0;
      item.rotX = Math.random() * 6.28;
      item.rotY = Math.random() * 6.28;
      item.rotZ = Math.random() * 6.28;
      item.rx = (Math.random() - 0.5) * 8;
      item.ry = (Math.random() - 0.5) * 8;
      item.rz = (Math.random() - 0.5) * 8;
      item.scale = 0.22 + Math.random() * 0.24;
      item.age = 0;
      this.leafInst.setColorAt(slot, col);
    }
    if (this.leafInst.instanceColor) this.leafInst.instanceColor.needsUpdate = true;
    this._dirtyLeaves = true;
  }

  _spawnSparkStreaks(x, y, z, fx, fz, speed, count = 12, customColor = null) {
    const spread = Math.max(4.0, Math.min(14.0, speed * 0.75));
    const col = customColor || this.colors.sparkGold;
    for (let i = 0; i < count; i++) {
      const slot = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
      const item = this.sparkPool[slot];
      item.active = true;
      item.x = x + (Math.random() - 0.5) * 0.35;
      item.y = Math.max(0.12, y + (Math.random() - 0.3) * 0.35);
      item.z = z + (Math.random() - 0.5) * 0.35;
      item.vx = fx * spread * (0.3 + Math.random() * 0.9) + (Math.random() - 0.5) * spread;
      item.vy = 2.4 + Math.random() * 5.8;
      item.vz = fz * spread * (0.3 + Math.random() * 0.9) + (Math.random() - 0.5) * spread;
      item.sx = 0.85;
      item.sy = 0.85;
      item.sz = 0.75 + Math.random() * 0.85;
      item.gravity = 19.5;
      item.age = 0;
      item.maxAge = 0.36 + Math.random() * 0.30;
      this.sparkInst.setColorAt(slot, col);
    }
    if (this.sparkInst.instanceColor) this.sparkInst.instanceColor.needsUpdate = true;
  }

  spawnDebrisBurst(x, y, z, fx, fz, speed, opts = {}) {
    const count = Math.min(18, opts.count || 8);
    const matA = opts.matA || this.colors.concrete;
    const matB = opts.matB || this.colors.charcoal;
    const sMin = opts.scaleMin || 0.16;
    const sMax = opts.scaleMax || 0.42;
    const persistent = opts.persistent !== undefined ? opts.persistent : true;
    const spread = Math.max(3.2, Math.min(12.5, speed * 0.65));

    for (let i = 0; i < count; i++) {
      const chosen = i % 2 === 0 ? matA : matB;
      const isGlass = chosen === this.mats.glassShard;
      const sx = sMin + Math.random() * (sMax - sMin);
      const sy = sMin + Math.random() * (sMax - sMin);
      const sz = sMin + Math.random() * (sMax - sMin);
      const px = x + (Math.random() - 0.5) * 0.65;
      const py = Math.max(0.15, y + (Math.random() - 0.3) * 0.55);
      const pz = z + (Math.random() - 0.5) * 0.65;
      const vx = fx * spread * (0.35 + Math.random() * 0.85) + (Math.random() - 0.5) * spread * 0.9;
      const vy = (2.0 + Math.random() * 4.2) * Math.min(2.0, Math.max(0.8, speed * 0.14));
      const vz = fz * spread * (0.35 + Math.random() * 0.85) + (Math.random() - 0.5) * spread * 0.9;

      if (isGlass) {
        const slot = this.glassShardCursor;
        this.glassShardCursor = (this.glassShardCursor + 1) % MAX_GLASS_SHARDS;
        const gItem = this.glassShardPool[slot];
        gItem.active = true;
        gItem.settled = false;
        gItem.x = px;
        gItem.y = py;
        gItem.z = pz;
        gItem.vx = vx;
        gItem.vy = vy;
        gItem.vz = vz;
        gItem.rotX = Math.random() * 6.28;
        gItem.rotY = Math.random() * 6.28;
        gItem.rotZ = Math.random() * 6.28;
        gItem.rx = (Math.random() - 0.5) * 14;
        gItem.ry = (Math.random() - 0.5) * 14;
        gItem.rz = (Math.random() - 0.5) * 14;
        gItem.sx = sx * 1.4;
        gItem.sy = 1.0;
        gItem.sz = sz * 1.4;
        gItem.restY = 0.03;
        gItem.age = 0;
        gItem.maxAge = 12;
        this._dirtyGlassShards = true;
      } else {
        this._spawnSolidDebrisItem(px, py, pz, vx, vy, vz, sx, sy * 0.65, sz, chosen, 0.06, persistent);
      }
    }
  }

  _spawnVolumetricPlume(x, y, z, kind = 'blackSmoke', startScale = 0.75, maxAge = 2.4, initVx = 0, initVz = 0) {
    const isFire = kind === 'fire';
    if (isFire) {
      const slot = this.firePlumeCursor;
      this.firePlumeCursor = (this.firePlumeCursor + 1) % MAX_FIRE_PLUMES;
      const p = this.firePlumePool[slot];
      p.active = true;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = initVx + (Math.random() - 0.5) * 1.1;
      p.vy = 2.6 + Math.random() * 2.2;
      p.vz = initVz + (Math.random() - 0.5) * 1.1;
      p.scale = startScale;
      p.aspect = 1.32 + Math.random() * 0.4;
      p.expandRate = 0.65 + Math.random() * 0.5;
      p.roll = Math.random() * 6.28;
      p.rollVel = (Math.random() - 0.5) * 3.0;
      p.turbulencePhase = Math.random() * 6.28;
      p.age = 0;
      p.maxAge = 0.55 + Math.random() * 0.4;
      this.firePlumeInst.setColorAt(slot, Math.random() > 0.4 ? this.colors.fireCore : this.colors.fireEdge);
      if (this.firePlumeInst.instanceColor) this.firePlumeInst.instanceColor.needsUpdate = true;
    } else {
      const slot = this.smokePlumeCursor;
      this.smokePlumeCursor = (this.smokePlumeCursor + 1) % MAX_SMOKE_PLUMES;
      const p = this.smokePlumePool[slot];
      p.active = true;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = initVx + (Math.random() - 0.5) * 1.4;
      p.vy = 1.8 + Math.random() * 1.6;
      p.vz = initVz + (Math.random() - 0.5) * 1.4;
      p.scale = startScale;
      p.aspect = 0.92 + Math.random() * 0.22;
      p.expandRate = 1.05 + Math.random() * 0.65;
      p.roll = Math.random() * 6.28;
      p.rollVel = (Math.random() - 0.5) * 1.8;
      p.turbulencePhase = Math.random() * 6.28;
      p.age = 0;
      p.maxAge = maxAge * (0.85 + Math.random() * 0.3);
      this.smokePlumeInst.setColorAt(slot, kind === 'dust' ? this.colors.dustSmoke : this.colors.blackSmoke);
      if (this.smokePlumeInst.instanceColor) this.smokePlumeInst.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Progressive 3D rigid-body tilt & gravitational demolition collapse of the actual building geometry:
   * - As the lower stories shear on the impacted face `(nx, nz)`, the building tilts outward by angle `theta`
   *   around its base pivot `(cx, 0, cz)` while accelerating downward under gravity (`0.5 * g * t^2`).
   * - Because `vCoord` in `tsl-materials.js` is locked to the vertex attributes (`wallH + 0.22 - fromTop`),
   *   all procedural windows, masonry courses, cornices, and storefronts remain 100% glued to the tilting,
   *   falling building all the way into the ground!
   */
  _applyBuildingCollapseProgress(target, progress, nx, nz, age = 0, shudderAmp = 0) {
    const p = Math.min(1, Math.max(0, progress));
    const fall = p * p;
    const shudderX = shudderAmp > 0 ? Math.sin(age * 48.0) * shudderAmp : 0;
    const shudderZ = shudderAmp > 0 ? Math.cos(age * 43.0) * shudderAmp : 0;

    // 1. Surveyed Building (`record._footprintSlice`)
    if (target._footprintSlice) {
      const { mesh, vStart, vEnd, origPositions } = target._footprintSlice;
      const posAttr = mesh.geometry?.attributes?.position;
      if (posAttr) {
        const arr = posAttr.array;
        const bHeight = Math.max(10, target.height || 26);
        const cx = target.cx || 0;
        const cz = target.cz || 0;
        const count = vEnd - vStart;
        const dropDist = fall * (bHeight + 4.5);
        const buried = p >= 0.96;

        // 3D rigid-body tilt toward the undercut impact normal (nx, nz) up to ~24 degrees (0.42 rad)
        const maxTilt = Math.min(0.42, 11.5 / Math.max(16, bHeight));
        const theta = Math.sin(p * Math.PI * 0.5) * maxTilt;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        for (let i = 0; i < count; i++) {
          const o3 = i * 3;
          const ox = origPositions[o3];
          const oy = origPositions[o3 + 1];
          const oz = origPositions[o3 + 2];
          const dst = (vStart + i) * 3;

          if (buried) {
            arr[dst] = ox;
            arr[dst + 1] = -4.0;
            arr[dst + 2] = oz;
            continue;
          }

          if (p === 0 && shudderAmp > 0) {
            const hRatio = Math.min(1, Math.max(0, oy / bHeight));
            arr[dst] = ox + shudderX * hRatio;
            arr[dst + 1] = oy;
            arr[dst + 2] = oz + shudderZ * hRatio;
            continue;
          }

          const dx = ox - cx;
          const dz = oz - cz;
          const alongTilt = dx * nx + dz * nz;
          const perpX = dx - alongTilt * nx;
          const perpZ = dz - alongTilt * nz;

          // Rotate (alongTilt, oy) by theta around base pivot (cx, 0, cz) and apply gravitational drop
          const tiltedAlong = alongTilt * cosT + oy * sinT;
          const tiltedY = oy * cosT - alongTilt * sinT - dropDist;

          const rumble = p > 0 && p < 0.95 ? Math.sin(age * 52.0 + i * 1.7) * 0.22 * (1 - p) : 0;
          const inwardPull = fall * 0.05;

          arr[dst] = cx + (perpX + tiltedAlong * nx) * (1 - inwardPull) + rumble;
          arr[dst + 1] = Math.max(-4.0, tiltedY);
          arr[dst + 2] = cz + (perpZ + tiltedAlong * nz) * (1 - inwardPull) + rumble * 0.8;
        }

        posAttr.clearUpdateRanges();
        posAttr.addUpdateRange(vStart * 3, count * 3);
        posAttr.needsUpdate = true;
      }

      if (Array.isArray(target._colliders)) {
        for (const col of target._colliders) {
          if (p > 0) {
            col.maxY = 0;
            col.destroyed = true;
          }
        }
      }
    }

    // 2. Landmark Building (`col._landmarkSlices`)
    if (target._landmarkSlices) {
      const { instSlices, vertSlices } = target._landmarkSlices;
      const bHeight = Math.max(24, target.origMaxY || 90);
      const dropDist = fall * (bHeight + 6.0);
      const buried = p >= 0.96;
      const maxTilt = Math.min(0.32, 12.0 / Math.max(24, bHeight));
      const theta = Math.sin(p * Math.PI * 0.5) * maxTilt;

      for (const { inst, items } of instSlices) {
        for (const { index, origBox } of items) {
          if (buried) {
            this.solidDebrisInst && inst.setMatrixAt(index, this._zeroMatrix);
            continue;
          }
          const hRatio = Math.min(1, Math.max(0, origBox.y / bHeight));
          const tiltShift = origBox.y * Math.sin(theta);
          const curY = Math.max(-origBox.h, origBox.y * Math.cos(theta) - dropDist);
          this._tmpMat4
            .makeScale(origBox.w, origBox.h, origBox.d)
            .setPosition(
              origBox.x + nx * tiltShift + shudderX * hRatio,
              curY,
              origBox.z + nz * tiltShift + shudderZ * hRatio
            );
          inst.setMatrixAt(index, this._tmpMat4);
        }
        inst.instanceMatrix.needsUpdate = true;
      }
      for (const { mesh, indices, origCoords } of vertSlices) {
        const posAttr = mesh.geometry?.attributes?.position;
        if (!posAttr) continue;
        const arr = posAttr.array;
        for (let k = 0; k < indices.length; k++) {
          const vi = indices[k] * 3;
          const ox = origCoords[k * 3];
          const oy = origCoords[k * 3 + 1];
          const oz = origCoords[k * 3 + 2];
          if (buried) {
            arr[vi] = ox;
            arr[vi + 1] = -4.0;
            arr[vi + 2] = oz;
          } else {
            const hRatio = Math.min(1, Math.max(0, oy / bHeight));
            const tiltShift = oy * Math.sin(theta);
            arr[vi] = ox + nx * tiltShift + shudderX * hRatio;
            arr[vi + 1] = Math.max(-4.0, oy * Math.cos(theta) - dropDist);
            arr[vi + 2] = oz + nz * tiltShift + shudderZ * hRatio;
          }
        }
        posAttr.needsUpdate = true;
      }
      if (p > 0) {
        target.maxY = 0;
        target.destroyed = true;
      }
    }
  }

  _populateCollapsedFootprintRubble(minX, maxX, minZ, maxZ, bHeight = 28) {
    const spanX = Math.max(8, maxX - minX);
    const spanZ = Math.max(8, maxZ - minZ);
    const heightScale = Math.min(1.65, Math.max(0.85, bHeight / 28));
    const count = 44;

    for (let k = 0; k < count; k++) {
      // Deterministic Halton-like distribution across the building footprint
      const u = 0.06 + ((k * 37 + 17) % 88) * 0.01;
      const v = 0.06 + ((k * 53 + 29) % 88) * 0.01;
      const rx = minX + u * spanX;
      const rz = minZ + v * spanZ;
      // Rubble mounds higher in the center of the collapsed footprint, tapering toward sidewalks
      const distCenter = Math.hypot(u - 0.5, v - 0.5);
      const moundProfile = Math.max(0.2, 1.0 - distCenter * 1.15);

      const isGirder = k % 4 === 0;
      const isSlab = !isGirder && k % 3 === 0;
      const col = isGirder
        ? this.colors.steelGirder
        : k % 5 === 0
          ? this.colors.brick
          : k % 2 === 0
            ? this.colors.limestone
            : this.colors.concrete;

      let sx, sy, sz, ry, rotX, rotY, rotZ;
      rotY = ((k * 1.93) % 6.28);

      if (isGirder) {
        // Twisted structural steel I-beams jutting out of the rubble pile
        sx = (3.8 + (k % 4) * 1.15) * Math.min(1.3, spanX / 14);
        sy = 0.34;
        sz = 0.38;
        ry = (0.45 + moundProfile * 1.45 + (k % 3) * 0.32) * heightScale;
        rotX = ((k % 2 === 0 ? 1 : -1) * (0.24 + (k % 4) * 0.12));
        rotZ = ((k % 3 === 0 ? 1 : -1) * (0.28 + (k % 3) * 0.14));
      } else if (isSlab) {
        // Broken floor pancake slabs tilted over underlying masonry
        sx = 2.2 + (k % 4) * 0.85;
        sy = 0.32 + (k % 3) * 0.18;
        sz = 2.0 + ((k + 2) % 4) * 0.75;
        ry = (0.28 + moundProfile * 1.25 + (k % 4) * 0.22) * heightScale;
        rotX = ((k % 2 === 0 ? 1 : -1) * (0.14 + (k % 3) * 0.09));
        rotZ = ((k % 3 === 0 ? -1 : 1) * (0.12 + (k % 4) * 0.08));
      } else {
        // Craggy masonry, brick wall chunks, and limestone cornice blocks
        sx = 1.35 + (k % 5) * 0.65;
        sy = (0.55 + (k % 4) * 0.42) * heightScale;
        sz = 1.25 + ((k + 1) % 5) * 0.58;
        ry = sy * 0.48 + moundProfile * 0.85 * heightScale;
        rotX = (k % 3 - 1) * 0.18;
        rotZ = (k % 2 === 0 ? 1 : -1) * 0.16;
      }

      this._spawnSettledRubbleItem(rx, ry, rz, sx, sy, sz, col, rotX, rotY, rotZ);
    }
  }

  _createFurnitureModel(subKind, stateType = 'office') {
    const g = new THREE.Group();
    const woodMat = stateType === 'office' ? this.mats.furnitureWalnut : this.mats.furnitureOak;
    const fabricMat = stateType === 'office' ? this.mats.furnitureFabricNavy : this.mats.furnitureFabricRust;
    const metalMat = this.mats.furnitureChrome;

    const addPart = (w, h, d, px, py, pz, mat) => {
      const m = new THREE.Mesh(this.geoms.box, mat);
      m.scale.set(w, h, d);
      m.position.set(px, py, pz);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };

    if (subKind === 'desk') {
      // Desktop slab + side drawer pedestal + chrome legs + widescreen computer monitor
      addPart(1.56, 0.06, 0.78, 0, 0.76, 0, woodMat);
      addPart(0.42, 0.72, 0.72, 0.52, 0.36, 0, woodMat);
      addPart(0.05, 0.74, 0.05, -0.68, 0.37, 0.32, metalMat);
      addPart(0.05, 0.74, 0.05, -0.68, 0.37, -0.32, metalMat);
      addPart(0.56, 0.34, 0.04, -0.12, 1.04, -0.18, this.mats.furnitureScreen);
      addPart(0.08, 0.14, 0.08, -0.12, 0.84, -0.18, metalMat);
    } else if (subKind === 'chair') {
      // Cushioned swivel seat + contoured backrest + armrests + pedestal base
      addPart(0.52, 0.08, 0.52, 0, 0.48, 0, fabricMat);
      addPart(0.50, 0.52, 0.07, 0, 0.76, -0.22, fabricMat);
      addPart(0.06, 0.22, 0.40, -0.26, 0.60, 0, metalMat);
      addPart(0.06, 0.22, 0.40, 0.26, 0.60, 0, metalMat);
      addPart(0.07, 0.44, 0.07, 0, 0.22, 0, metalMat);
      addPart(0.54, 0.04, 0.08, 0, 0.04, 0, metalMat);
      addPart(0.08, 0.04, 0.54, 0, 0.04, 0, metalMat);
    } else if (subKind === 'sofa') {
      // 3-seater lounge couch with base, 3 cushions, high backrest & wide armrests
      addPart(1.92, 0.22, 0.84, 0, 0.16, 0, woodMat);
      addPart(1.80, 0.16, 0.68, 0, 0.34, 0.04, fabricMat);
      addPart(1.80, 0.52, 0.20, 0, 0.64, -0.30, fabricMat);
      addPart(0.22, 0.46, 0.84, -0.88, 0.44, 0, fabricMat);
      addPart(0.22, 0.46, 0.84, 0.88, 0.44, 0, fabricMat);
    } else if (subKind === 'bookshelf') {
      // Tall bookcase with uprights, 4 shelves & rows of books
      addPart(0.06, 1.86, 0.38, -0.56, 0.93, 0, woodMat);
      addPart(0.06, 1.86, 0.38, 0.56, 0.93, 0, woodMat);
      addPart(1.18, 1.86, 0.04, 0, 0.93, -0.17, woodMat);
      for (let s = 0; s < 4; s++) {
        const sy = 0.22 + s * 0.46;
        addPart(1.12, 0.04, 0.36, 0, sy, 0, woodMat);
        addPart(0.38, 0.28, 0.24, -0.24 + (s % 2) * 0.18, sy + 0.16, 0.02, s % 2 === 0 ? fabricMat : this.mats.signalYellow);
        addPart(0.28, 0.24, 0.22, 0.26 - (s % 2) * 0.14, sy + 0.14, 0.02, metalMat);
      }
    } else if (subKind === 'counter') {
      // Retail store / cafe counter with top slab & register
      addPart(1.52, 0.90, 0.56, 0, 0.45, 0, woodMat);
      addPart(1.60, 0.06, 0.64, 0, 0.93, 0, metalMat);
      addPart(0.36, 0.28, 0.30, 0.35, 1.10, 0, this.mats.furnitureScreen);
    } else if (subKind === 'plant') {
      // Potted indoor ficus tree
      addPart(0.42, 0.44, 0.42, 0, 0.22, 0, this.mats.roomWallCream);
      addPart(0.08, 0.55, 0.08, 0, 0.62, 0, woodMat);
      if (!this.mats.plantFoliage) {
        this.mats.plantFoliage = new THREE.MeshStandardNodeMaterial({ color: 0x3f6e28, roughness: 0.78, metalness: 0.04 });
      }
      const crown = new THREE.Mesh(this.geoms.box, this.mats.plantFoliage);
      crown.scale.set(0.68, 0.72, 0.68);
      crown.position.set(0, 1.05, 0);
      g.add(crown);
    } else {
      // Coffee / bistro table with lower shelf & 4 legs
      addPart(1.16, 0.06, 0.68, 0, 0.48, 0, woodMat);
      addPart(0.96, 0.03, 0.52, 0, 0.18, 0, woodMat);
      for (const lx of [-0.50, 0.50]) {
        for (const lz of [-0.26, 0.26]) {
          addPart(0.06, 0.46, 0.06, lx, 0.23, lz, metalMat);
        }
      }
    }
    return g;
  }

  /**
   * Fractures 3D Voronoi wall shards from the impacted building wall face using the building's exact exterior TSL material
   * and world-space normal `(wallNx, 0, wallNz)` (never spawning fake dummy walls or replacing intact facade quads),
   * and ejects collidable/destructible 3D interior furniture props out onto the street/sidewalk.
   */
  _fractureBuildingWallAndSpawnFurniture(target, col, x, y, z, fnx, fnz, impact, isPlayer = false) {
    if (!target) return false;
    target._impactFractures = target._impactFractures || [];

    const bHeight = Math.max(12, target.height || target.origMaxY || 28);
    const stateType = bHeight > 45 ? 'office' : bHeight > 26 ? 'retail' : 'residential';
    const stateLabel = stateType === 'office' ? 'OFFICE SUITE' : stateType === 'retail' ? 'STOREFRONT' : 'APARTMENT';

    if (!this.mats.masonryBrickWall) {
      this.mats.masonryBrickWall = new THREE.MeshStandardNodeMaterial({ color: 0x9b4f3b, roughness: 0.86, metalness: 0.04 });
      this.mats.masonryLimestoneWall = new THREE.MeshStandardNodeMaterial({ color: 0xd4c8b4, roughness: 0.78, metalness: 0.05 });
      this.mats.concreteCoreMat = new THREE.MeshStandardNodeMaterial({ color: 0x76797e, roughness: 0.90, metalness: 0.06 });
      this.mats.interiorPlaster = new THREE.MeshStandardNodeMaterial({ color: 0xe6e0d5, roughness: 0.88, metalness: 0.02 });
      this.mats.interiorFloor = new THREE.MeshStandardNodeMaterial({ color: 0x443b32, roughness: 0.76, metalness: 0.06 });
    }

    let breachX = x;
    let breachZ = z;
    let wallNx = fnx;
    let wallNz = fnz;
    const sectionHalfW = 2.6;
    const sectionTopY = 3.8;

    if (target._footprintSlice) {
      const { mesh, vStart, vEnd, origPositions } = target._footprintSlice;
      const count = vEnd - vStart;
      let bestQuad = -1;
      let bestScore = Infinity;
      let bestAx = 0, bestAz = 0, bestBx = 0, bestBz = 0, bestLen = 0, bestS = 0;

      // Pass 1: Strict distance and normal match
      let i = 0;
      while (i + 3 < count) {
        const oy0 = origPositions[i * 3 + 1];
        const oy1 = origPositions[(i + 1) * 3 + 1];
        const oy2 = origPositions[(i + 2) * 3 + 1];
        const oy3 = origPositions[(i + 3) * 3 + 1];
        if (oy0 < 0.5 && oy1 < 0.5 && oy2 > 1.5 && oy3 > 1.5) {
          const ax = origPositions[i * 3];
          const az = origPositions[i * 3 + 2];
          const bx = origPositions[(i + 1) * 3];
          const bz = origPositions[(i + 1) * 3 + 2];
          const dx = bx - ax;
          const dz = bz - az;
          const len = Math.hypot(dx, dz);
          if (len >= 1.2) {
            const ux = dx / len;
            const uz = dz / len;
            const wnx = -uz;
            const wnz = ux;
            const sRaw = (x - ax) * ux + (z - az) * uz;
            const sClamp = Math.max(0, Math.min(len, sRaw));
            const px = ax + ux * sClamp;
            const pz = az + uz * sClamp;
            const distSq = (x - px) * (x - px) + (z - pz) * (z - pz);
            const dotN = wnx * fnx + wnz * fnz;
            const score = distSq - dotN * 4.5;
            if (distSq < 96.0 && score < bestScore) {
              bestScore = score;
              bestQuad = i;
              bestAx = ax;
              bestAz = az;
              bestBx = bx;
              bestBz = bz;
              bestLen = len;
              const edgePad = Math.min(sectionHalfW, len * 0.45);
              bestS = Math.max(edgePad, Math.min(len - edgePad, sClamp));
            }
          }
          i += 4;
        } else {
          i += 1;
        }
      }

      // Pass 2: Fallback to closest footprint wall segment if high speed jumped past threshold
      if (bestQuad < 0) {
        let fallbackScore = Infinity;
        let fi = 0;
        while (fi + 3 < count) {
          const oy0 = origPositions[fi * 3 + 1];
          const oy2 = origPositions[(fi + 2) * 3 + 1];
          if (oy0 < 0.5 && oy2 > 1.5) {
            const ax = origPositions[fi * 3];
            const az = origPositions[fi * 3 + 2];
            const bx = origPositions[(fi + 1) * 3];
            const bz = origPositions[(fi + 1) * 3 + 2];
            const dx = bx - ax;
            const dz = bz - az;
            const len = Math.hypot(dx, dz);
            if (len >= 1.0) {
              const ux = dx / len;
              const uz = dz / len;
              const sRaw = (x - ax) * ux + (z - az) * uz;
              const sClamp = Math.max(0, Math.min(len, sRaw));
              const px = ax + ux * sClamp;
              const pz = az + uz * sClamp;
              const distSq = (x - px) * (x - px) + (z - pz) * (z - pz);
              if (distSq < fallbackScore) {
                fallbackScore = distSq;
                bestQuad = fi;
                bestAx = ax;
                bestAz = az;
                bestBx = bx;
                bestBz = bz;
                bestLen = len;
                const edgePad = Math.min(sectionHalfW, len * 0.45);
                bestS = Math.max(edgePad, Math.min(len - edgePad, sClamp));
              }
            }
            fi += 4;
          } else {
            fi += 1;
          }
        }
      }

      if (bestQuad >= 0) {
        const dx = bestBx - bestAx;
        const dz = bestBz - bestAz;
        const ux = dx / bestLen;
        const uz = dz / bestLen;
        wallNx = -uz;
        wallNz = ux;
        breachX = bestAx + ux * bestS;
        breachZ = bestAz + uz * bestS;
        const reverse = (Math.abs(dz) >= Math.abs(dx) ? dz : dx) < 0;

        const vBase = vStart + bestQuad;
        const boxAttr = mesh.geometry?.attributes?.box;
        const fwAttr = mesh.geometry?.attributes?.facadeWall;
        const boxTuple = boxAttr
          ? [boxAttr.getX(vBase), boxAttr.getY(vBase), boxAttr.getZ(vBase), boxAttr.getW(vBase)]
          : [bestLen, bHeight, bHeight, 0.5];
        const wallKind = fwAttr ? fwAttr.getZ(vBase) : 2.0;
        const exteriorWallMat =
          mesh.material || ((target.tone ?? 0.5) < 0.45 ? this.mats.masonryBrickWall : this.mats.masonryLimestoneWall);
        const topY = origPositions[(bestQuad + 2) * 3 + 1];

        // Breach dimensions scaling with impact speed & kinetic force
        const breachW = Math.min(bestLen - 0.2, Math.max(4.2, Math.min(22.0, 3.8 + Math.sqrt(impact) * 0.65)));
        const breachH = Math.min(topY - 0.35, Math.max(3.8, Math.min(14.0, 3.8 + Math.sqrt(impact) * 0.45)));
        const s0 = Math.max(0, bestS - breachW * 0.5);
        const s1 = Math.min(bestLen, bestS + breachW * 0.5);

        target._breachedQuads = target._breachedQuads || new Set();
        if (!target._breachedQuads.has(bestQuad)) {
          target._breachedQuads.add(bestQuad);
          // Drop the original intact quad vertices to zero-area underground so the unbroken wall is removed!
          const posAttr = mesh.geometry?.attributes?.position;
          if (posAttr) {
            const arr = posAttr.array;
            for (let k = 0; k < 4; k++) {
              const idx = (vStart + bestQuad + k) * 3;
              arr[idx + 0] = 0;
              arr[idx + 1] = -500;
              arr[idx + 2] = 0;
            }
            posAttr.clearUpdateRanges();
            posAttr.addUpdateRange((vStart + bestQuad) * 3, 12);
            posAttr.needsUpdate = true;
          }

          target._wallBays = target._wallBays || [];
          // Build left remaining wall pillar [0 .. s0]
          if (s0 > 0.45) {
            const leftPoly = [
              [0, 0.22],
              [s0, 0.22],
              [s0, topY],
              [0, topY],
            ];
            const leftBuilt = this.destructibleBuildingManager.buildWallPrismGeometry(
              leftPoly, bestLen, topY, boxTuple, wallKind, ux, uz, wallNx, wallNz, reverse, 0.34
            );
            if (leftBuilt) {
              const leftMesh = new THREE.Mesh(leftBuilt.geo, [exteriorWallMat, this.mats.concreteCoreMat]);
              leftMesh.castShadow = true;
              leftMesh.receiveShadow = true;
              leftMesh.position.set(bestAx + ux * leftBuilt.sCenter + wallNx * 0.12, leftBuilt.yCenter, bestAz + uz * leftBuilt.sCenter + wallNz * 0.12);
              this.group.add(leftMesh);
              target._wallBays.push({ mesh: leftMesh });
            }
          }

          // Build right remaining wall pillar [s1 .. bestLen]
          if (bestLen - s1 > 0.45) {
            const rightPoly = [
              [s1, 0.22],
              [bestLen, 0.22],
              [bestLen, topY],
              [s1, topY],
            ];
            const rightBuilt = this.destructibleBuildingManager.buildWallPrismGeometry(
              rightPoly, bestLen, topY, boxTuple, wallKind, ux, uz, wallNx, wallNz, reverse, 0.34
            );
            if (rightBuilt) {
              const rightMesh = new THREE.Mesh(rightBuilt.geo, [exteriorWallMat, this.mats.concreteCoreMat]);
              rightMesh.castShadow = true;
              rightMesh.receiveShadow = true;
              rightMesh.position.set(bestAx + ux * rightBuilt.sCenter + wallNx * 0.12, rightBuilt.yCenter, bestAz + uz * rightBuilt.sCenter + wallNz * 0.12);
              this.group.add(rightMesh);
              target._wallBays.push({ mesh: rightMesh });
            }
          }

          // Build top broken lintel above the breach [s0 .. s1] x [breachH .. topY]
          if (topY - breachH > 0.45) {
            const lintelPoly = [
              [s0, breachH],
              [s1, breachH],
              [s1, topY],
              [s0, topY],
            ];
            const lintelBuilt = this.destructibleBuildingManager.buildWallPrismGeometry(
              lintelPoly, bestLen, topY, boxTuple, wallKind, ux, uz, wallNx, wallNz, reverse, 0.34
            );
            if (lintelBuilt) {
              const lintelMesh = new THREE.Mesh(lintelBuilt.geo, [exteriorWallMat, this.mats.concreteCoreMat]);
              lintelMesh.castShadow = true;
              lintelMesh.receiveShadow = true;
              lintelMesh.position.set(bestAx + ux * lintelBuilt.sCenter + wallNx * 0.12, lintelBuilt.yCenter, bestAz + uz * lintelBuilt.sCenter + wallNz * 0.12);
              this.group.add(lintelMesh);
              target._wallBays.push({ mesh: lintelMesh });
            }
          }

          // Construct 3D interior room enclosure behind the breach (floor, back wall, side walls, ceiling)
          const inX = -wallNx;
          const inZ = -wallNz;
          const roomW = (s1 - s0) + 0.35;
          const roomDepth = Math.min(8.8, Math.max(5.8, (s1 - s0) * 0.95));
          const roomMidS = (s0 + s1) * 0.5;
          const roomMidX = bestAx + ux * roomMidS + inX * (roomDepth * 0.5);
          const roomMidZ = bestAz + uz * roomMidS + inZ * (roomDepth * 0.5);
          const roomYaw = Math.atan2(wallNx, wallNz);

          // 1. Interior Floor Slab
          const floorMesh = new THREE.Mesh(this.geoms.box, this.mats.interiorFloor);
          floorMesh.scale.set(roomW, 0.12, roomDepth);
          floorMesh.position.set(roomMidX, 0.22, roomMidZ);
          floorMesh.rotation.y = roomYaw;
          floorMesh.receiveShadow = true;
          this.group.add(floorMesh);
          target._wallBays.push({ mesh: floorMesh });

          // 2. Interior Back Wall
          const backWallMesh = new THREE.Mesh(this.geoms.box, this.mats.interiorPlaster);
          backWallMesh.scale.set(roomW, breachH, 0.22);
          backWallMesh.position.set(
            bestAx + ux * roomMidS + inX * roomDepth,
            0.22 + breachH * 0.5,
            bestAz + uz * roomMidS + inZ * roomDepth
          );
          backWallMesh.rotation.y = roomYaw;
          backWallMesh.castShadow = true;
          backWallMesh.receiveShadow = true;
          this.group.add(backWallMesh);
          target._wallBays.push({ mesh: backWallMesh });

          // 3. Interior Left Partition Wall
          const leftWallMesh = new THREE.Mesh(this.geoms.box, this.mats.interiorPlaster);
          leftWallMesh.scale.set(0.22, breachH, roomDepth);
          leftWallMesh.position.set(
            bestAx + ux * s0 + inX * (roomDepth * 0.5),
            0.22 + breachH * 0.5,
            bestAz + uz * s0 + inZ * (roomDepth * 0.5)
          );
          leftWallMesh.rotation.y = roomYaw;
          leftWallMesh.castShadow = true;
          leftWallMesh.receiveShadow = true;
          this.group.add(leftWallMesh);
          target._wallBays.push({ mesh: leftWallMesh });

          // 4. Interior Right Partition Wall
          const rightWallMesh = new THREE.Mesh(this.geoms.box, this.mats.interiorPlaster);
          rightWallMesh.scale.set(0.22, breachH, roomDepth);
          rightWallMesh.position.set(
            bestAx + ux * s1 + inX * (roomDepth * 0.5),
            0.22 + breachH * 0.5,
            bestAz + uz * s1 + inZ * (roomDepth * 0.5)
          );
          rightWallMesh.rotation.y = roomYaw;
          rightWallMesh.castShadow = true;
          rightWallMesh.receiveShadow = true;
          this.group.add(rightWallMesh);
          target._wallBays.push({ mesh: rightWallMesh });

          // 5. Interior Ceiling Slab
          const ceilMesh = new THREE.Mesh(this.geoms.box, this.mats.concreteCoreMat);
          ceilMesh.scale.set(roomW, 0.14, roomDepth);
          ceilMesh.position.set(roomMidX, 0.22 + breachH, roomMidZ);
          ceilMesh.rotation.y = roomYaw;
          ceilMesh.castShadow = true;
          this.group.add(ceilMesh);
          target._wallBays.push({ mesh: ceilMesh });
        }

        // Now fracture 3D Voronoi wall shards across the opened breach opening [s0 .. s1] x [0.22 .. breachH]
        this.destructibleBuildingManager.fractureWallSection({
          s0,
          s1,
          y0: 0.22,
          y1: breachH,
          impactS: bestS,
          impactY: Math.max(0.85, Math.min(breachH - 0.55, y + 0.85)),
          bestAx,
          bestAz,
          ux,
          uz,
          wallNx,
          wallNz,
          bestLen,
          topY,
          boxTuple,
          wallKind,
          reverse,
          exteriorMat: exteriorWallMat,
          interiorMat: this.mats.concreteCoreMat,
          impactSpeed: impact,
          inwardBias: -1,
        });

        // Register breach opening for pass-through
        const opening = {
          x: breachX,
          z: breachZ,
          nx: wallNx,
          nz: wallNz,
          halfWidth: (s1 - s0) * 0.5 + 0.45,
          depth: 8.5,
          maxY: breachH,
        };
        if (col) {
          col._breachOpenings = col._breachOpenings || [];
          col._breachOpenings.push(opening);
        }
        if (Array.isArray(target._colliders)) {
          for (const c of target._colliders) {
            c._breachOpenings = c._breachOpenings || [];
            if (!c._breachOpenings.includes(opening)) c._breachOpenings.push(opening);
          }
        }
      }
    } else {
      const tx = -wallNz;
      const tz = wallNx;
      const fallbackMat = (target.tone ?? 0.5) < 0.45 ? this.mats.masonryBrickWall : this.mats.masonryLimestoneWall;
      this.destructibleBuildingManager.fractureWallSection({
        s0: 0,
        s1: sectionHalfW * 2,
        y0: 0.22,
        y1: sectionTopY,
        impactS: sectionHalfW,
        impactY: Math.max(0.85, Math.min(sectionTopY - 0.55, y + 0.85)),
        bestAx: breachX - tx * sectionHalfW,
        bestAz: breachZ - tz * sectionHalfW,
        ux: tx,
        uz: tz,
        wallNx,
        wallNz,
        bestLen: sectionHalfW * 2,
        topY: bHeight + 0.22,
        boxTuple: [sectionHalfW * 2, bHeight, bHeight, 0.5],
        wallKind: 2.0,
        reverse: false,
        exteriorMat: fallbackMat,
        interiorMat: this.mats.concreteCoreMat,
        impactSpeed: impact,
        inwardBias: -1,
      });
    }

    // Spawn collidable & destructible 3D interior furniture models INSIDE the room + 1-2 blast fragments outside
    if (target._impactFractures.length < 3) {
      const tx = -wallNz;
      const tz = wallNx;
      const inX = -wallNx;
      const inZ = -wallNz;
      const layout =
        stateType === 'office'
          ? [
              { subKind: 'desk', along: -1.35, depth: 3.2, yawOff: 0.15 },
              { subKind: 'chair', along: -1.35, depth: 2.2, yawOff: 0.85 },
              { subKind: 'bookshelf', along: -2.2, depth: 5.5, yawOff: 0 },
              { subKind: 'bookshelf', along: 2.1, depth: 5.5, yawOff: -0.1 },
              { subKind: 'table', along: 1.45, depth: 4.2, yawOff: 0.2 },
              { subKind: 'chair', along: 1.45, depth: 3.2, yawOff: -0.4 },
              { subKind: 'plant', along: -2.3, depth: 1.8, yawOff: 0 },
              { subKind: 'sofa', along: 1.5, depth: 2.2, yawOff: -0.25 },
              { subKind: 'chair', along: 0.35, depth: -1.5, yawOff: 0.75 }, // Blown out by impact
            ]
          : stateType === 'retail'
            ? [
                { subKind: 'counter', along: 0.0, depth: 2.8, yawOff: 0 },
                { subKind: 'table', along: -1.8, depth: 4.5, yawOff: 0.25 },
                { subKind: 'bookshelf', along: 2.2, depth: 5.2, yawOff: -0.1 },
                { subKind: 'chair', along: 0.8, depth: 3.6, yawOff: -0.5 },
                { subKind: 'plant', along: 2.1, depth: 1.8, yawOff: 0 },
                { subKind: 'table', along: -0.6, depth: -1.4, yawOff: 0.6 }, // Blown out
              ]
            : [
                { subKind: 'sofa', along: -0.9, depth: 3.2, yawOff: 0.1 },
                { subKind: 'table', along: -0.9, depth: 2.0, yawOff: 0.35 },
                { subKind: 'chair', along: 1.3, depth: 2.8, yawOff: -0.45 },
                { subKind: 'bookshelf', along: -2.1, depth: 5.2, yawOff: 0 },
                { subKind: 'table', along: 1.5, depth: 4.8, yawOff: 0.15 },
                { subKind: 'chair', along: 0.4, depth: -1.5, yawOff: 0.8 }, // Blown out
              ];

      const baseYaw = Math.atan2(wallNx, wallNz);
      const spawnedProps = [];
      for (const item of layout) {
        const fxPos = breachX + tx * item.along + inX * item.depth;
        const fzPos = breachZ + tz * item.along + inZ * item.depth;
        const fMesh = this._createFurnitureModel(item.subKind, stateType);
        fMesh.position.set(fxPos, 0.22, fzPos);
        fMesh.rotation.y = baseYaw + (item.yawOff || 0);
        this.group.add(fMesh);

        const prop = {
          kind: 'furniture',
          subKind: item.subKind,
          x: fxPos,
          y: 0.22,
          z: fzPos,
          radius: item.subKind === 'sofa' || item.subKind === 'desk' || item.subKind === 'counter' ? 0.88 : 0.62,
          height: item.subKind === 'bookshelf' ? 1.85 : 1.1,
          destroyed: false,
          mesh: fMesh,
          primaryColor: stateType === 'office' ? this.colors.woodBark : this.colors.woodSplinter,
          secondaryColor: stateType === 'office' ? this.colors.mailboxBlue : this.colors.brick,
        };
        this.allProps.push(prop);
        const ck = this._cellKey(fxPos, fzPos);
        let cellList = this.cells.get(ck);
        if (!cellList) {
          cellList = [];
          this.cells.set(ck, cellList);
        }
        cellList.push(prop);
        spawnedProps.push(prop);
      }

      target._impactFractures.push({
        x: breachX,
        z: breachZ,
        props: spawnedProps,
        stateLabel,
      });
    }

    return stateLabel;
  }

  collapseBuilding(target, x, y, z, fnx, fnz, impact, isPlayer = false, isRestoring = false) {
    if (!target || target._collapsed || target._collapsing) return;

    this.collapsedTargets.add(target);
    this.brokenObjectsCount++;
    this.stats.propsDestroyed = this.brokenObjectsCount;
    this.stats.buildingsDamaged = (this.stats.buildingsDamaged || 0) + 1;

    target.destroyed = true;
    if (Array.isArray(target._wallBays)) {
      for (const wb of target._wallBays) {
        wb.destroyed = true;
        if (wb.mesh) {
          wb.mesh.visible = false;
          this.group.remove(wb.mesh);
          wb.mesh.geometry?.dispose();
        }
      }
      target._wallBays.length = 0;
    }
    if (Array.isArray(target._colliders)) {
      for (const col of target._colliders) {
        col.maxY = 0;
        col.destroyed = true;
      }
    }
    if (target._detail) {
      target._detail.destroyed = true;
      if (this.cityBlocks && typeof this.cityBlocks.refreshStream === 'function') {
        this.cityBlocks.refreshStream();
      }
    }

    const cx = target.cx ?? ((target.minX + target.maxX) * 0.5 || x);
    const cz = target.cz ?? ((target.minZ + target.maxZ) * 0.5 || z);
    const minX = target.minX ?? cx - 12;
    const maxX = target.maxX ?? cx + 12;
    const minZ = target.minZ ?? cz - 12;
    const maxZ = target.maxZ ?? cz + 12;
    const bHeight = Math.max(12, target.height || target.origMaxY || 28);

    this._populateCollapsedFootprintRubble(minX, maxX, minZ, maxZ, bHeight);

    if (isRestoring) {
      target._collapsed = true;
      this._applyBuildingCollapseProgress(target, 1.0, fnx, fnz, 0, 0);
      return;
    }

    // Burst 3D textured Voronoi wall shards from the collapsing building's ground-floor walls
    this._fractureBuildingWallAndSpawnFurniture(target, null, x, y, z, fnx, fnz, Math.max(10.0, impact * 1.3), isPlayer);

    target._collapsing = true;
    if (isPlayer) {
      this.lastImpactLabel = 'BUILDING DESTROYED — TOTAL STRUCTURAL COLLAPSE!';
      this.lastImpactTimer = 3.2;
    }

    for (let k = 0; k < 10; k++) {
      const ang = (k / 10) * Math.PI * 2;
      const px = cx + Math.cos(ang) * (maxX - minX) * 0.38;
      const pz = cz + Math.sin(ang) * (maxZ - minZ) * 0.38;
      this._spawnVolumetricPlume(px, 1.2 + (k % 3) * 0.9, pz, k % 3 === 0 ? 'blackSmoke' : 'dust', 1.85, 3.0);
    }

    this.savedState.collapsedBuildings.push({
      cx: Math.round(cx * 10) / 10,
      cz: Math.round(cz * 10) / 10,
      nx: Math.round(fnx * 100) / 100,
      nz: Math.round(fnz * 100) / 100,
      impact: Math.round(impact * 10) / 10,
    });
    this._scheduleSave();

    this.collapsingBuildings.push({
      target,
      cx,
      cz,
      minX,
      maxX,
      minZ,
      maxZ,
      height: bHeight,
      nx: fnx,
      nz: fnz,
      age: 0,
      duration: 1.65,
      emitAccum: 0,
    });
  }

  triggerWarpShockwave(x, y, z) {
    if (this.cameraSystem) {
      this.cameraSystem.addTrauma(0.65);
    }
    this._spawnSparkStreaks(x, Math.max(0.6, y + 0.6), z, 0, 1, 40.0, 28);
    for (let i = 0; i < 4; i++) {
      this._spawnVolumetricPlume(
        x + (Math.random() - 0.5) * 3,
        Math.max(0.5, y + 0.5),
        z + (Math.random() - 0.5) * 3,
        'dust',
        1.6,
        2.6
      );
    }
  }

  /**
   * Handles building collisions:
   * - Fractures 3D Voronoi wall shards with the building's exact exterior TSL material & world-space normals (zero dummy walls).
   * - Any solid vehicle ram (impact >= 3.8 m/s) or 2 lighter hits triggers a full 3D structural tilt-and-fall building collapse.
   */
  onBuildingCollision(entity, mode, x, y, z, nx, nz, speed, isPlayer = false, collider = null) {
    const impact = Math.max(1.5, speed);
    const nLen = Math.hypot(nx, nz) || 1;
    const fnx = nx / nLen;
    const fnz = nz / nLen;

    const col = collider || this._findBuildingColliderNear(x, z);
    const target = col ? (col.buildingRecord || col) : null;

    this._spawnSparkStreaks(x + fnx * 0.25, Math.max(0.5, y + 0.35), z + fnz * 0.25, fnx, fnz, impact, 14);
    this.spawnDebrisBurst(x + fnx * 0.3, Math.max(0.7, y + 0.6), z + fnz * 0.3, fnx, fnz, impact * 0.95, {
      count: mode === 'person' ? 2 : Math.min(12, Math.max(4, Math.floor(impact * 0.7))),
      matA: this.mats.glassShard,
      matB: this.mats.glassShard,
      scaleMin: 0.18,
      scaleMax: 0.44,
      persistent: true,
    });

    const dustCount = mode === 'person' ? 1 : Math.min(6, Math.max(2, Math.floor(impact * 0.42)));
    for (let i = 0; i < dustCount; i++) {
      this._spawnVolumetricPlume(
        x + fnx * 0.4 + (Math.random() - 0.5) * 1.2,
        Math.max(0.5, y + 0.3 + i * 0.3),
        z + fnz * 0.4 + (Math.random() - 0.5) * 1.2,
        impact > 11 && i === 0 ? 'blackSmoke' : 'dust',
        0.95 + Math.random() * 0.45,
        2.3
      );
    }

    if (target && !target._collapsed && !target._collapsing) {
      const entityMass = mode === 'helicopter' ? 3200 : (mode === 'car' || mode === 'traffic') ? 1600 : mode === 'cyclist' ? 140 : 90;
      const kineticEnergy = 0.5 * entityMass * (impact * impact);
      // Realistic speed & kinetic force scaling:
      // At 500 MPH (223.5 m/s), 1600kg car delivers ~40 MJ => ~47 damage (takes 2-3 rams to topple building).
      // At 1000 MPH (447.0 m/s), car delivers ~160 MJ => ~170 damage (instant total building collapse!).
      const damage = (kineticEnergy / 1050000.0) + (impact * 0.04);
      target._structuralDamage = (target._structuralDamage || 0) + damage;
      const threshold = 100.0;

      // Always fracture wall and construct the furnished 3D room breach on every direct hit
      const fracturedLabel = this._fractureBuildingWallAndSpawnFurniture(target, col, x, y, z, fnx, fnz, impact, isPlayer);

      if (target._structuralDamage >= threshold) {
        this.collapseBuilding(target, x, y, z, fnx, fnz, impact, isPlayer, false);
      } else {
        const healthPct = Math.max(1, Math.round(100 - (target._structuralDamage / threshold) * 100));
        if (isPlayer) {
          this.lastImpactLabel = fracturedLabel
            ? `WALL BREACHED — ${fracturedLabel} (BUILDING HEALTH: ${healthPct}%)`
            : `BUILDING STRUCTURAL HEALTH · ${healthPct}%`;
          this.lastImpactTimer = 2.8;
        }
        if (!target._shuddering) {
          target._shuddering = true;
          this.shudderingBuildings.push({
            target,
            nx: fnx,
            nz: fnz,
            age: 0,
            maxAge: 0.55,
            amp: Math.min(0.35, 0.12 + impact * 0.001),
          });
        }
      }
    } else if (isPlayer) {
      this.lastImpactLabel = 'BUILDING FACADE IMPACT';
      this.lastImpactTimer = 2.0;
    }

    this.applyEntityDamage(
      entity,
      mode,
      impact * 0.85,
      x,
      Math.max(0.5, y + 0.5),
      z,
      fnx,
      fnz,
      isPlayer,
      false
    );
  }

  onVehicleCollision(entityA, modeA, entityB, modeB, x, y, z, nx, nz, speed, isPlayerInvolved = false) {
    const impact = Math.max(3.0, speed);
    if (isPlayerInvolved) {
      this.lastImpactLabel = 'VEHICLE CRASH — MUTUAL STRUCTURAL DAMAGE';
      this.lastImpactTimer = 2.5;
    }

    this._spawnSparkStreaks(x, Math.max(0.5, y + 0.5), z, nx, nz, impact, Math.min(18, Math.floor(impact * 1.3)));
    // Only spawn translucent safety-glass shards here; solid vehicle body panels detach via VehicleDamageController
    this.spawnDebrisBurst(x, Math.max(0.6, y + 0.6), z, nx, nz, impact, {
      count: Math.min(8, Math.max(3, Math.floor(impact * 0.55))),
      matA: this.mats.glassShard,
      matB: this.mats.glassShard,
      scaleMin: 0.14,
      scaleMax: 0.32,
      persistent: true,
    });

    if (impact > 7.0) {
      for (let i = 0; i < 2; i++) {
        this._spawnVolumetricPlume(
          x + (Math.random() - 0.5) * 0.6,
          0.7 + i * 0.2,
          z + (Math.random() - 0.5) * 0.6,
          'blackSmoke',
          0.75 + Math.random() * 0.35,
          2.2
        );
      }
      if (impact > 11.5) {
        this._spawnVolumetricPlume(x, 0.65, z, 'fire', 0.75, 0.6);
      }
    }

    // Realistic Newton's 3rd Law momentum transfer: blast the struck vehicle backwards down the street
    if (entityB && (entityB.isTraffic || modeB === 'traffic' || !entityB.isPlayer)) {
      const impulseSpeed = Math.max(8.5, impact * 0.62);
      entityB.speed = (entityB.speed || 0) - impulseSpeed * 0.65;
      entityB.vx = (entityB.vx || 0) - nx * impulseSpeed;
      entityB.vz = (entityB.vz || 0) - nz * impulseSpeed;
      entityB.angularVel = (entityB.angularVel || 0) + (Math.random() - 0.5) * Math.min(8.0, impact * 0.18);
    }
    if (entityA && (entityA.isTraffic || modeA === 'traffic' || !entityA.isPlayer)) {
      const impulseSpeed = Math.max(8.5, impact * 0.62);
      entityA.speed = (entityA.speed || 0) + impulseSpeed * 0.65;
      entityA.vx = (entityA.vx || 0) + nx * impulseSpeed;
      entityA.vz = (entityA.vz || 0) + nz * impulseSpeed;
    }

    if (entityA) {
      this.applyEntityDamage(entityA, modeA, impact * 0.92, x, y + 0.6, z, nx, nz, entityA.isPlayer || modeA !== 'traffic', false);
    }
    if (entityB) {
      this.applyEntityDamage(entityB, modeB, impact * 0.92, x, y + 0.6, z, -nx, -nz, entityB.isPlayer || modeB !== 'traffic', false);
    }
  }

  onPedestrianCollision(striker, strikerMode, ped, x, y, z, nx, nz, speed, isPlayer = false, isLethal = false) {
    this.pedestriansStruckCount++;
    this.stats.pedestriansStruck = this.pedestriansStruckCount;

    if (isLethal) {
      this.stats.pedestriansKilled = (this.stats.pedestriansKilled || 0) + 1;
      if (ped && ped._countedHurt) {
        this.stats.pedestriansHurt = Math.max(0, (this.stats.pedestriansHurt || 1) - 1);
      }
    } else if (ped && !ped.isDead && !ped._countedHurt) {
      ped._countedHurt = true;
      this.stats.pedestriansHurt = (this.stats.pedestriansHurt || 0) + 1;
    }

    this._scheduleSave();

    const impact = Math.max(3.5, speed);
    if (isPlayer) {
      this.lastImpactLabel = isLethal
        ? `PEDESTRIAN KILLED (KILLS: ${this.stats.pedestriansKilled})`
        : `PEDESTRIAN HURT (HURT: ${this.stats.pedestriansHurt})`;
      this.lastImpactTimer = 2.6;
    }

    if (striker) {
      this.applyEntityDamage(striker, strikerMode, impact * 0.5, x, 0.92, z, -nx, -nz, isPlayer, true);
    }
  }

  /**
   * Smooth, continuous 3D automotive sheet-metal crumpling & hood folding (zero spiky high-frequency vertex noise,
   * and zero loss of vehicle vertical height).
   */
  _deformMeshVertices(entity, mesh, worldX, worldY, worldZ, severity, maxRadius = 1.85, worldNx = 0, worldNz = 0) {
    if (!mesh || !mesh.geometry || !entity._origPositions) return;
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    if (!posAttr) return;

    const ex = entity.x !== undefined ? entity.x : (entity.position ? entity.position.x : 0);
    const ey = entity.y !== undefined ? entity.y : (entity.position ? entity.position.y : 0);
    const ez = entity.z !== undefined ? entity.z : (entity.position ? entity.position.z : 0);
    const heading = entity.heading !== undefined ? entity.heading : ((entity.yaw || 0) + (entity.yawOffset || 0));
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);

    const dx = worldX - ex;
    const dy = worldY - ey;
    const dz = worldZ - ez;
    const localX = dx * cosH - dz * sinH;
    const localY = Math.max(0.35, Math.min(1.65, dy));
    const localZ = dx * sinH + dz * cosH;
    const localNx = worldNx * cosH - worldNz * sinH;
    const localNz = worldNx * sinH + worldNz * cosH;

    const arr = posAttr.array;
    const orig = entity._origPositions;
    const rSq = maxRadius * maxRadius;
    const dentStrength = Math.min(0.44, 0.10 + severity * 0.026);
    let modified = false;

    for (let i = 0; i < arr.length; i += 3) {
      const ox = orig[i];
      const oy = orig[i + 1];
      const oz = orig[i + 2];
      if (oy < 0.25) continue;

      const vx = arr[i];
      const vy = arr[i + 1];
      const vz = arr[i + 2];

      const ddx = vx - localX;
      const ddy = (vy - localY) * 1.05;
      const ddz = vz - localZ;
      const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
      if (distSq >= rSq) continue;

      const u = 1 - Math.sqrt(distSq) / maxRadius;
      const falloff = u * u * (3 - 2 * u); // Smooth Hermite C1 falloff
      const wave = 0.85 + 0.15 * Math.cos(ox * 2.4 + oz * 1.8);
      const push = dentStrength * falloff * wave;

      const inDirX = -Math.sign(ox || localX || 1) * 0.55 + localNx * 0.55;
      const inDirZ = -Math.sign(oz || localZ || 1) * 0.72 + localNz * 0.55;
      const targetX = vx + inDirX * push;
      const targetZ = vz + inDirZ * push;
      // Preserve vehicle height (never squash roof downward; allow subtle upward hood fold on front/rear impacts)
      const hoodArch = Math.abs(oz) > 0.75 && oy < 1.10 ? Math.max(0, Math.cos(ox * 1.4)) * 0.22 : 0.0;
      const buckleY = vy + hoodArch * push;

      arr[i] = Math.max(ox - 0.46, Math.min(ox + 0.46, targetX));
      arr[i + 1] = Math.max(oy, Math.min(oy + 0.24, buckleY));
      arr[i + 2] = Math.max(oz - 0.56, Math.min(oz + 0.56, targetZ));
      modified = true;
    }

    if (modified) {
      posAttr.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  _triggerPlayerTotalWreck(entity, mode) {
    if (!entity || entity.isWrecked) return;
    entity.isWrecked = true;
    entity.wreckTimer = 3.2;
    entity.damage = 100;
    entity.integrity = 0;

    const ex = entity.position ? entity.position.x : entity.x || 0;
    const ey = entity.position ? entity.position.y : 0;
    const ez = entity.position ? entity.position.z : entity.z || 0;

    this.lastImpactLabel = 'HEALTH 0% — TOTAL WRECK! STARTING OVER...';
    this.lastImpactTimer = 3.4;

    for (let i = 0; i < 4; i++) {
      this._spawnVolumetricPlume(ex + (Math.random() - 0.5) * 1.2, ey + 0.7 + i * 0.25, ez + (Math.random() - 0.5) * 1.2, i % 2 === 0 ? 'fire' : 'blackSmoke', 0.95, 2.2);
    }
    this._spawnSparkStreaks(ex, ey + 0.6, ez, 0, 1, 16, 18);
  }

  applyEntityDamage(entity, mode, rawSeverity, x, y, z, nx, nz, isPlayer = false, isSoftTarget = false) {
    if (!entity) return;
    const severity = Math.max(1.5, rawSeverity);

    // Player vehicle is invincible for collision testing (stays at 100% Health and full height unless explicitly overridden)
    if ((isPlayer || entity.isPlayer || mode !== 'traffic') && !entity.allowPlayerDamage) {
      entity.damage = 0;
      entity.integrity = 100;
      entity.isWrecked = false;
      entity.dentRoll = 0;
      entity.dentPitch = 0;
      entity.dentDepth = 0;
      if (!isSoftTarget || severity > 7.5) {
        this.spawnDebrisBurst(x, Math.max(0.55, y), z, nx, nz, severity * 0.8, {
          count: isSoftTarget ? 2 : Math.min(6, Math.max(2, Math.floor(severity * 0.4))),
          matA: this.mats.glassShard,
          matB: this.mats.glassShard,
          scaleMin: 0.14,
          scaleMax: 0.28,
          persistent: true,
        });
      }
      return;
    }

    entity.damage = (entity.damage || 0) + severity * (isSoftTarget ? 0.85 : 1.55);
    entity.integrity = Math.max(0, 100 - entity.damage);
    const dmgRatio = Math.min(1.0, (entity.damage || 0) / 100);

    if (isPlayer && entity.integrity <= 0 && !entity.isWrecked) {
      this._triggerPlayerTotalWreck(entity, mode);
    }

    if (mode === 'car' || mode === 'traffic') {
      entity.dentRoll = Math.max(-0.14, Math.min(0.14, (entity.dentRoll || 0) + (Math.random() - 0.5) * 0.04 * Math.min(1.5, severity * 0.14)));
      entity.dentPitch = Math.max(-0.10, Math.min(0.10, (entity.dentPitch || 0) + (Math.random() - 0.5) * 0.03 * Math.min(1.5, severity * 0.14)));

      const ex = entity.x !== undefined ? entity.x : (entity.position ? entity.position.x : 0);
      const ey = entity.y !== undefined ? entity.y : (entity.position ? entity.position.y : 0);
      const ez = entity.z !== undefined ? entity.z : (entity.position ? entity.position.z : 0);
      const heading = entity.heading !== undefined ? entity.heading : ((entity.yaw || 0) + (entity.yawOffset || 0));
      const sinH = Math.sin(heading);
      const cosH = Math.cos(heading);
      const dx = x - ex;
      const dy = y - ey;
      const dz = z - ez;
      const localX = dx * cosH - dz * sinH;
      const localY = Math.max(0.35, Math.min(1.55, dy));
      const localZ = dx * sinH + dz * cosH;
      const localNx = nx * cosH - nz * sinH;

      const maxHalfW = entity.bus ? 1.32 : (entity.halfWidth || 0.92);
      const maxHalfL = entity.bus ? 5.8 : (entity.halfL || 2.25);
      entity.dentX = Math.max(-maxHalfW, Math.min(maxHalfW, localX));
      entity.dentZ = Math.max(-maxHalfL, Math.min(maxHalfL, localZ));
      entity.dentDirX = Math.max(-1, Math.min(1, localNx));
      const addedDent = isSoftTarget ? severity * 0.015 : Math.max(0.16, severity * 0.036);
      entity.dentDepth = Math.min(0.56, (entity.dentDepth || 0) + addedDent);

      if (mode === 'traffic') {
        if (typeof entity.ensureDeformableMesh === 'function') {
          entity.ensureDeformableMesh();
        }
        // Knock damaged AI vehicles backward/away realistically on impact
        const knockSpd = Math.max(4.5, severity * (entity.bus ? 0.42 : 0.78));
        const backSign = localZ >= -0.3 ? -1 : 1;
        entity.speed = 0;
        entity.impactTime = Math.max(entity.impactTime || 0, 1.85);
        entity.vx = sinH * backSign * knockSpd + nx * knockSpd * 0.48;
        entity.vz = cosH * backSign * knockSpd + nz * knockSpd * 0.48;

        entity.wheelCamber = Math.max(
          -0.28,
          Math.min(0.28, (entity.wheelCamber || 0) + (Math.random() > 0.5 ? 1 : -1) * 0.06 * Math.min(2.0, severity * 0.14))
        );
        entity.wheelWobble = Math.min(0.14, (entity.wheelWobble || 0) + 0.02 * dmgRatio);

        // Authentic Vehicle Sub-Mesh Detachment (retaining exact lofted geometry, paintColor, carState & TSL shader)
        if (!isSoftTarget && severity >= 3.8) {
          const detachedPartName = this.vehicleDamageController.tryDetachImpactComponent(
            entity,
            localX,
            localY,
            localZ,
            x,
            y,
            z,
            nx,
            nz,
            severity
          );
          if (detachedPartName) {
            this.lastImpactLabel = `VEHICLE IMPACT — DETACHED ${detachedPartName.toUpperCase()}!`;
            this.lastImpactTimer = 2.6;
          }
        }
      }

      if (entity.carBodyMesh && entity._origPositions) {
        this._deformMeshVertices(entity, entity.carBodyMesh, x, y, z, severity, isSoftTarget ? 1.25 : 1.85, nx, nz);
      }

      if (!isSoftTarget || severity > 7.5) {
        this.spawnDebrisBurst(x, Math.max(0.55, y), z, nx, nz, severity * 0.8, {
          count: isSoftTarget ? 2 : Math.min(6, Math.max(2, Math.floor(severity * 0.4))),
          matA: this.mats.glassShard,
          matB: this.mats.glassShard,
          scaleMin: 0.14,
          scaleMax: 0.28,
          persistent: true,
        });
      }

      if (entity.damage > 20) {
        if (!entity.position && entity.x !== undefined) {
          entity.position = { x: entity.x, y: 0, z: entity.z };
        }
        if (this.smokeEmitters.size < 16 || this.smokeEmitters.has(entity)) {
          this.smokeEmitters.set(entity, { entity, mode, accum: 0 });
        }
      }
      return;
    }

    if (mode === 'cyclist') {
      entity.dentRoll = Math.max(-0.26, Math.min(0.26, (entity.dentRoll || 0) + (Math.random() - 0.5) * 0.12));
      entity.leanAngle = (entity.leanAngle || 0) + (Math.random() - 0.5) * 0.32;
      entity.wheelBuckle = Math.min(0.30, (entity.wheelBuckle || 0) + 0.04 * Math.min(2.0, severity * 0.2));
      if (entity.damage > 35) {
        entity.rearBuckle = Math.min(0.22, (entity.rearBuckle || 0) + 0.025 * dmgRatio);
      }
      if (!isSoftTarget && severity > 4) {
        this._spawnSparkStreaks(x, 0.45, z, nx, nz, severity, 6);
      }
      return;
    }

    if (mode === 'helicopter') {
      entity.dentRoll = Math.max(-0.28, Math.min(0.28, (entity.dentRoll || 0) + (Math.random() - 0.5) * 0.12));
      entity.dentPitch = Math.max(-0.20, Math.min(0.20, (entity.dentPitch || 0) + (Math.random() - 0.5) * 0.09));
      if (entity.heliBodyMesh && entity._origPositions) {
        this._deformMeshVertices(entity, entity.heliBodyMesh, x, y, z, severity, 2.1);
      }
      if (!isSoftTarget) {
        this._spawnSparkStreaks(x, y, z, nx, nz, severity, 10);
        this.spawnDebrisBurst(x, y, z, nx, nz, severity * 0.8, {
          count: 5,
          matA: this.mats.glassShard,
          matB: this.colors.cartSteel,
          scaleMin: 0.18,
          scaleMax: 0.40,
          persistent: true,
        });
      }
      if (entity.damage > 20) {
        this.smokeEmitters.set(entity, { entity, mode, accum: 0 });
      }
      return;
    }

    if (mode === 'person') {
      entity.stumbleTimer = Math.max(entity.stumbleTimer || 0, 0.65);
      if (entity.rig && !entity.isWrecked) {
        entity.rig.pelvisRoll = (Math.random() - 0.5) * 0.28;
        entity.rig.pelvisTilt = 0.14;
      }
    }
  }

  repairEntity(entity) {
    if (!entity) return;
    entity.damage = 0;
    entity.integrity = 100;
    entity.isWrecked = false;
    entity.wreckTimer = 0;
    entity.dentRoll = 0;
    entity.dentPitch = 0;
    entity.dentX = 0;
    entity.dentZ = 0;
    entity.dentDirX = 0;
    entity.dentDepth = 0;
    entity.wheelBuckle = 0;
    entity.rearBuckle = 0;
    entity.stumbleTimer = 0;
    if (entity.rig) {
      entity.rig.pelvisRoll = 0;
      entity.rig.pelvisTilt = 0;
    }

    const meshToRestore = entity.carBodyMesh || entity.heliBodyMesh;
    if (meshToRestore && meshToRestore.geometry && entity._origPositions) {
      const posAttr = meshToRestore.geometry.attributes.position;
      if (posAttr && posAttr.array.length === entity._origPositions.length) {
        posAttr.array.set(entity._origPositions);
        posAttr.needsUpdate = true;
        meshToRestore.geometry.computeVertexNormals();
      }
    }

    if (entity.body) {
      entity.body.scale.set(1, 1, 1);
      entity.body.rotation.set(0, 0, 0);
    }
    if (entity.wheels) {
      for (const w of entity.wheels) {
        w.camber = 0;
        w.toe = 0;
        w.wobble = 0;
        w._poppedVisual = false;
        w.rotation.z = 0;
        w.rotation.y = 0;
      }
    }
    if (entity.headLights) {
      for (const spot of entity.headLights) {
        spot._broken = false;
        spot._flicker = 0;
      }
    }
    if (entity.bike) entity.bike.rotation.z = 0;
    if (entity.frontWheel) {
      entity.frontWheel.rotation.y = 0;
      entity.frontWheel.rotation.z = 0;
    }
    if (entity.rearWheel) entity.rearWheel.rotation.z = 0;
    if (entity.handlebar) entity.handlebar.rotation.y = 0;
    if (entity.fork) entity.fork.rotation.z = 0;
    if (entity.saddle) entity.saddle.rotation.z = 0;
    if (entity.planeWings) entity.planeWings.rotation.set(0, 0, 0);
    if (entity.winglets) {
      for (const wl of entity.winglets) wl.rotation.set(0, 0, 0);
    }
    if (entity.tailRotorPivot) entity.tailRotorPivot.rotation.z = 0;

    this.smokeEmitters.delete(entity);
    this.lastImpactLabel = 'HEALTH RESTORED TO 100% — VEHICLE & GEAR REPAIRED';
    this.lastImpactTimer = 2.2;
  }

  update(dt, camera = null) {
    if (this.lastImpactTimer > 0) {
      this.lastImpactTimer = Math.max(0, this.lastImpactTimer - dt);
    }

    if (this._savePending) {
      this._saveTimer += dt;
      if (this._saveTimer >= 0.4) {
        this._saveTimer = 0;
        this._flushSave();
      }
    }

    // Update 3D Voronoi building wall shards & detached vehicle sub-mesh rigid bodies
    this.destructibleBuildingManager.update(dt);
    this.vehicleDamageController.update(dt);

    // 0. Update swaying/shuddering trees
    for (let i = this.swayingTrees.length - 1; i >= 0; i--) {
      const st = this.swayingTrees[i];
      if (!st.pivot || st.prop.destroyed) {
        this.swayingTrees.splice(i, 1);
        continue;
      }
      st.phase += dt * 11.5;
      st.amp *= Math.exp(-st.decay * dt);
      const tilt = Math.sin(st.phase) * st.amp;
      st.pivot.rotation.order = 'YXZ';
      st.pivot.rotation.z = -st.fx * tilt;
      st.pivot.rotation.x = st.fz * tilt;
      if (st.amp < 0.002) {
        st.pivot.rotation.set(0, 0, 0);
        this.swayingTrees.splice(i, 1);
      }
    }

    // 1. Update toppling poles, signals & real procedural trees
    for (let i = 0; i < this.fallingProps.length; i++) {
      const fp = this.fallingProps[i];
      if (fp.settled) continue;

      fp.group.position.x += fp.vx * dt;
      fp.group.position.z += fp.vz * dt;
      fp.vx *= Math.exp(-3.2 * dt);
      fp.vz *= Math.exp(-3.2 * dt);

      if (fp.group.position.y > 0.14 || fp.vy > 0) {
        fp.group.position.y += fp.vy * dt;
        fp.vy -= 14.0 * dt;
        if (fp.group.position.y < 0.14) {
          fp.group.position.y = 0.14;
          fp.vy = 0;
        }
      }

      const maxTilt = fp.restTilt || Math.PI * 0.475;
      const inertia = fp.burstKind === 'tree' ? 5.2 : 7.5;
      fp.tiltVel += Math.sin(Math.max(0.08, fp.tiltAngle)) * inertia * dt;
      fp.tiltAngle += fp.tiltVel * dt;

      if (fp.tiltAngle >= maxTilt) {
        fp.tiltAngle = maxTilt;
        if (!fp.groundBurstDone) {
          fp.groundBurstDone = true;
          const tipDist = fp.poleHeight || 4.2;
          const tipX = fp.group.position.x + fp.fx * tipDist;
          const tipZ = fp.group.position.z + fp.fz * tipDist;
          if (fp.burstKind === 'tree') {
            this._spawnFlutteringLeaves(tipX, 0.8, tipZ, fp.fx, fp.fz, 14, fp.leafMat || this.colors.leafGreen);
            this._spawnVolumetricPlume(tipX, 0.55, tipZ, 'dust', 1.05, 2.0);
          } else {
            this._spawnSparkStreaks(tipX, 0.25, tipZ, fp.fx, fp.fz, 7.5, 10);
          }
          if (this.reportCollision) {
            this.reportCollision(fp.burstKind === 'tree' ? 'tree' : 'lamp', tipX, 0.3, tipZ, 5.5);
          }
        }
        fp.tiltVel = -fp.tiltVel * 0.22;
        if (Math.abs(fp.tiltVel) < 0.22 && Math.hypot(fp.vx, fp.vz) < 0.1) {
          fp.tiltAngle = maxTilt;
          fp.tiltVel = 0;
          fp.vx = fp.vz = 0;
          fp.settled = true;
        }
      }

      fp.group.rotation.order = 'YXZ';
      fp.group.rotation.z = -fp.fx * fp.tiltAngle;
      fp.group.rotation.x = fp.fz * fp.tiltAngle;
    }

    // 2A. Update shuddering buildings (non-collapsed impact vibration)
    for (let i = this.shudderingBuildings.length - 1; i >= 0; i--) {
      const sb = this.shudderingBuildings[i];
      if (!sb.target || sb.target._collapsing || sb.target._collapsed) {
        if (sb.target) sb.target._shuddering = false;
        this.shudderingBuildings.splice(i, 1);
        continue;
      }
      sb.age += dt;
      if (sb.age >= sb.maxAge) {
        this._applyBuildingCollapseProgress(sb.target, 0, sb.nx, sb.nz, 0, 0);
        sb.target._shuddering = false;
        this.shudderingBuildings.splice(i, 1);
        continue;
      }
      const decay = 1 - sb.age / sb.maxAge;
      this._applyBuildingCollapseProgress(sb.target, 0, sb.nx, sb.nz, sb.age, sb.amp * decay);
    }

    // 2B. Update progressive structural building collapses (real vertex collapse into grounded rubble)
    for (let i = this.collapsingBuildings.length - 1; i >= 0; i--) {
      const cb = this.collapsingBuildings[i];
      cb.age += dt;
      cb.emitAccum += dt;
      const progress = Math.min(1, cb.age / cb.duration);
      this._applyBuildingCollapseProgress(cb.target, progress, cb.nx, cb.nz, cb.age, 0);

      if (cb.emitAccum >= 0.11 && progress < 0.96) {
        cb.emitAccum = 0;
        const curRoofY = Math.max(1.2, cb.height * (1 - progress * progress));
        for (let pIdx = 0; pIdx < 2; pIdx++) {
          const rx = cb.minX + Math.random() * (cb.maxX - cb.minX);
          const rz = cb.minZ + Math.random() * (cb.maxZ - cb.minZ);
          const plumeY = pIdx === 0 ? 1.2 + Math.random() * 2.4 : Math.min(16, curRoofY * 0.4 + 1.0);
          this._spawnVolumetricPlume(rx, plumeY, rz, 'dust', 1.65 + Math.random() * 0.85, 2.8);
        }

        for (let k = 0; k < 4; k++) {
          const bx = cb.minX + Math.random() * (cb.maxX - cb.minX);
          const bz = cb.minZ + Math.random() * (cb.maxZ - cb.minZ);
          const outX = bx >= cb.cx ? 1 : -1;
          const outZ = bz >= cb.cz ? 1 : -1;
          const col = k === 0 ? this.colors.brick : k === 1 ? this.colors.limestone : k === 2 ? this.colors.concrete : this.colors.steelGirder;
          this._spawnSolidDebrisItem(
            bx, Math.min(14, curRoofY * 0.45 + 1.2), bz,
            outX * (2.5 + Math.random() * 5.0), 1.8 + Math.random() * 3.5, outZ * (2.5 + Math.random() * 5.0),
            0.65 + Math.random() * 0.85, 0.35 + Math.random() * 0.40, 0.55 + Math.random() * 0.75,
            col, 0.24 + Math.random() * 0.22, true
          );
        }
        if (this.reportCollision && Math.random() < 0.45) {
          this.reportCollision('building', cb.cx, 2.0, cb.cz, 6.5);
        }
      }

      if (progress >= 1) {
        cb.target._collapsing = false;
        cb.target._collapsed = true;
        this.collapsingBuildings.splice(i, 1);
      }
    }

    // 3A. Update instanced Solid Debris Pool
    let anySolidMoved = Boolean(this._dirtySolidDebris);
    this._dirtySolidDebris = false;
    for (let i = 0; i < MAX_SOLID_DEBRIS; i++) {
      const d = this.solidDebrisPool[i];
      if (!d.active || d.settled) continue;
      anySolidMoved = true;
      d.age += dt;
      if (!d.persistent && d.age >= d.maxAge) {
        d.active = false;
        this.solidDebrisInst.setMatrixAt(i, this._zeroMatrix);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.vy -= d.gravity * dt;
      d.rotX += d.rx * dt;
      d.rotY += d.ry * dt;
      d.rotZ += d.rz * dt;

      if (d.y < d.restY) {
        d.y = d.restY;
        d.vy = Math.abs(d.vy) * 0.32;
        d.vx *= 0.66;
        d.vz *= 0.66;
        d.rx *= 0.6;
        d.ry *= 0.6;
        d.rz *= 0.6;
        if (d.vy < 0.45 && Math.hypot(d.vx, d.vz) < 0.24) {
          d.vy = d.vx = d.vz = d.rx = d.ry = d.rz = 0;
          d.settled = true;
        }
      }
      this._dummy.position.set(d.x, d.y, d.z);
      this._dummy.rotation.set(d.rotX, d.rotY, d.rotZ);
      this._dummy.scale.set(d.sx, d.sy, d.sz);
      this._dummy.updateMatrix();
      this.solidDebrisInst.setMatrixAt(i, this._dummy.matrix);
    }
    if (anySolidMoved) {
      flagInstRange(this.solidDebrisInst.instanceMatrix, MAX_SOLID_DEBRIS);
    }

    // 3B. Update instanced Glass Shards Pool
    let anyGlassMoved = Boolean(this._dirtyGlassShards);
    this._dirtyGlassShards = false;
    for (let i = 0; i < MAX_GLASS_SHARDS; i++) {
      const g = this.glassShardPool[i];
      if (!g.active || g.settled) continue;
      anyGlassMoved = true;
      g.age += dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      g.vy -= g.gravity * dt;
      g.rotX += g.rx * dt;
      g.rotY += g.ry * dt;
      g.rotZ += g.rz * dt;
      if (g.y < g.restY) {
        g.y = g.restY;
        g.vy = Math.abs(g.vy) * 0.28;
        g.vx *= 0.62;
        g.vz *= 0.62;
        if (g.vy < 0.4 && Math.hypot(g.vx, g.vz) < 0.2) {
          g.vy = g.vx = g.vz = 0;
          g.rotX = 0;
          g.rotZ = 0;
          g.settled = true;
        }
      }
      this._dummy.position.set(g.x, g.y, g.z);
      this._dummy.rotation.set(g.rotX, g.rotY, g.rotZ);
      this._dummy.scale.set(g.sx, g.sy, g.sz);
      this._dummy.updateMatrix();
      this.glassShardInst.setMatrixAt(i, this._dummy.matrix);
    }
    if (anyGlassMoved) {
      flagInstRange(this.glassShardInst.instanceMatrix, MAX_GLASS_SHARDS);
    }

    // 3C. Update instanced Fluttering Leaves Pool
    let anyLeavesMoved = Boolean(this._dirtyLeaves);
    this._dirtyLeaves = false;
    for (let i = 0; i < MAX_LEAVES; i++) {
      const lf = this.leafPool[i];
      if (!lf.active || lf.settled) continue;
      anyLeavesMoved = true;
      lf.age += dt;
      lf.vx += Math.sin(lf.age * 7.5 + i) * 2.4 * dt;
      lf.vz += Math.cos(lf.age * 6.8 + i) * 2.4 * dt;
      lf.vx *= Math.exp(-1.8 * dt);
      lf.vz *= Math.exp(-1.8 * dt);
      lf.x += lf.vx * dt;
      lf.y += lf.vy * dt;
      lf.z += lf.vz * dt;
      lf.vy -= 3.6 * dt;
      lf.rotX += lf.rx * dt;
      lf.rotY += lf.ry * dt;
      lf.rotZ += lf.rz * dt;
      if (lf.y < 0.03) {
        lf.y = 0.03;
        lf.vx = lf.vy = lf.vz = 0;
        lf.rotX = -Math.PI * 0.5;
        lf.rotZ = 0;
        lf.settled = true;
      }
      this._dummy.position.set(lf.x, lf.y, lf.z);
      this._dummy.rotation.set(lf.rotX, lf.rotY, lf.rotZ);
      this._dummy.scale.setScalar(lf.scale);
      this._dummy.updateMatrix();
      this.leafInst.setMatrixAt(i, this._dummy.matrix);
    }
    if (anyLeavesMoved) {
      flagInstRange(this.leafInst.instanceMatrix, MAX_LEAVES);
    }

    // 3D. Update instanced Sparks & Water Drops Pool
    let anySparks = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const sp = this.sparkPool[i];
      if (!sp.active) continue;
      anySparks = true;
      sp.age += dt;
      if (sp.age >= sp.maxAge) {
        sp.active = false;
        this.sparkInst.setMatrixAt(i, this._zeroMatrix);
        continue;
      }
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      sp.z += sp.vz * dt;
      sp.vy -= sp.gravity * dt;
      if (sp.y < 0.04) {
        sp.y = 0.04;
        sp.vy = Math.abs(sp.vy) * 0.4;
        sp.vx *= 0.72;
        sp.vz *= 0.72;
      }
      const spdXZ = Math.hypot(sp.vx, sp.vz) || 0.001;
      const lifeLeft = Math.max(0.05, 1 - sp.age / sp.maxAge);
      this._dummy.position.set(sp.x, sp.y, sp.z);
      this._dummy.rotation.set(-Math.atan2(sp.vy, spdXZ), Math.atan2(sp.vx, sp.vz), 0, 'YXZ');
      this._dummy.scale.set(sp.sx * lifeLeft, sp.sy * lifeLeft, sp.sz * lifeLeft);
      this._dummy.updateMatrix();
      this.sparkInst.setMatrixAt(i, this._dummy.matrix);
    }
    if (anySparks) {
      flagInstRange(this.sparkInst.instanceMatrix, MAX_SPARKS);
    }

    // 4. Sync 3D physical damage overlays on struck AI traffic vehicles
    for (const [v, overlay] of this.damagedTrafficOverlays.entries()) {
      if (!v || !v.edge || (v.damage || 0) <= 0) {
        overlay.visible = false;
        continue;
      }
      overlay.visible = true;
      overlay.position.set(v.x, 0, v.z);
      overlay.rotation.order = 'YXZ';
      overlay.rotation.set(v.pitch || 0, (v.yaw || 0) + (v.yawOffset || 0), v.roll || 0);
    }

    // 5. Update instanced camera-facing volumetric smoke/dust & fire plumes
    const camQuat = camera ? camera.quaternion : null;
    let anySmoke = false;
    for (let i = 0; i < MAX_SMOKE_PLUMES; i++) {
      const p = this.smokePlumePool[i];
      if (!p.active) continue;
      anySmoke = true;
      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
        this.smokePlumeInst.setMatrixAt(i, this._zeroMatrix);
        continue;
      }
      const lifeRatio = p.age / p.maxAge;
      const fadeEnvelope = Math.sin(lifeRatio * Math.PI);
      const swirl = Math.sin(p.age * 4.2 + p.turbulencePhase) * 0.95;
      p.x += (p.vx + swirl) * dt;
      p.y += p.vy * dt;
      p.z += (p.vz + Math.cos(p.age * 3.8 + p.turbulencePhase) * 0.85) * dt;
      p.vy = Math.max(0.75, p.vy * Math.exp(-0.35 * dt));
      p.scale += p.expandRate * dt;
      p.roll += p.rollVel * dt;

      this._dummy.position.set(p.x, p.y, p.z);
      if (camQuat) {
        this._dummy.quaternion.copy(camQuat);
        this._dummy.rotateZ(p.roll);
      } else {
        this._dummy.rotation.set(0, 0, p.roll);
      }
      const effScale = p.scale * Math.max(0.15, fadeEnvelope);
      this._dummy.scale.set(effScale, effScale * p.aspect, 1);
      this._dummy.updateMatrix();
      this.smokePlumeInst.setMatrixAt(i, this._dummy.matrix);
    }
    if (anySmoke) {
      flagInstRange(this.smokePlumeInst.instanceMatrix, MAX_SMOKE_PLUMES);
    }

    let anyFire = false;
    for (let i = 0; i < MAX_FIRE_PLUMES; i++) {
      const p = this.firePlumePool[i];
      if (!p.active) continue;
      anyFire = true;
      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
        this.firePlumeInst.setMatrixAt(i, this._zeroMatrix);
        continue;
      }
      const lifeRatio = p.age / p.maxAge;
      const flicker = 0.88 + 0.24 * Math.sin(p.age * 28.0 + p.turbulencePhase);
      p.x += (p.vx + Math.sin(p.age * 5.0 + p.turbulencePhase) * 1.2) * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.scale += p.expandRate * dt;
      p.roll += p.rollVel * dt;

      this._dummy.position.set(p.x, p.y, p.z);
      if (camQuat) {
        this._dummy.quaternion.copy(camQuat);
        this._dummy.rotateZ(p.roll);
      } else {
        this._dummy.rotation.set(0, 0, p.roll);
      }
      const taper = (1.0 - lifeRatio * 0.65) * flicker;
      this._dummy.scale.set(p.scale * taper, p.scale * p.aspect * taper, 1);
      this._dummy.updateMatrix();
      this.firePlumeInst.setMatrixAt(i, this._dummy.matrix);
    }
    if (anyFire) {
      flagInstRange(this.firePlumeInst.instanceMatrix, MAX_FIRE_PLUMES);
    }

    // 6. Update active sheared fire-hydrant water geysers (using instanced spark/water pool)
    for (let i = this.geysers.length - 1; i >= 0; i--) {
      const g = this.geysers[i];
      g.age += dt;
      if (g.age >= g.maxAge) {
        this.geysers.splice(i, 1);
        continue;
      }
      g.emitAccum += dt;
      while (g.emitAccum >= 0.06) {
        g.emitAccum -= 0.06;
        const slot = this.sparkCursor;
        this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
        const sp = this.sparkPool[slot];
        sp.active = true;
        sp.x = g.x + (Math.random() - 0.5) * 0.16;
        sp.y = 0.35;
        sp.z = g.z + (Math.random() - 0.5) * 0.16;
        sp.vx = (Math.random() - 0.5) * 1.8;
        sp.vy = 9.0 + Math.random() * 3.5;
        sp.vz = (Math.random() - 0.5) * 1.8;
        sp.sx = 1.6;
        sp.sy = 1.6;
        sp.sz = 1.2;
        sp.gravity = 15.0;
        sp.age = 0;
        sp.maxAge = 1.1;
        this.sparkInst.setColorAt(slot, this.colors.waterDrop);
        if (this.sparkInst.instanceColor) this.sparkInst.instanceColor.needsUpdate = true;
      }
      g.mistAccum = (g.mistAccum || 0) + dt;
      if (g.mistAccum >= 0.22) {
        g.mistAccum = 0;
        this._spawnVolumetricPlume(g.x, 1.2 + Math.random() * 1.2, g.z, 'dust', 0.65, 1.3);
      }
    }

    // 7. Update damaged vehicle/aircraft volumetric black engine smoke & fire emitters
    for (const [ent, em] of this.smokeEmitters.entries()) {
      if (!ent || (ent.damage || 0) <= 18) {
        this.smokeEmitters.delete(ent);
        continue;
      }
      const ex = ent.position ? ent.position.x : ent.x;
      const ez = ent.position ? ent.position.z : ent.z;
      const ey = ent.position ? ent.position.y || 0 : 0;
      if (ex === undefined || ez === undefined) continue;

      const dmg = ent.damage || 0;
      em.accum += dt;
      const interval = dmg > 70 ? 0.08 : dmg > 45 ? 0.12 : 0.18;
      if (em.accum >= interval) {
        em.accum = 0;
        const heading = ent.heading ?? ((ent.yaw || 0) + (ent.yawOffset || 0));
        const sinH = Math.sin(heading);
        const cosH = Math.cos(heading);
        const fwdOffset = em.mode === 'helicopter' ? -0.65 : 1.52;
        const baseH = em.mode === 'helicopter' ? 2.05 : 0.72;
        const srcX = ex + sinH * fwdOffset + (Math.random() - 0.5) * 0.4;
        const srcY = ey + baseH;
        const srcZ = ez + cosH * fwdOffset + (Math.random() - 0.5) * 0.4;

        this._spawnVolumetricPlume(srcX, srcY, srcZ, 'blackSmoke', 0.55 + Math.min(0.55, (dmg - 18) * 0.007), 2.0);
        if (dmg > 45 && Math.random() < (dmg > 70 ? 0.65 : 0.35)) {
          this._spawnVolumetricPlume(srcX, srcY - 0.05, srcZ, 'fire', 0.48 + Math.min(0.45, (dmg - 45) * 0.008), 0.5);
        }
      }
    }
  }
}
