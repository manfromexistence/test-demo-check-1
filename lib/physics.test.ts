import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  vehicleContact,
  resolveVehicleContact,
  sweptVehicleContact,
} from '../public/js/vehicle-physics.js';
import {
  polygonContains,
  polygonBoxOverlaps,
  polygonContact,
  polygonSegmentFraction,
} from '../public/js/building-collision.js';

describe('Vehicle Rigid-Body Collision Physics', () => {
  it('detects head-on vehicle contact with zero lever-arm torque on centered impact', () => {
    const carA = {
      x: 0,
      z: 0,
      sin: 0,
      cos: 1,
      halfW: 1.0,
      halfL: 2.2,
      vx: 0,
      vz: 15,
      angularVel: 0,
      mass: 1500,
    };
    const carB = {
      x: 0,
      z: 3.8,
      sin: 0,
      cos: -1,
      halfW: 1.0,
      halfL: 2.2,
      vx: 0,
      vz: -10,
      angularVel: 0,
      mass: 1500,
    };
    const contact: Record<string, number> = {};
    const hit = vehicleContact(carA, carB, contact);
    assert.equal(hit, true);
    assert.ok(Math.abs(contact.depth - 0.6) < 1e-5);
    assert.ok(Math.abs(contact.nx) < 1e-5);
    assert.ok(Math.abs(contact.nz - -1) < 1e-5);

    const closing = resolveVehicleContact(carA, carB, contact);
    assert.equal(closing, 25);
    assert.ok(carA.vz < 15, 'carA should decelerate after impact');
    assert.ok(carB.vz > -10, 'carB should rebound forward');
    assert.ok(Math.abs(carA.angularVel) < 1e-6, 'centered head-on impact should produce zero spin');
    assert.ok(Math.abs(carB.angularVel) < 1e-6, 'centered head-on impact should produce zero spin');
  });

  it('produces yaw torque on off-center bumper collision', () => {
    const carA = {
      x: 0.9,
      z: 0,
      sin: 0,
      cos: 1,
      halfW: 1.0,
      halfL: 2.2,
      vx: 0,
      vz: 18,
      angularVel: 0,
      mass: 1500,
    };
    const carB = {
      x: 0,
      z: 3.9,
      sin: 0,
      cos: 1,
      halfW: 1.0,
      halfL: 2.2,
      vx: 0,
      vz: 0,
      angularVel: 0,
      mass: 1500,
    };
    const contact: Record<string, number> = {};
    assert.equal(vehicleContact(carA, carB, contact), true);
    resolveVehicleContact(carA, carB, contact);
    assert.ok(Math.abs(carA.angularVel) > 0.05, 'off-center hit must induce angular velocity');
    assert.ok(Math.abs(carB.angularVel) > 0.05, 'struck vehicle must rotate from off-center impulse');
  });

  it('catches high-speed tunneling collisions via sweptVehicleContact', () => {
    const fastCar = {
      prevX: -12,
      prevZ: 0,
      x: 12,
      z: 0,
      sin: 1,
      cos: 0,
      halfW: 0.95,
      halfL: 2.1,
      vx: 48,
      vz: 0,
      angularVel: 0,
      mass: 1400,
    };
    const parkedCar = {
      prevX: 0,
      prevZ: 0,
      x: 0,
      z: 0,
      sin: 0,
      cos: 1,
      halfW: 0.95,
      halfL: 2.1,
      vx: 0,
      vz: 0,
      angularVel: 0,
      mass: 1400,
    };
    const contact: Record<string, number> = {};
    // Discrete check at end of frame misses because fastCar is already at x=+12
    assert.equal(vehicleContact(fastCar, parkedCar, contact), false);
    // Continuous SAT sweep catches the mid-frame collision
    assert.equal(sweptVehicleContact(fastCar, parkedCar, contact), true);
    assert.ok(contact.nx < -0.9);
  });
});

describe('Building Polygon & Courtyard Collision Physics', () => {
  const courtyardBuilding = {
    outer: [
      { x: -20, z: -20 },
      { x: 20, z: -20 },
      { x: 20, z: 20 },
      { x: -20, z: 20 },
    ],
    holes: [
      [
        { x: -8, z: -8 },
        { x: 8, z: -8 },
        { x: 8, z: 8 },
        { x: -8, z: 8 },
      ],
    ],
  };

  it('handles outer walls and interior courtyard holes in polygonContains', () => {
    assert.equal(polygonContains(courtyardBuilding, 14, 0), true);
    assert.equal(polygonContains(courtyardBuilding, 0, 0), false, 'courtyard hole must be empty');
    assert.equal(polygonContains(courtyardBuilding, 25, 0), false);
  });

  it('resolves minimum push-out normal and depth for car OBB hitting a building wall', () => {
    const carBody = { car: true, hx: 0.95, hz: 2.18, cos: 1, sin: 0 };
    const contact = { nx: 0, nz: 0, depth: 0 };
    // Car nose penetrating 0.48m past the south wall at z = -20
    const hit = polygonContact(courtyardBuilding, 0, -21.7, carBody, contact);
    assert.equal(hit, true);
    assert.ok(Math.abs(contact.nz - -1) < 1e-4, 'outward normal on south wall should point -Z');
    assert.ok(Math.abs(contact.depth - 0.48) < 1e-3);
  });

  it('computes accurate occlusion segment fraction across building footprint', () => {
    const frac = polygonSegmentFraction(courtyardBuilding, -30, 14, 60, 0, 0, 1);
    // Segment from x=-30 to x=+30 at z=14 crosses building from x=-20 to x=+20 (40m out of 60m = 2/3)
    assert.ok(Math.abs(frac - 40 / 60) < 1e-5);
  });
});
