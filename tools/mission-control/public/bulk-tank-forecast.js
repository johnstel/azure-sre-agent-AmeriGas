(function (root) {
  // Simulated operational defaults for the demo only — AmeriGas operations SMEs must validate before describing these thresholds as policy.
  const DEFAULT_POLICY = Object.freeze({
    profileId: 'bulk-tank-fixture-01',
    customerId: 'CUST-1842',
    tankName: 'Primary Residence Tank',
    capacityGallons: 500,
    reserveGallons: 100,
    refillThresholdPct: 35,
    criticalThresholdPct: 25,
    leadTimeDays: 3,
    pricePerGallon: 2.42,
    currentGallons: 170,
    baseDemandGalPerDay: 4.5,
    weatherSensitivity: 1.45,
    temperatureF: 32,
  });

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  function toFixedNumber(value, decimals) {
    return Number(Number(value).toFixed(decimals));
  }

  function addDays(date, days) {
    const value = new Date(date);
    value.setDate(value.getDate() + days);
    return value;
  }

  function normalizeBulkTankPolicy(policy = {}) {
    const merged = { ...DEFAULT_POLICY, ...policy };

    if (!Number.isFinite(merged.capacityGallons) || merged.capacityGallons <= 0) {
      throw new Error('Bulk Tank policy requires a positive capacityGallons value.');
    }
    if (!Number.isFinite(merged.reserveGallons) || merged.reserveGallons < 0 || merged.reserveGallons >= merged.capacityGallons || merged.reserveGallons > merged.capacityGallons * 0.5) {
      throw new Error('Bulk Tank reserveGallons must be between 0 and 50% of capacityGallons.');
    }
    if (!Number.isFinite(merged.refillThresholdPct) || merged.refillThresholdPct <= 0 || merged.refillThresholdPct >= 100) {
      throw new Error('Bulk Tank refillThresholdPct must be between 0 and 100.');
    }
    if (!Number.isFinite(merged.criticalThresholdPct) || merged.criticalThresholdPct <= 0 || merged.criticalThresholdPct >= merged.refillThresholdPct) {
      throw new Error('Bulk Tank criticalThresholdPct must be below refillThresholdPct.');
    }
    if (!Number.isFinite(merged.leadTimeDays) || merged.leadTimeDays < 0) {
      throw new Error('Bulk Tank leadTimeDays must be zero or greater.');
    }
    if (!Number.isFinite(merged.baseDemandGalPerDay) || merged.baseDemandGalPerDay <= 0) {
      throw new Error('Bulk Tank baseDemandGalPerDay must be a finite number greater than 0.');
    }
    if (!Number.isFinite(merged.weatherSensitivity) || merged.weatherSensitivity < 0) {
      throw new Error('Bulk Tank weatherSensitivity must be a finite number greater than or equal to 0.');
    }
    if (!Number.isFinite(merged.temperatureF)) {
      throw new Error('Bulk Tank temperatureF must be a finite number.');
    }

    const normalized = {
      ...merged,
      profileId: String(merged.profileId || DEFAULT_POLICY.profileId),
      customerId: String(merged.customerId || DEFAULT_POLICY.customerId),
      tankName: String(merged.tankName || DEFAULT_POLICY.tankName),
      capacityGallons: Number(merged.capacityGallons),
      reserveGallons: Number(merged.reserveGallons),
      refillThresholdPct: Number(merged.refillThresholdPct),
      criticalThresholdPct: Number(merged.criticalThresholdPct),
      leadTimeDays: Number(merged.leadTimeDays),
      pricePerGallon: Number(merged.pricePerGallon),
      currentGallons: clamp(Number(merged.currentGallons), 0, Number(merged.capacityGallons)),
      baseDemandGalPerDay: Number(merged.baseDemandGalPerDay),
      weatherSensitivity: Number(merged.weatherSensitivity),
      temperatureF: Number(merged.temperatureF),
    };

    return normalized;
  }

  function computeDemandFactor(temperatureF, weatherSensitivity = DEFAULT_POLICY.weatherSensitivity, baselineTemperatureF = 60) {
    const tempValue = Number(temperatureF);
    const sensitivityValue = Number(weatherSensitivity);
    if (!Number.isFinite(tempValue) || !Number.isFinite(sensitivityValue) || sensitivityValue < 0) {
      throw new Error('Bulk Tank demand inputs must remain finite and weatherSensitivity cannot be negative.');
    }
    const delta = Math.max(0, Number(baselineTemperatureF) - tempValue);
    return toFixedNumber(1 + (delta / 35) * sensitivityValue, 3);
  }

  function getDemandDays(currentGallons, demandGallonsPerDay) {
    if (!Number.isFinite(currentGallons) || currentGallons <= 0) return 0;
    if (!Number.isFinite(demandGallonsPerDay) || demandGallonsPerDay <= 0) return Number.POSITIVE_INFINITY;
    return currentGallons / demandGallonsPerDay;
  }

  function computeBulkTankState(policy = DEFAULT_POLICY) {
    const normalized = normalizeBulkTankPolicy(policy);
    const currentGallons = clamp(Number(normalized.currentGallons), 0, Number(normalized.capacityGallons));
    const usableGallons = Math.max(currentGallons - Number(normalized.reserveGallons), 0);
    const tankLevelPct = (currentGallons / Number(normalized.capacityGallons)) * 100;

    return {
      currentGallons: toFixedNumber(currentGallons, 1),
      usableGallons: toFixedNumber(usableGallons, 1),
      capacityGallons: Number(normalized.capacityGallons),
      reserveGallons: Number(normalized.reserveGallons),
      tankLevelPct: toFixedNumber(tankLevelPct, 1),
    };
  }

  function forecastDemandGalPerDay(policy = DEFAULT_POLICY) {
    const normalized = normalizeBulkTankPolicy(policy);
    const temperature = Number(normalized.temperatureF);
    const demandFactor = computeDemandFactor(temperature, normalized.weatherSensitivity, 60);
    const gallonsPerDay = normalized.baseDemandGalPerDay * demandFactor;

    return {
      temperatureF: temperature,
      demandFactor: demandFactor,
      gallonsPerDay: toFixedNumber(gallonsPerDay, 2),
    };
  }

  function buildDeliveryRecommendation(policy = DEFAULT_POLICY) {
    const normalized = normalizeBulkTankPolicy(policy);
    const capacityState = computeBulkTankState(normalized);
    const demand = forecastDemandGalPerDay(normalized);
    const reserveBreachDays = getDemandDays(capacityState.usableGallons, demand.gallonsPerDay);
    const thresholdGallons = normalized.capacityGallons * (normalized.refillThresholdPct / 100);
    const thresholdCrossed = capacityState.currentGallons <= thresholdGallons;
    const recommendedDaysOut = Number.isFinite(reserveBreachDays) ? Math.max(0, reserveBreachDays - normalized.leadTimeDays) : 0;
    const recommendedDeliveryDate = Number.isFinite(recommendedDaysOut) ? addDays(new Date(), Math.max(0, Math.floor(recommendedDaysOut))).toISOString() : new Date().toISOString();
    const shouldRecommend = thresholdCrossed || (Number.isFinite(reserveBreachDays) && reserveBreachDays <= normalized.leadTimeDays);

    return {
      thresholdGallons: toFixedNumber(thresholdGallons, 1),
      thresholdCrossed,
      daysUntilReserveBreach: toFixedNumber(reserveBreachDays, 1),
      recommendedDaysOut: toFixedNumber(recommendedDaysOut, 1),
      recommendedDeliveryDate,
      shouldRecommend,
      reason: shouldRecommend
        ? 'Delivery recommended before the configured reserve breach window.'
        : 'Current forecast remains above the configured refill threshold.',
    };
  }

  function buildBulkTankProjection(policy = DEFAULT_POLICY, portalName = 'customer') {
    const normalized = normalizeBulkTankPolicy(policy);
    const capacityState = computeBulkTankState(normalized);
    const demand = forecastDemandGalPerDay(normalized);
    const recommendation = buildDeliveryRecommendation(normalized);
    const demandPerDay = Number(demand.gallonsPerDay);
    const daysToEmpty = getDemandDays(capacityState.currentGallons, demandPerDay);
    const reserveBreachDays = getDemandDays(capacityState.usableGallons, demandPerDay);
    const seasonDemand = normalized.temperatureF <= 35 ? 'Peak' : (normalized.temperatureF <= 55 ? 'Normal' : 'Low');
    const seasonClass = seasonDemand === 'Peak' ? 'demand-peak' : seasonDemand === 'Normal' ? 'demand-normal' : 'demand-low';

    return {
      profileId: normalized.profileId,
      customerId: normalized.customerId,
      tankName: normalized.tankName,
      domain: 'Bulk Tank',
      portalName,
      capacityGallons: Number(normalized.capacityGallons),
      reserveGallons: Number(normalized.reserveGallons),
      refillThresholdPct: Number(normalized.refillThresholdPct),
      criticalThresholdPct: Number(normalized.criticalThresholdPct),
      leadTimeDays: Number(normalized.leadTimeDays),
      currentGallons: capacityState.currentGallons,
      tankLevelPct: capacityState.tankLevelPct,
      usableGallons: capacityState.usableGallons,
      pricePerGallon: Number(normalized.pricePerGallon),
      temperatureF: demand.temperatureF,
      demandFactor: demand.demandFactor,
      projectedDemandGalPerDay: demand.gallonsPerDay,
      seasonDemand,
      seasonClass,
      daysToEmpty: toFixedNumber(daysToEmpty, 1),
      reserveBreachDays: toFixedNumber(reserveBreachDays, 1),
      shouldRecommendDelivery: recommendation.shouldRecommend,
      recommendedDeliveryDaysOut: recommendation.recommendedDaysOut,
      recommendedDeliveryDate: recommendation.recommendedDeliveryDate,
      recommendationReason: recommendation.reason,
    };
  }

  const bulkTankForecast = {
    DEFAULT_POLICY,
    normalizeBulkTankPolicy,
    calculateCapacityState: computeBulkTankState,
    computeDemandFactor,
    forecastDemandGalPerDay,
    buildDeliveryRecommendation,
    buildBulkTankProjection,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = bulkTankForecast;
  }

  root.BulkTankForecast = bulkTankForecast;
})(typeof window !== 'undefined' ? window : globalThis);
