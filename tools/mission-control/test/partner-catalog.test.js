'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CATALOG_PATH = path.resolve(__dirname, '../data/partner-catalog.json');
const MANIFEST_PATH = path.resolve(__dirname, '../../../k8s/base/application.yaml');

const REQUIRED_DISCLAIMER = 'ZavaGas and all companies, people, locations, operational data, and incidents in this lab are fictional and used only for demonstration.';

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

test('the shared partner catalog is valid JSON with the required top-level shape', () => {
  const catalog = loadCatalog();
  assert.equal(catalog.brand, 'ZavaGas');
  assert.equal(catalog.disclaimer, REQUIRED_DISCLAIMER);
  assert.equal(Number.isInteger(catalog.version), true);
  assert.equal(Array.isArray(catalog.regions), true);
  assert.equal(Array.isArray(catalog.sites), true);
  assert.ok(catalog.sites.length > 0);
});

test('every catalog site has stable unique ids and all required fields', () => {
  const catalog = loadCatalog();
  const requiredFields = ['id', 'partner', 'siteLabel', 'region', 'route', 'cageSize', 'distanceMiles', 'primary'];
  const seenIds = new Set();

  for (const site of catalog.sites) {
    for (const field of requiredFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(site, field), `site missing required field "${field}": ${JSON.stringify(site)}`);
    }
    assert.equal(seenIds.has(site.id), false, `duplicate site id: ${site.id}`);
    seenIds.add(site.id);
    assert.equal(typeof site.id, 'string');
    assert.ok(site.id.length > 0);
    assert.equal(typeof site.cageSize, 'number');
    assert.ok(site.cageSize > 0);
    assert.equal(typeof site.distanceMiles, 'number');
    assert.ok(site.distanceMiles >= 0);
    assert.equal(typeof site.primary, 'boolean');
  }
});

test('every catalog site region is one of the catalog\'s declared fictional regions', () => {
  const catalog = loadCatalog();
  const declaredRegions = new Set(catalog.regions);
  for (const site of catalog.sites) {
    assert.ok(declaredRegions.has(site.region), `site ${site.id} uses undeclared region "${site.region}"`);
  }
  // Only the fictional Zava-* regions from issue #27 are permitted.
  for (const region of catalog.regions) {
    assert.match(region, /^Zava-(East|Central|North)$/);
  }
});

test('the catalog matches the canonical issue #27 partner roster (8 primary sites, 12 total)', () => {
  const catalog = loadCatalog();
  const primarySites = catalog.sites.filter((s) => s.primary);
  assert.equal(primarySites.length, 8, 'expected exactly 8 primary sites (one per partner) for the customer portal');
  assert.equal(catalog.sites.length, 12, 'expected exactly 12 total sites for the dispatch console');

  const expectedPartners = [
    'Contoso', 'Fabrikam', 'Adventure Works', 'Northwind Traders',
    'Wide World Importers', 'Tailspin Toys', 'Fourth Coffee', 'Woodgrove',
  ];
  const actualPartners = new Set(catalog.sites.map((s) => s.partner));
  for (const partner of expectedPartners) {
    assert.ok(actualPartners.has(partner), `expected partner "${partner}" in the shared catalog`);
  }
});

test('no catalog site name or route references a real retailer or real highway/location', () => {
  const catalog = loadCatalog();
  const bannedTerms = [
    'amerigas', 'walmart', 'home depot', 'lowe', 'wawa', 'shoprite', 'giant',
    'costco', 'ace hardware', "bj's", 'tractor supply', 'pennsylvania',
    'new jersey', 'philadelphia', 'allentown',
  ];
  const haystack = JSON.stringify(catalog).toLowerCase();
  for (const term of bannedTerms) {
    assert.equal(haystack.includes(term), false, `catalog unexpectedly contains banned term "${term}"`);
  }
});

test('the deployed customer portal and dispatch console fetch the single shared catalog file instead of embedding their own hardcoded location arrays', () => {
  const manifestText = fs.readFileSync(MANIFEST_PATH, 'utf8');

  const fetchOccurrences = manifestText.split("'/partner-catalog.json'").length - 1
    + manifestText.split('"/partner-catalog.json"').length - 1;
  assert.ok(fetchOccurrences >= 2, 'expected both customer-portal and dispatch-console inline scripts to fetch /partner-catalog.json');

  // Neither portal script should hardcode a real retailer/location name —
  // this guards against a regression back to two independent arrays.
  const bannedTerms = ['Walmart', 'Home Depot', "Lowe's", 'Wawa', 'ShopRite', 'Giant Pottstown', 'Costco', 'ACE Hardware', "BJ's", 'Tractor Supply'];
  for (const term of bannedTerms) {
    assert.equal(manifestText.includes(term), false, `k8s/base/application.yaml unexpectedly still contains "${term}"`);
  }
});

test('the partner-catalog-config ConfigMap is mounted into both customer-portal and dispatch-console pods', () => {
  const manifestText = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const mountOccurrences = manifestText.split('name: partner-catalog-config').length - 1;
  assert.ok(mountOccurrences >= 2, 'expected the partner-catalog-config ConfigMap to be referenced by both portal Deployments');
});
