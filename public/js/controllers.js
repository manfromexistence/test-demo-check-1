import * as THREE from 'three/webgpu';
import {
  ISLAND_BOUNDS,
  CENTRAL_PARK_BOUNDS,
  getIslandBoundsAtZ,
  isTypingInField,
  blockAt,
  streetZ
} from './city-config.js';
import { cityUniforms, createCarPaintMaterial, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  carTipZ,
  createCarWheelMaterial,
  createLoftedCarMaterial
} from './cars.js';
import {
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './helicopter.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { bryantParkLawn } from './landmarks.js';
import { polygonContact } from './building-collision.js';

// Player models, animation and movement for walking, driving, cycling and flying.

// Spawn on 5th Ave at 37th St, facing south down the avenue toward the Empire State Building (34th St)
const SPAWN_Z = streetZ(37);
const groundCollider = { type: 'ground' };

export const MPH_TO_MS = 0.44704;
export const MS_TO_MPH = 2.23694;
export const LIGHT_SPEED_MPH = 670616629; // ~c
export const LIGHT_SPEED_SIM_MS = 15000.0; // Relativistic warp speed in physics simulation units

export const SPEED_PRESETS = [
  { id: '40', label: '40 MPH', mph: 40, ms: 40 * MPH_TO_MS, desc: 'City Default (40 MPH)' },
  { id: '100', label: '100 MPH', mph: 100, ms: 100 * MPH_TO_MS, desc: 'Highway Express (100 MPH)' },
  { id: '300', label: '300 MPH', mph: 300, ms: 300 * MPH_TO_MS, desc: 'Hypercar Velocity (300 MPH)' },
  { id: '500', label: '500 MPH', mph: 500, ms: 500 * MPH_TO_MS, desc: 'Supersonic (500 MPH)' },
  { id: '1000', label: '1,000 MPH', mph: 1000, ms: 1000 * MPH_TO_MS, desc: 'Mach 1.3 Supersonic (1,000 MPH)' },
  { id: '10000', label: '10,000 MPH', mph: 10000, ms: 10000 * MPH_TO_MS, desc: 'Hypersonic (10,000 MPH)' },
  { id: 'light', label: '⚡ Light Speed', mph: LIGHT_SPEED_MPH, ms: LIGHT_SPEED_SIM_MS, desc: 'Max Light Speed (c)' }
];

const DEFAULT_SPEED_CAP = 40 * MPH_TO_MS; // Default 40 MPH = 17.8816 m/s

const CAR_DRIVE = {
  minSpeed: 0,
  speed: DEFAULT_SPEED_CAP,
  reverseSpeed: 12.0,
  acceleration: 32.0,
  rolling: 0.1,
  drag: 0.00008,
  coast: 14.0,
  brake: 38.0,
  wheelbase: 2.76,
  grip: 42.0,
  cornering: 55.0
};
const BICYCLE_DRIVE = {
  minSpeed: 0,
  speed: DEFAULT_SPEED_CAP,
  reverseSpeed: 8.0,
  acceleration: 24.0,
  rolling: 0.08,
  drag: 0.0001,
  coast: 12.0,
  brake: 32.0
};

function driveSpeed(speed, throttle, dt, drive) {
  if (speed * throttle < 0 && Math.abs(speed) < 0.2) speed = 0;
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const minForward = drive.minSpeed || 0;
  const maxForward = drive.speed;
  const limit = throttle < 0 ? drive.reverseSpeed : Math.max(minForward, maxForward * Math.abs(throttle));
  const acceleration = drive.acceleration;

  const newSpeed = magnitude < minForward && throttle > 0
    ? Math.min(limit, Math.max(minForward, magnitude + acceleration * dt * 3.5))
    : Math.min(limit, coasting + Math.abs(throttle) * acceleration * dt);
  return Math.sign(throttle) * newSpeed;
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');

function collisionBody(mode, radius, heading, margin = 0) {
  const car = mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = 0.86 + margin, hz = 2.18 + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

// Movement and teleports share exact footprint checks after rejecting distant bounds.
// Walking/cycling/flying use circles; cars use oriented rectangles.
function buildingContact(c, x, y, z, body, contact) {
  if (c.destroyed || c._collapsing || c.buildingRecord?.destroyed || c.buildingRecord?._collapsing) return false;
  if (y + body.bottom >= c.maxY || y + body.top <= (c.minY ?? 0)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  if (c._breachOpenings && y + body.bottom < 4.2) {
    const margin = body.car ? 0.72 : (body.radius || 0.45) * 0.75;
    for (let i = 0; i < c._breachOpenings.length; i++) {
      const op = c._breachOpenings[i];
      const dx = x - op.x;
      const dz = z - op.z;
      const into = -(dx * op.nx + dz * op.nz);
      const along = Math.abs(-dx * op.nz + dz * op.nx);
      if (along <= op.halfWidth - margin * 0.5 && into >= -2.2 && into <= (op.depth || 6.0)) {
        return false;
      }
    }
  }
  if (c.polygon) return polygonContact(c.polygon, x, z, body, contact);
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.car) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

function createTaxiDoorDecalTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffbe14';
  ctx.fillRect(0, 0, 256, 128);
  // Black T&LC circle emblem
  ctx.fillStyle = '#111317';
  ctx.beginPath();
  ctx.arc(58, 64, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffbe14';
  ctx.font = '900 32px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', 58, 66);
  // NYC TAXI typography & Fare Rate
  ctx.fillStyle = '#111317';
  ctx.textAlign = 'left';
  ctx.font = '900 26px Inter, Arial, sans-serif';
  ctx.fillText('NYC TAXI', 112, 42);
  ctx.font = '700 15px JetBrains Mono, monospace';
  ctx.fillText('7Y48 · MEDALLION', 112, 68);
  ctx.font = '600 13px Inter, Arial, sans-serif';
  ctx.fillText('$3.00 INITIAL FARE', 112, 90);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The decals are mostly seen at grazing angles from the chase camera
  tex.anisotropy = 16;
  return tex;
}

function createNYLicensePlateTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffb81c';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#0d2244';
  ctx.fillRect(6, 6, 244, 24);
  ctx.fillStyle = '#ffb81c';
  ctx.font = '800 15px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NEW YORK', 128, 23);
  ctx.fillStyle = '#0d2244';
  ctx.font = '900 48px JetBrains Mono, monospace';
  ctx.fillText('7Y48A', 128, 82);
  ctx.font = '700 13px Inter, Arial, sans-serif';
  ctx.fillText('NYC T&LC', 128, 114);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = []) {
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.speedPresetIndex = 0; // Default: 40 MPH
    this.currentSpeedMph = 40;
    this.currentSpeedCap = DEFAULT_SPEED_CAP;
    this.isLightSpeed = false;
    this.onSpeedChange = null;

    this.bindKeyboard();
  }

  setSpeedMph(mph, isLightSpeed = false) {
    this.isLightSpeed = isLightSpeed || mph >= LIGHT_SPEED_MPH;
    this.currentSpeedMph = this.isLightSpeed ? LIGHT_SPEED_MPH : Math.max(10, Math.min(LIGHT_SPEED_MPH, mph));
    this.currentSpeedCap = this.isLightSpeed ? LIGHT_SPEED_SIM_MS : this.currentSpeedMph * MPH_TO_MS;

    const spd = this.currentSpeedCap;
    CAR_DRIVE.minSpeed = 0;
    CAR_DRIVE.speed = spd;
    CAR_DRIVE.acceleration = Math.max(32.0, Math.min(3200.0, spd * 0.95));
    CAR_DRIVE.brake = Math.max(38.0, Math.min(4200.0, spd * 1.35));
    CAR_DRIVE.reverseSpeed = Math.min(110.0, Math.max(12.0, spd * 0.35));
    CAR_DRIVE.grip = Math.max(42.0, Math.min(800.0, spd * 0.65));
    CAR_DRIVE.cornering = Math.max(55.0, Math.min(800.0, spd * 0.70));

    BICYCLE_DRIVE.minSpeed = 0;
    BICYCLE_DRIVE.speed = spd;
    BICYCLE_DRIVE.acceleration = Math.max(24.0, Math.min(3200.0, spd * 0.90));
    BICYCLE_DRIVE.brake = Math.max(32.0, Math.min(4200.0, spd * 1.35));

    if (typeof this.onSpeedChange === 'function') {
      this.onSpeedChange(this.currentSpeedMph, this.isLightSpeed, this.speedPresetIndex);
    }
  }

  setSpeedPreset(identifier) {
    let preset = null;
    let idx = -1;
    if (typeof identifier === 'number') {
      idx = Math.max(0, Math.min(SPEED_PRESETS.length - 1, Math.round(identifier)));
      preset = SPEED_PRESETS[idx];
    } else {
      idx = SPEED_PRESETS.findIndex((p) => p.id === String(identifier));
      preset = idx >= 0 ? SPEED_PRESETS[idx] : SPEED_PRESETS[0];
      if (idx < 0) idx = 0;
    }
    if (preset) {
      this.speedPresetIndex = idx;
      this.setSpeedMph(preset.mph, preset.id === 'light');
    }
  }

  stepSpeedPreset(delta) {
    const nextIdx = Math.max(0, Math.min(SPEED_PRESETS.length - 1, this.speedPresetIndex + delta));
    this.setSpeedPreset(nextIdx);
  }

  boostActiveEntity() {
    const ent = this.getActiveEntity();
    if (!ent) return;
    const target = this.currentSpeedCap;
    ent.speed = target;
    ent.vx = 0;
    ent.vz = 0;
    if (this.activeMode === 'helicopter') {
      ent.verticalSpeed = 0;
    }
    if (this.destructionSystem && typeof this.destructionSystem.triggerWarpShockwave === 'function') {
      this.destructionSystem.triggerWarpShockwave(ent.position.x, ent.position.y, ent.position.z);
    }
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.activeMode = mode;
    const active = this.entities[mode];
    if (active.mesh) active.mesh.visible = true;
    if (active.helmet) active.helmet.visible = true;
    if (mode === 'person') active._charHidden = false;
    else if (mode === 'cyclist') {
      active._riderHidden = false;
      active._posedX = NaN;
    }
    const car = this.entities.car;
    if (mode !== 'car' && car?.carState) car.carState.value.x = car.carState.value.w = 0;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(0.25, Math.min(380, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude);
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode);
    }
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent._charHidden = false;
      if (ent.mesh) ent.mesh.visible = true;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.prevX = ent.position.x;
      ent.prevZ = ent.position.z;
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = ent.carState.value.w = 0;
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
      ent._riderHidden = false;
      ent._posedX = NaN;
      if (ent.helmet) ent.helmet.visible = true;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const shape = collisionBody(this.activeMode, radius, heading, 0.1);
    const reach = Math.max(shape.extX, shape.extZ);
    const margin = heli ? 6000 : 0;
    const entity = this.getActiveEntity();
    // Conservative body cylinders, including the taxi's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2] };
    const others = Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + margin, pz));
      px = Math.max(ISLAND_BOUNDS.minX - margin, Math.min(ISLAND_BOUNDS.maxX + margin, px));
      if (!heli && getIslandBoundsAtZ) {
        const shore = getIslandBoundsAtZ(pz);
        const west = shore.westX + 8, east = shore.eastX - 8;
        if (west > east) return null;
        px = Math.max(west, Math.min(east, px));
      }
      return { x: px, z: pz };
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(ISLAND_BOUNDS.minX, Math.min(ISLAND_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(ISLAND_BOUNDS.minZ + 30, Math.min(ISLAND_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED NYC PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'Pedestrian',
      isPlayer: true,
      damage: 0,
      integrity: 100,
      mesh: root,
      crowd,
      rig,
      position: new THREE.Vector3(-11.6, ISLAND_BOUNDS.sidewalkHeight, SPAWN_Z + 12),
      prevX: -11.6,
      prevZ: SPAWN_Z + 12,
      heading: 0,
      speed: 0,
      vx: 0,
      vz: 0,
      verticalVel: 0,
      stumbleTimer: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED SCULPTED NYC MEDALLION YELLOW TAXI SEDAN)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerTaxiCar';

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    const spec = BODY_SPECS.taxi;
    const taxiLoftMat = createLoftedCarMaterial(spec, 0xffbe14);

    // 1. 3D Lofted Taxi Body + Curved Windscreens + Crowned Roof + Side Mirrors + Roof Sign
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, taxiLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 2. Authentic NYC Taxi Side Door T&LC Medallion & Fare Tariff Emblem Decals, hugging the curved front doors
    const doorDecalTex = createTaxiDoorDecalTexture();
    const doorDecalMat = new THREE.MeshStandardNodeMaterial({
      map: doorDecalTex,
      roughness: 0.24,
      metalness: 0.34,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const doorMid = (spec.doors[0] + spec.doors[1]) / 2;
    for (const side of [-1, 1]) {
      const decal = new THREE.Mesh(buildCarSidePatch(spec, side, doorMid - 0.36, doorMid + 0.36, 0.53, 0.81, 0.003), doorDecalMat);
      chassisPivot.add(decal);
    }

    // 3. High-Detail NY Empire Gold License Plates on the raked bumpers, tilted to follow the fascias
    const nyPlateTex = createNYLicensePlateTexture();
    const nyPlateMat = new THREE.MeshStandardNodeMaterial({ map: nyPlateTex, roughness: 0.28 });
    for (const front of [true, false]) {
      const y = spec.plates[front ? 0 : 1];
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.008), nyPlateMat);
      plate.position.set(0, y, carTipZ(spec, y, front) + (front ? 0.003 : -0.003));
      plate.rotation.x = Math.atan((carTipZ(spec, y + 0.07, front) - carTipZ(spec, y - 0.07, front)) / 0.14);
      chassisPivot.add(plate);
    }

    // 3b. Brake, reverse & turn lights are lit by the taxi material from its carState uniform (see updateCar)
    const carState = taxiLoftMat.userData.carState;

    // 4. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);
    const taxiWheelMat = createCarWheelMaterial({ wheelRadius: spec.wheelRadius });

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, taxiWheelMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({
        steerPivot,
        tire,
        isFront: wc.isFront,
        side: wc.side,
        z: wc.z,
        camber: 0,
        toe: 0,
        wobble: 0,
        detached: false,
        rotation: steerPivot.rotation
      });
    }

    // 5. Ground contact shadow and paired headlight spotlights
    const carShadowGeo = new THREE.PlaneGeometry(2.22, 5.05);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      spot._side = side;
      spot._broken = false;
      spot._flicker = 0;
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    this.scene.add(root);

    const origPosAttr = carBodyGeo.attributes.position;
    const origPositions = origPosAttr ? new Float32Array(origPosAttr.array) : null;

    return {
      type: 'car',
      label: 'NYC Yellow Taxi',
      isPlayer: true,
      damage: 0,
      integrity: 100,
      mesh: root,
      body: chassisPivot,
      chassisPivot,
      carBodyMesh,
      _origPositions: origPositions,
      carState,
      headLights,
      wheels,
      position: new THREE.Vector3(3.6, 0.0, SPAWN_Z + 12),
      prevX: 3.6,
      prevZ: SPAWN_Z + 12,
      heading: 0,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: 'NYC Bike Lane Cyclist',
      isPlayer: true,
      damage: 0,
      integrity: 100,
      mesh: root,
      bike: leanPivot,
      leanPivot,
      frontWheel,
      rearWheel,
      fork,
      handlebar,
      saddle,
      topTube,
      downTube,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      wheelBuckle: 0,
      rearBuckle: 0,
      barTwist: 0,
      forkBend: 0,
      position: new THREE.Vector3(5.2, 0.0, SPAWN_Z - 8),
      prevX: 5.2,
      prevZ: SPAWN_Z - 8,
      heading: 0,
      speed: 0,
      vx: 0,
      vz: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER / PLANE (3D LOFTED MANHATTAN SIGHTSEEING AIRCRAFT)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 1b. Fixed-Wing Aeroplane Wings for hybrid Plane/Helicopter flight
    const planeWings = new THREE.Group();
    const wingMat = new THREE.MeshStandardNodeMaterial({ color: 0xe2e8f0, roughness: 0.28, metalness: 0.65 });
    const wingTipMat = new THREE.MeshStandardNodeMaterial({ color: 0xef4444, roughness: 0.35, metalness: 0.4 });
    const mainWing = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.11, 1.25), wingMat);
    mainWing.position.set(0, 1.65, -0.25);
    mainWing.castShadow = true;
    planeWings.add(mainWing);
    const winglets = [];
    for (const side of [-1, 1]) {
      const winglet = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.9), wingTipMat);
      winglet.position.set(side * 4.3, 1.88, -0.35);
      winglet._side = side;
      planeWings.add(winglet);
      winglets.push(winglet);
    }
    tiltPivot.add(planeWings);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    const origHeliPos = heliBodyGeo.attributes.position
      ? new Float32Array(heliBodyGeo.attributes.position.array)
      : null;

    return {
      type: 'helicopter',
      label: 'Sightseeing Plane / Heli',
      isPlayer: true,
      damage: 0,
      integrity: 100,
      mesh: root,
      body: heliBodyMesh,
      heliBodyMesh,
      _origPositions: origHeliPos,
      planeWings,
      mainWing,
      winglets,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(-110, 96, SPAWN_Z - 60),
      prevX: -110,
      prevZ: SPAWN_Z - 60,
      heading: 0.62,
      speed: 0,
      vx: 0,
      vz: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // On a raised curb island (city-config.js BLOCKS: the real blocks, malls & plazas), not in a park
  isPointOnSidewalk(x, z) {
    const b = blockAt(x, z);
    return !!b && !(b.park > 0.6 && !b.median);
  }

  getGroundHeight(x, z, mode = 'person') {
    // Inside Central Park (5th Ave to Central Park West, 59th St to 110th St)
    const cp = CENTRAL_PARK_BOUNDS;
    if (x > cp.minX && x < cp.maxX && z > cp.minZ && z < cp.maxZ) {
      return 1.24;
    }
    // Inside Bryant Park's Great Lawn (west of the New York Public Library, 40th-42nd St)
    const lawn = bryantParkLawn;
    if (lawn && x > lawn.minX && x < lawn.maxX && z > lawn.minZ && z < lawn.maxZ) {
      return lawn.top;
    }
    if (mode === 'person') {
      return this.isPointOnSidewalk(x, z) ? ISLAND_BOUNDS.sidewalkHeight : 0.0;
    }
    return 0.0;
  }

  // Static colliders within `r` of (x, z), kept in their original order and indexed once into 48 m cells.
  nearColliders(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp || c.destroyed) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  resolveHelicopterRoofCollision(h, step) {
    if (!h || !h.position) return;
    const x = h.position.x;
    const y = h.position.y;
    const z = h.position.z;
    const prevY = h._prevY ?? y;
    const near = this.nearColliders(x, z, 8.0);

    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (c.destroyed || c._collapsing || c.buildingRecord?.destroyed || c.buildingRecord?._collapsing) continue;
      const roofY = c.maxY;
      if (!roofY || roofY <= 1.2) continue;

      let inside = false;
      if (c.polygon) {
        const testBody = { car: false, radius: 2.2, hx: 2.2, hz: 2.2, extX: 2.2, extZ: 2.2, sin: 0, cos: 1 };
        inside = polygonContact(c.polygon, x, z, testBody);
      } else if (c.obb) {
        const o = c.obb;
        const dx = x - o.cx;
        const dz = z - o.cz;
        const lx = dx * o.cs - dz * o.sn;
        const lz = dx * o.sn + dz * o.cs;
        inside = Math.abs(lx) <= o.hx + 1.8 && Math.abs(lz) <= o.hz + 1.8;
      } else {
        inside = x >= c.minX - 1.8 && x <= c.maxX + 1.8 && z >= c.minZ - 1.8 && z <= c.maxZ + 1.8;
      }

      if (!inside) continue;

      const isRoofHit =
        (y <= roofY + 0.35 && y >= roofY - 5.5) ||
        (prevY >= roofY - 0.5 && y <= roofY + 0.35) ||
        (y <= roofY + 1.5 && (h.verticalSpeed || 0) < -1.5);

      if (isRoofHit) {
        const sin = Math.sin(h.heading || 0);
        const cos = Math.cos(h.heading || 0);
        const horizVx = sin * (h.speed || 0) + (h.vx || 0);
        const horizVz = cos * (h.speed || 0) + (h.vz || 0);
        const vertV = Math.abs(h.verticalSpeed || 0);
        const impactSpeed = Math.hypot(horizVx, vertV, horizVz);

        if (impactSpeed > 0.5 && this._collisionListener) {
          this.reportCollision(h, c, 'building', x, roofY, z, 0, 1, 0, impactSpeed);
        }

        const nowMs = performance.now();
        if (this.destructionSystem && impactSpeed > 0.65 && nowMs - (h._lastRoofHitMs || 0) > 120) {
          h._lastRoofHitMs = nowMs;
          this.destructionSystem.onBuildingCollision(
            h,
            'helicopter',
            x,
            roofY,
            z,
            0,
            0,
            impactSpeed,
            true,
            c
          );
        }

        const target = c.buildingRecord || c;
        const isCollapsed = target && (target.destroyed || target._collapsing || target._collapsed);

        if (isCollapsed) {
          h.speed *= 0.88;
          h.verticalSpeed = (h.verticalSpeed || 0) * 0.82;
          h.vx = (h.vx || 0) * 0.88;
          h.vz = (h.vz || 0) * 0.88;
        } else {
          h.position.y = Math.max(h.position.y, roofY + 0.35);
          if (h.verticalSpeed < 0) {
            if (impactSpeed > 2.8) {
              h.verticalSpeed = Math.abs(h.verticalSpeed) * 0.36;
              h.speed *= 0.70;
              h.vx = (h.vx || 0) * 0.70;
              h.vz = (h.vz || 0) * 0.70;
            } else {
              h.verticalSpeed = 0;
            }
          }
        }
        break;
      }
    }
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed island (the helicopter may roam out over the harbour & the boroughs)
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(ISLAND_BOUNDS.minX - m, Math.min(ISLAND_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + m, pos.z));
    if (this.activeMode !== 'helicopter' && getIslandBoundsAtZ) {
      const shore = getIslandBoundsAtZ(pos.z);
      const minShoreX = shore.westX + 8.0;
      const maxShoreX = shore.eastX - 8.0;
      if (pos.x < minShoreX) {
        pos.x = minShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      } else if (pos.x > maxShoreX) {
        pos.x = maxShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
    }

    const body = collisionBody(this.activeMode, radius, carEntity ? carEntity.heading : (entity ? entity.heading : 0));
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (c.destroyed) continue;
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        let { nx, nz, depth } = contact;

        if (entity) {
          const sin = carEntity ? sinH : Math.sin(entity.heading || 0);
          const cos = carEntity ? cosH : Math.cos(entity.heading || 0);
          const totalVx = sin * (entity.speed || 0) + (entity.vx || 0);
          const totalVz = cos * (entity.speed || 0) + (entity.vz || 0);
          const totalVy = heli ? (entity.verticalSpeed || 0) : 0;
          const totalSpeed3D = Math.hypot(totalVx, totalVy, totalVz);
          // Positive vn means the entity is moving into the wall (opposite the outward normal nx, nz)
          const vn = -(totalVx * nx + totalVz * nz);
          const effectiveVn = heli ? Math.max(vn, totalSpeed3D * 0.75, Math.abs(totalVy) * 0.75) : vn;
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * 0.86 + Math.abs(nx * sin + nz * cos) * 2.18 : radius;
          const surfaceX = pos.x + nx * depth;
          const surfaceZ = pos.z + nz * depth;
          const hitX = surfaceX - nx * support;
          const hitY = pos.y + (heli ? 1.35 : 0.56);
          const hitZ = surfaceZ - nz * support;

          if ((vn > 0.8 || effectiveVn > 0.8) && this._collisionListener) {
            this.reportCollision(entity, c, 'building', hitX, hitY, hitZ, nx, 0, nz, Math.max(vn, effectiveVn));
          }

          const nowMs = performance.now();
          if (this.destructionSystem && (vn > 0.75 || effectiveVn > 0.75) && nowMs - (entity._lastBldgDestroyMs || 0) > 120) {
            entity._lastBldgDestroyMs = nowMs;
            this.destructionSystem.onBuildingCollision(
              entity,
              this.activeMode,
              hitX,
              hitY,
              hitZ,
              nx,
              nz,
              Math.max(vn, effectiveVn),
              true,
              c
            );
            // Heavy collisions also crack and buckle the adjacent road/sidewalk pavement
            if (vn > 6.5 && typeof this.destructionSystem.damageRoadSurface === 'function') {
              this.destructionSystem.damageRoadSurface(pos.x, pos.z, vn * 0.9, true);
            }
          }

          // If onBuildingCollision just triggered a building collapse, let the vehicle cleave through with realistic momentum transfer
          if (!buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
            if (carEntity && vn > 0.8) {
              carEntity.speed *= 0.74;
              carEntity.vx = (carEntity.vx || 0) * 0.74;
              carEntity.vz = (carEntity.vz || 0) * 0.74;
              carEntity.lastCollisionSpark = {
                x: hitX,
                y: 0.56,
                z: hitZ,
                nx,
                nz,
                speed: vn
              };
            }
            continue;
          }
          nx = contact.nx;
          nz = contact.nz;
          depth = contact.depth;
        }

        pos.x += nx * depth;
        pos.z += nz * depth;

        if (entity && !carEntity) {
          const sin = Math.sin(entity.heading || 0);
          const cos = Math.cos(entity.heading || 0);
          const totalVx = sin * (entity.speed || 0) + (entity.vx || 0);
          const totalVz = cos * (entity.speed || 0) + (entity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.05) {
            const restitution = heli ? 0.38 : this.activeMode === 'cyclist' ? 0.32 : 0.22;
            const normalImpulse = vn * (1.0 + restitution);
            const tx = -nz;
            const tz = nx;
            const vt = totalVx * tx + totalVz * tz;
            const frictionImpulse = -Math.sign(vt) * Math.min(Math.abs(vt), normalImpulse * 0.32);

            const postVx = totalVx + nx * normalImpulse + tx * frictionImpulse;
            const postVz = totalVz + nz * normalImpulse + tz * frictionImpulse;

            entity.speed = postVx * sin + postVz * cos;
            entity.vx = postVx - sin * entity.speed;
            entity.vz = postVz - cos * entity.speed;

            if (this.activeMode === 'cyclist') {
              const sideDot = cos * nx - sin * nz;
              entity.leanAngle = (entity.leanAngle || 0) - sideDot * Math.min(0.65, vn * 0.08);
            } else if (heli) {
              entity.verticalSpeed = (entity.verticalSpeed || 0) + (Math.random() - 0.35) * Math.min(4.5, vn * 0.28);
            }
          }
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          const headOn = Math.abs(sinH * nx + cosH * nz);
          const sideDot = cosH * nx - sinH * nz;

          // Only apply velocity impulse if the vehicle is approaching the wall (vn > 0.05)
          if (vn > 0.05) {
            // Realistic automotive structural restitution (crumple zone absorbs ~72% of normal kinetic energy)
            const restitution = 0.26 + 0.10 * (1.0 - headOn);
            const normalImpulse = vn * (1.0 + restitution);

            // Coulomb tangential wall friction slows scraping along the facade
            const tx = -nz;
            const tz = nx;
            const vt = totalVx * tx + totalVz * tz;
            const wallMu = 0.32;
            const tangentImpulse = -Math.sign(vt) * Math.min(Math.abs(vt), normalImpulse * wallMu);

            const newVx = totalVx + nx * normalImpulse + tx * tangentImpulse;
            const newVz = totalVz + nz * normalImpulse + tz * tangentImpulse;

            // Project post-impact world velocity cleanly onto chassis longitudinal speed and lateral slip (vx, vz)
            carEntity.speed = newVx * sinH + newVz * cosH;
            carEntity.vx = newVx - sinH * carEntity.speed;
            carEntity.vz = newVz - cosH * carEntity.speed;

            // Lever-arm yaw torque when striking a building corner or glancing at an angle
            const forwardDot = sinH * nx + cosH * nz;
            const spinTorque = sideDot * forwardDot;
            carEntity.angularVel = (carEntity.angularVel || 0) - spinTorque * Math.min(4.5, vn * 0.30);

            // Suspension pitch & roll reaction proportional to impulse (keep vertical height locked at 0)
            carEntity.pitchVel = (carEntity.pitchVel || 0) + forwardDot * Math.min(14.0, vn * 1.15) * 0.18;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn * 1.15) * 0.22;
            carEntity.heaveVel = 0;
            carEntity.heaveY = 0;
            if (vn > 1.8) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt, focusPos = null) {
    const focus = focusPos || this.getActiveEntity()?.position;
    const maxDistSq = 320 * 320;

    const p = this.entities.person;
    if (p) {
      const dx = focus ? p.position.x - focus.x : 0;
      const dz = focus ? p.position.z - focus.z : 0;
      if (this.activeMode === 'person' || dx * dx + dz * dz <= maxDistSq) {
        p._charHidden = false;
        if (p.mesh) p.mesh.visible = true;
        const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person');
        p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
        p.crowd.begin();
        p.crowd.add(p.rig, 0);
        p.crowd.end();
      } else if (!p._charHidden) {
        p.rig.placed = false;
        p.crowd.begin();
        p.crowd.end();
        if (p.crowd.updates > 2) {
          if (p.mesh) p.mesh.visible = false;
          p._charHidden = true;
        }
      }
    }

    const b = this.entities.cyclist;
    if (b) {
      const dx = focus ? b.position.x - focus.x : 0;
      const dz = focus ? b.position.z - focus.z : 0;
      if (this.activeMode === 'cyclist' || dx * dx + dz * dz <= maxDistSq) {
        if (b.helmet) b.helmet.visible = true;
        const moved =
          this.activeMode === 'cyclist' ||
          b._riderHidden ||
          b._posedX !== b.position.x ||
          b._posedY !== b.position.y ||
          b._posedZ !== b.position.z ||
          b._posedH !== b.heading ||
          b._posedLean !== b.leanAngle ||
          b._posedPedal !== b.pedalPhase;
        b._riderHidden = false;
        if (moved) {
          b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
          b.riderCrowd.begin();
          b.riderCrowd.add(b.riderRig, 0);
          b.riderCrowd.end();
          b.helmet.quaternion.copy(b.riderRig.headQuaternion);
          b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
          b._posedX = b.position.x;
          b._posedY = b.position.y;
          b._posedZ = b.position.z;
          b._posedH = b.heading;
          b._posedLean = b.leanAngle;
          b._posedPedal = b.pedalPhase;
        }
      } else if (!b._riderHidden) {
        b.riderCrowd.begin();
        b.riderCrowd.end();
        if (b.riderCrowd.updates > 2) {
          if (b.helmet) b.helmet.visible = false;
          b._riderHidden = true;
          b._posedX = NaN;
        }
      }
    }
  }

  update(dt, elapsed, focusPos = null) {
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else {
      // Keep the sidewalk pedestrian walking naturally when not actively controlled
      const p = this.entities.person;
      const walkSpeed = 1.48;
      p.speed = walkSpeed;
      p.position.x += Math.sin(p.heading) * walkSpeed * dt;
      p.position.z += Math.cos(p.heading) * walkSpeed * dt;
      if (p.position.z < -340) p.heading = 0;
      else if (p.position.z > 340) p.heading = Math.PI;
    }

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }

    // Check collisions between active player entity and all street props (trees, streetlamps, signals, hydrants, carts, steam stacks)
    const activeEnt = this.getActiveEntity();
    if (this.destructionSystem && activeEnt) {
      this.destructionSystem.checkEntityPropCollisions(activeEnt, this.activeMode, dt, true);
      if (typeof this.destructionSystem.applyCraterSuspensionJolt === 'function') {
        this.destructionSystem.applyCraterSuspensionJolt(activeEnt, this.activeMode, dt);
      }
    }

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.y = e.heading;
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        if (spot._broken) {
          spot.intensity = 0;
        } else if (spot._flicker > 0) {
          const flk = Math.sin(elapsed * 37.0 + spot._side * 4.0) > -0.2 ? 0.55 : 0.08;
          spot.intensity = HEADLIGHTS.intensity * beamScale * flk;
        } else {
          spot.intensity = HEADLIGHTS.intensity * beamScale;
        }
      }
    }
    const bike = this.entities.cyclist;
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt, focusPos);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    p.prevX = p.position.x;
    p.prevZ = p.position.z;
    if (p.isWrecked) {
      p.speed *= Math.exp(-10.0 * dt);
      p.vx = (p.vx || 0) * Math.exp(-8.0 * dt);
      p.vz = (p.vz || 0) * Math.exp(-8.0 * dt);
      p.position.x += p.vx * dt;
      p.position.z += p.vz * dt;
      this.resolveHorizontalCollision(p.position, 0.48, null, p);
      p.position.y = this.getGroundHeight(p.position.x, p.position.z, 'person');
      if (p.rig) {
        p.rig.pelvisTilt = 1.35;
        p.rig.pelvisRoll = 0.55;
      }
      return;
    }
    if (p.stumbleTimer > 0) {
      p.stumbleTimer = Math.max(0, p.stumbleTimer - dt);
    }
    const targetMax = this.currentSpeedCap;
    const turnRate = 3.6;

    let targetSpeed = 0;
    if (this.keys.forward) {
      const throttle = typeof this.keys.forward === 'number' ? this.keys.forward : 1.0;
      targetSpeed = targetMax * throttle;
    } else if (this.keys.backward) {
      const throttle = typeof this.keys.backward === 'number' ? this.keys.backward : 1.0;
      targetSpeed = -Math.min(25.0, targetMax * 0.35) * throttle;
    }

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    const acceleration = Math.max(28.0, Math.min(2500.0, targetMax * 1.1));
    p.speed += Math.max(-acceleration * dt, Math.min(acceleration * dt, targetSpeed - p.speed));

    p.vx = (p.vx || 0) * Math.exp(-5.8 * dt);
    p.vz = (p.vz || 0) * Math.exp(-5.8 * dt);

    const personSpd = Math.max(Math.abs(p.speed), Math.hypot(p.vx, p.vz));
    const personSteps = Math.min(48, Math.max(4, Math.ceil((personSpd * dt) / 0.85)));
    const personStep = dt / personSteps;

    for (let s = 0; s < personSteps; s++) {
      p.position.x += (Math.sin(p.heading) * p.speed + p.vx) * personStep;
      p.position.z += (Math.cos(p.heading) * p.speed + p.vz) * personStep;
      this.resolveHorizontalCollision(p.position, 0.48, null, p);
      if (this.destructionSystem) {
        this.destructionSystem.checkEntityPropCollisions(p, 'person', personStep, true);
      }
    }

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person');
    if (this.keys.up && p.position.y <= groundY + 0.02) {
      p.verticalVel = 12.0;
    }
    p.verticalVel -= 24.0 * dt;
    p.position.y += p.verticalVel * dt;
    if (p.position.y < groundY) {
      p.position.y = groundY;
      p.verticalVel = 0;
    }
  }

  updateCar(dt) {
    if (dt <= 0) return;
    const c = this.entities.car;

    let throttle = 0;
    if (!c.isWrecked) {
      if (this.keys.forward) throttle = this.keys.forward;
      else if (this.keys.backward) throttle = -this.keys.backward;
    } else {
      c.speed *= Math.exp(-7.5 * dt);
    }

    const braking = c.isWrecked || c.speed * throttle < 0;

    let steerInput = 0;
    if (!c.isWrecked) {
      if (this.keys.left) steerInput = this.keys.left;
      if (this.keys.right) steerInput = -this.keys.right;
    }

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.prevX = prevX;
    c.prevZ = prevZ;

    const estSpd = Math.max(Math.abs(c.speed), Math.hypot(c.vx || 0, c.vz || 0));
    const steps = Math.min(48, Math.max(4, Math.ceil((estSpd * dt) / 0.85)));
    const step = dt / steps;
    const steerResponse = 1 - Math.exp(-12 * step);
    const yawResponse = 1 - Math.exp(-8 * step);
    const tireResponse = 1 - Math.exp(-6 * step);

    for (let i = 0; i < steps; i++) {
      const sin = Math.sin(c.heading), cos = Math.cos(c.heading);
      const vx = sin * c.speed + c.vx, vz = cos * c.speed + c.vz;
      const forward = vx * sin + vz * cos;
      const sideways = vx * cos - vz * sin;
      const speed = driveSpeed(forward, throttle, step, CAR_DRIVE);
      const acceleration = (speed - forward) / step;
      const tireAcceleration = acceleration + CAR_DRIVE.drag * forward * Math.abs(forward);
      const grip = Math.sqrt(Math.max(0, CAR_DRIVE.grip ** 2 - tireAcceleration ** 2));
      const handbrake = forward * throttle < 0 ? Math.abs(throttle) * Math.min(1, Math.abs(forward) / 5) : 0;
      const lateralGrip = grip * (1 - 0.7 * handbrake);
      const steeringGrip = grip + (CAR_DRIVE.grip - grip) * handbrake;

      const turn = CAR_DRIVE.wheelbase * CAR_DRIVE.cornering;
      const maxSteer = Math.atan(turn / Math.max(speed * speed, turn / Math.tan(0.55)));
      c.steerAngle += (steerInput * maxSteer - c.steerAngle) * steerResponse;
      const yawLimit = steeringGrip / Math.max(2, Math.abs(speed));
      const targetYaw = Math.max(-yawLimit, Math.min(yawLimit, speed * Math.tan(c.steerAngle) / CAR_DRIVE.wheelbase));
      const yawStep = steeringGrip * 0.65 * step;
      c.angularVel += Math.max(-yawStep, Math.min(yawStep, (targetYaw - c.angularVel) * yawResponse));
      c.heading += c.angularVel * step;

      const nextSin = Math.sin(c.heading), nextCos = Math.cos(c.heading);
      const worldX = sin * speed + cos * sideways;
      const worldZ = cos * speed - sin * sideways;
      c.speed = worldX * nextSin + worldZ * nextCos;
      const slip = worldX * nextCos - worldZ * nextSin;
      const correction = Math.max(-lateralGrip * step, Math.min(lateralGrip * step, -slip * tireResponse));
      c.vx = nextCos * (slip + correction);
      c.vz = -nextSin * (slip + correction);
      c.position.x += (nextSin * c.speed + c.vx) * step;
      c.position.z += (nextCos * c.speed + c.vz) * step;
      this.resolveHorizontalCollision(c.position, 1.35, c);
      if (this.destructionSystem) {
        this.destructionSystem.checkEntityPropCollisions(c, 'car', step, true);
      }

      const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026 + (c.dentPitch || 0);
      const targetRoll = Math.max(-0.09, Math.min(0.09, correction / step * 0.012)) + (c.dentRoll || 0);
      c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * 68 - c.pitchVel * 11.2) * step;
      c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * 68 - c.rollVel * 11.2) * step;
      c.chassisPivot.rotation.x = Math.max(-0.18, Math.min(0.18, c.chassisPivot.rotation.x + c.pitchVel * step));
      c.chassisPivot.rotation.z = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.z + c.rollVel * step));
      c.heaveVel = 0;
      c.heaveY = 0;
    }
    c.position.y = this.getGroundHeight(c.position.x, c.position.z, 'car');
    c.chassisPivot.position.y = 0;

    if (c.carState) {
      c.carState.value.x = braking ? 1 : 0;
      c.carState.value.w = c.speed < -0.2 ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      // Bent wheel axle camber & rotational wobble from impacts
      w.steerPivot.rotation.z = (w.camber || 0) + Math.sin(c.wheelSpin * 2.0 + w.side) * (w.wobble || 0);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle + (w.toe || 0);
      } else {
        w.steerPivot.rotation.y = w.toe || 0;
      }
    }
  }

  updateCyclist(dt) {
    const b = this.entities.cyclist;
    b.prevX = b.position.x;
    b.prevZ = b.position.z;

    let throttle = 0;
    if (!b.isWrecked) {
      if (this.keys.forward) throttle = this.keys.forward;
      else if (this.keys.backward) throttle = -0.6 * this.keys.backward;
    } else {
      b.speed *= Math.exp(-8.0 * dt);
    }

    b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);

    let turnInput = 0;
    if (!b.isWrecked) {
      if (this.keys.left) turnInput = this.keys.left;
      if (this.keys.right) turnInput = -this.keys.right;
    }

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 3.6 * dirSign * dt;
    }

    b.vx = (b.vx || 0) * Math.exp(-5.5 * dt);
    b.vz = (b.vz || 0) * Math.exp(-5.5 * dt);

    const estBikeSpd = Math.max(Math.abs(b.speed), Math.hypot(b.vx, b.vz));
    const bikeSteps = Math.min(48, Math.max(4, Math.ceil((estBikeSpd * dt) / 0.85)));
    const bikeStep = dt / bikeSteps;

    for (let s = 0; s < bikeSteps; s++) {
      b.position.x += (Math.sin(b.heading) * b.speed + b.vx) * bikeStep;
      b.position.z += (Math.cos(b.heading) * b.speed + b.vz) * bikeStep;
      this.resolveHorizontalCollision(b.position, 0.65, null, b);
      if (this.destructionSystem) {
        this.destructionSystem.checkEntityPropCollisions(b, 'cyclist', bikeStep, true);
      }
    }
    b.position.y = this.getGroundHeight(b.position.x, b.position.z, 'cyclist');

    const targetLean = b.isWrecked ? 1.15 : (-turnInput * Math.min(1.0, Math.abs(b.speed) / 20.0) * 0.38 + (b.dentRoll || 0));
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 10);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;
    if (b.wheelBuckle) {
      b.frontWheel.rotation.z = Math.sin(b.frontWheel.rotation.x * 2.0) * b.wheelBuckle;
    }
    if (b.rearBuckle) {
      b.rearWheel.rotation.z = Math.cos(b.rearWheel.rotation.x * 2.0) * b.rearBuckle;
    }

    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    h.prevX = h.position.x;
    h.prevZ = h.position.z;
    const maxHorizSpeed = this.currentSpeedCap;
    const maxVertSpeed = Math.max(24.0, Math.min(320.0, this.currentSpeedCap * 0.35));

    let fwdInput = 0;
    let yawInput = 0;
    let vertInput = 0;
    if (!h.isWrecked) {
      if (this.keys.forward) fwdInput = this.keys.forward;
      else if (this.keys.backward) fwdInput = -this.keys.backward;

      if (this.keys.left) yawInput = this.keys.left;
      if (this.keys.right) yawInput = -this.keys.right;

      if (this.keys.up) vertInput = this.keys.up;
      else if (this.keys.down) vertInput = -this.keys.down;
    } else {
      h.speed *= Math.exp(-5.0 * dt);
      vertInput = -0.8;
    }

    if (fwdInput !== 0) {
      const targetHeliSpd = fwdInput > 0
        ? maxHorizSpeed * Math.abs(fwdInput)
        : -Math.min(35.0, maxHorizSpeed * 0.4) * Math.abs(fwdInput);
      const heliAccel = Math.max(28.0, Math.min(3200.0, maxHorizSpeed * 0.95));
      h.speed += Math.max(-heliAccel * dt, Math.min(heliAccel * dt, targetHeliSpd - h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 2.2);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 48.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 2.2 * dt;

    h.vx = (h.vx || 0) * Math.exp(-3.8 * dt);
    h.vz = (h.vz || 0) * Math.exp(-3.8 * dt);

    const estHeliSpd = Math.max(Math.abs(h.speed), Math.hypot(h.vx, h.vz), Math.abs(h.verticalSpeed));
    const heliSteps = Math.min(48, Math.max(4, Math.ceil((estHeliSpd * dt) / 1.0)));
    const heliStep = dt / heliSteps;

    for (let s = 0; s < heliSteps; s++) {
      h._prevY = h.position.y;
      h.position.x += (Math.sin(h.heading) * h.speed + h.vx) * heliStep;
      h.position.z += (Math.cos(h.heading) * h.speed + h.vz) * heliStep;
      h.position.y += h.verticalSpeed * heliStep;
      this.resolveHelicopterRoofCollision(h, heliStep);
      this.resolveHorizontalCollision(h.position, 4.5, null, h);
      if (this.destructionSystem) {
        this.destructionSystem.checkEntityPropCollisions(h, 'helicopter', heliStep, true);
      }
    }

    if (h.position.y < 0.25) {
      const impactV = Math.max(-h.verticalSpeed, Math.abs(h.speed) * 0.45);
      this.reportCollision(h, groundCollider, 'ground', h.position.x, 0.25, h.position.z, 0, 1, 0, impactV);
      if (this.destructionSystem && impactV > 3.2) {
        this.destructionSystem.applyEntityDamage(h, 'helicopter', impactV * 0.95, h.position.x, 0.4, h.position.z, 0, 1, true);
        if (typeof this.destructionSystem.damageRoadSurface === 'function') {
          this.destructionSystem.damageRoadSurface(h.position.x, h.position.z, impactV * 1.15, true);
        }
        h.verticalSpeed = Math.abs(h.verticalSpeed) * 0.42;
      }
    }
    h.position.y = Math.max(0.25, Math.min(480, h.position.y));

    const dmgShake = h.damage > 20 ? Math.sin(elapsed * 22.0) * 0.025 * Math.min(1, h.damage / 80) : 0;
    const targetPitch = (h.speed / maxHorizSpeed) * 0.28 + (h.dentPitch || 0) + dmgShake;
    const targetRoll = -yawInput * 0.32 + (h.dentRoll || 0) + dmgShake * 1.2;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 6);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 6);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
