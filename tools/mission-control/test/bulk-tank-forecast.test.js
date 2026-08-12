const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

function loadInlineBulkTankProjection() {
  const manifestText = fs.readFileSync(path.resolve(__dirname, '../../../k8s/base/application.yaml'), 'utf8');
  const startIndex = manifestText.indexOf('var BULK_TANK_POLICY = {');
  const endIndex = manifestText.indexOf('function makeMetricSnapshot', startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Missing Bulk Tank forecast source in the deployed inline portal script.');
  }

  const inlineSource = manifestText.slice(startIndex, endIndex);
  const context = {
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    isNaN,
    parseFloat,
    parseInt,
    window: {},
    document: { getElementById: () => null },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${inlineSource}; this.__inlineBulkTankForecast = { normalizeBulkTankPolicy, calculateDemandFactor, computeBulkTankProjection };`, context);
  return context.__inlineBulkTankForecast;
}

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

test('days to empty and reserve breach values differ correctly for the same demand profile', () => {
  const projection = buildBulkTankProjection(fixturePolicy, 'customer');
  const demand = forecastDemandGalPerDay(fixturePolicy).gallonsPerDay;
  const expectedDaysToEmpty = fixturePolicy.currentGallons / demand;
  const expectedReserveBreachDays = (fixturePolicy.currentGallons - fixturePolicy.reserveGallons) / demand;

  assert.ok(projection.daysToEmpty > projection.reserveBreachDays);
  assert.ok(Math.abs(expectedDaysToEmpty - projection.daysToEmpty) < 0.1);
  assert.ok(Math.abs(expectedReserveBreachDays - projection.reserveBreachDays) < 0.1);
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

test('deployed inline bulk tank logic matches the shared source of truth', () => {
  const inline = loadInlineBulkTankProjection();
  const sharedProjection = buildBulkTankProjection(fixturePolicy, 'dispatch');
  const inlineProjection = inline.computeBulkTankProjection(fixturePolicy, 'dispatch');
  const sharedComparable = { ...sharedProjection };
  const inlineComparable = { ...inlineProjection };

  delete sharedComparable.recommendedDeliveryDate;
  delete inlineComparable.recommendedDeliveryDate;

  assert.deepEqual(inlineComparable, sharedComparable);
  assert.equal(new Date(inlineProjection.recommendedDeliveryDate).toISOString().slice(0, 10), new Date(sharedProjection.recommendedDeliveryDate).toISOString().slice(0, 10));
});

test('invalid tank configuration is rejected', () => {
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, reserveGallons: 400, capacityGallons: 500 }), /reserveGallons/i);
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, refillThresholdPct: 120 }), /refillThresholdPct/i);
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, baseDemandGalPerDay: 0 }), /baseDemandGalPerDay/i);
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, baseDemandGalPerDay: Number.NaN }), /baseDemandGalPerDay/i);
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, weatherSensitivity: -0.1 }), /weatherSensitivity/i);
  assert.throws(() => normalizeBulkTankPolicy({ ...fixturePolicy, weatherSensitivity: Number.POSITIVE_INFINITY }), /weatherSensitivity/i);
  assert.doesNotThrow(() => normalizeBulkTankPolicy({ ...fixturePolicy, weatherSensitivity: 0 }));
});

test('bulk tank projections stay in the Bulk Tank domain and avoid mixed cylinder terminology', () => {
  const projection = buildBulkTankProjection(fixturePolicy, 'customer');
  assert.equal(projection.domain, 'Bulk Tank');
  assert.doesNotMatch(JSON.stringify(projection), /cylinder|cage/i);
});
