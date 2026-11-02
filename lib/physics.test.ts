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

describe('Speed Controller & Kinetic Energy: 40 MPH Default to Max Light Speed', () => {
  const MPH_TO_MS = 0.44704;
  const SPEED_40_MPH = 40 * MPH_TO_MS; // 17.8816 m/s
  const SPEED_100_MPH = 100 * MPH_TO_MS; // 44.704 m/s
  const SPEED_500_MPH = 500 * MPH_TO_MS; // 223.52 m/s
  const SPEED_1000_MPH = 1000 * MPH_TO_MS; // 447.04 m/s
  const LIGHT_SPEED_SIM_MS = 15000.0; // m/s simulation units

  function calcBuildingDamage(entityMass: number, impactSpeed: number) {
    const kineticEnergy = 0.5 * entityMass * (impactSpeed * impactSpeed);
    return (kineticEnergy / 1050000.0) + (impactSpeed * 0.04);
  }

  it('keeps 40 MPH as default city cruise speed with realistic low structural impact', () => {
    const carMass = 1600;
    const damage40 = calcBuildingDamage(carMass, SPEED_40_MPH);
    assert.ok(damage40 >= 0.5 && damage40 <= 1.5, `40 MPH city bump should cause minor damage (~1%), got ${damage40}%`);
    assert.ok(damage40 < 5.0, 'a standard 40 MPH city bump must never prematurely collapse a skyscraper');
  });

  it('inflicts proportional ~47% damage at 500 MPH requiring 2-3 rams to collapse a building', () => {
    const carMass = 1600;
    const damage500 = calcBuildingDamage(carMass, SPEED_500_MPH);
    assert.ok(damage500 >= 40 && damage500 <= 55, `500 MPH car damage should be ~47%, got ${damage500}`);
    assert.ok(damage500 < 100.0, 'a single 500 MPH ram should breach wall without instant collapse');
    assert.ok(damage500 * 3 >= 100.0, '3 rams at 500 MPH must exceed 100 HP threshold to collapse building');
  });

  it('inflicts catastrophic >100% damage at 1000 MPH supersonic impact triggering instant collapse', () => {
    const carMass = 1600;
    const damage1000 = calcBuildingDamage(carMass, SPEED_1000_MPH);
    assert.ok(damage1000 >= 150, `1000 MPH supersonic car impact must exceed 150 damage, got ${damage1000}`);
    assert.ok(damage1000 >= 100.0, '1000 MPH supersonic impact must trigger instant total structural collapse');
  });

  it('delivers massive relativistic obliteration at Max Light Speed', () => {
    const carMass = 1600;
    const damageLightSpeed = calcBuildingDamage(carMass, LIGHT_SPEED_SIM_MS);
    assert.ok(damageLightSpeed > 100000, `Light speed impact must deliver catastrophic kinetic obliteration, got ${damageLightSpeed}`);
  });

  it('scales person and cyclist kinetic energy proportionally at 40 MPH and 500 MPH', () => {
    const personMass = 90;
    const cyclistMass = 140;
    const personDmg40 = calcBuildingDamage(personMass, SPEED_40_MPH);
    const cyclistDmg40 = calcBuildingDamage(cyclistMass, SPEED_40_MPH);
    assert.ok(personDmg40 < 1.0, `human bump at 40 MPH inflicts negligible building damage (< 1%), got ${personDmg40}`);
    assert.ok(cyclistDmg40 > personDmg40, 'cyclist with bike mass has higher momentum than pedestrian');

    const personDmg500 = calcBuildingDamage(personMass, SPEED_500_MPH);
    const cyclistDmg500 = calcBuildingDamage(cyclistMass, SPEED_500_MPH);
    assert.ok(personDmg500 < 15, 'human impact at 500 MPH breaches wall with moderate structural damage');
    assert.ok(cyclistDmg500 > personDmg500, 'cyclist with bike mass inflicts higher damage than pedestrian');
  });
});

