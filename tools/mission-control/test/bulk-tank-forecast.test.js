const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBulkTankProjection,
  forecastDemandGalPerDay,
  normalizeBulkTankPolicy,
} = require('../public/bulk-tank-forecast');

const fixturePolicy = {
  profileId: 'bulk-tank-fixture-01',
  customerId: 'CUST-1842',
  tankName: 'Primary Residence Tank',
  capacityGallons: 500,
  reserveGallons: 100,
  refillThresholdPct: 35,
  criticalThresholdPct: 25,
  leadTimeDays: 3,
  currentGallons: 170,
  baseDemandGalPerDay: 4.5,
  weatherSensitivity: 1.45,
  temperatureF: 32,
  pricePerGallon: 2.42,
};

test('capacity and usable gallons are calculated from the tank configuration', () => {
  const projection = buildBulkTankProjection(fixturePolicy, 'customer');

  assert.equal(projection.capacityGallons, 500);
  assert.equal(projection.reserveGallons, 100);
  assert.equal(projection.currentGallons, 170);
  assert.equal(projection.tankLevelPct, 34);
  assert.equal(projection.usableGallons, 70);
});

test('colder weather increases forecast demand predictably', () => {
  const chilly = buildBulkTankProjection({ ...fixturePolicy, temperatureF: 32 }, 'customer');
  const warmer = buildBulkTankProjection({ ...fixturePolicy, temperatureF: 55 }, 'customer');

  assert.ok(chilly.projectedDemandGalPerDay > warmer.projectedDemandGalPerDay);
  assert.equal(chilly.seasonDemand, 'Peak');
  assert.equal(warmer.seasonDemand, 'Normal');
});

test('crossing the refill threshold creates a delivery recommendation', () => {
  const projection = buildBulkTankProjection(fixturePolicy, 'customer');

  assert.equal(projection.shouldRecommendDelivery, true);
  assert.equal(projection.tankLevelPct <= projection.refillThresholdPct, true);
  assert.match(projection.recommendationReason, /recommended/i);
});

test('recommendations schedule delivery before reserve breach when lead time is considered', () => {
  const projection = buildBulkTankProjection(fixturePolicy, 'customer');
  const breachDate = new Date(Date.now() + (projection.reserveBreachDays * 24 * 60 * 60 * 1000));
  const recommendedDate = new Date(projection.recommendedDeliveryDate);

  assert.ok(projection.reserveBreachDays > projection.leadTimeDays);
  assert.ok(recommendedDate.getTime() < breachDate.getTime());
  assert.ok((breachDate.getTime() - recommendedDate.getTime()) > (projection.leadTimeDays * 24 * 60 * 60 * 1000));
});

test('customer and dispatch portals generate the same bulk tank projection for the same fixture', () => {
  const customer = buildBulkTankProjection({ ...fixturePolicy }, 'customer');
  const dispatch = buildBulkTankProjection({ ...fixturePolicy }, 'dispatch');
  const customerComparable = { ...customer };
  const dispatchComparable = { ...dispatch };

  delete customerComparable.portalName;
  delete dispatchComparable.portalName;

  assert.deepEqual(customerComparable, dispatchComparable);
});

test('invalid tank configuration is rejected', () => {
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, reserveGallons: 400, capacityGallons: 500 }), /reserveGallons/i);
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, refillThresholdPct: 120 }), /refillThresholdPct/i);
});

test('bulk tank projections stay in the Bulk Tank domain and avoid mixed cylinder terminology', () => {
  const projection = buildBulkTankProjection(fixturePolicy, 'customer');
  assert.equal(projection.domain, 'Bulk Tank');
  assert.doesNotMatch(JSON.stringify(projection), /cylinder|cage/i);
});
