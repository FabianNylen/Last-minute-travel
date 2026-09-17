'use strict';

/**
 * Snabbtest utan AI-anrop.
 * Kontrollerar det som ALDRIG får gå fel: hårda krav, validering, escaping, server.
 * Kör med: npm run smoke
 */

const assert = require('node:assert');
const travel = require('../lib/travel');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

/* ------------------------------------------------- validering */

console.log('\nFormulärvalidering');

test('tom avreseort avvisas', () => {
  assert.throws(() => travel.normalizeCriteria({}), /Fyll i vilken ort/);
});

test('hemkomst före avresa avvisas', () => {
  assert.throws(() => travel.normalizeCriteria({
    origin: 'Göteborg',
    earliestDeparture: '2099-01-09T16:00',
    latestReturn: '2099-01-08T20:00',
    budgetSek: 6000,
  }), /måste vara efter/);
});

test('för låg budget avvisas', () => {
  assert.throws(() => travel.normalizeCriteria({
    origin: 'Göteborg',
    earliestDeparture: '2099-01-09T16:00',
    latestReturn: '2099-01-11T20:00',
    budgetSek: 200,
  }), /minst 1 000 kr/);
});

test('giltiga kriterier går igenom och saniteras', () => {
  const c = travel.normalizeCriteria({
    origin: '  Göteborg ',
    earliestDeparture: '2099-01-09T16:00',
    latestReturn: '2099-01-11T20:00',
    budgetSek: '6000',
    styles: ['city', 'mat', 'nattliv', 'påhittad-stil'],
    preferDirect: true,
  });
  assert.strictEqual(c.origin, 'Göteborg');
  assert.strictEqual(c.budgetSek, 6000);
  assert.deepStrictEqual(c.styles, ['city', 'mat', 'nattliv'], 'okända stilar ska filtreras bort');
  assert.strictEqual(c.preferDirect, true);
});

/* ---------------------------------------------- hårda krav */

console.log('\nHårda krav (får aldrig brytas)');

const criteria = travel.normalizeCriteria({
  origin: 'Göteborg',
  earliestDeparture: '2099-01-09T16:00',   // fredag efter 16:00
  latestReturn: '2099-01-11T20:00',        // söndag före 20:00
  budgetSek: 6000,
  styles: ['city', 'mat', 'nattliv'],
});

function candidate(overrides = {}) {
  return {
    id: 'test-1',
    destination: 'Berlin',
    country: 'Tyskland',
    nights: 2,
    outbound: { date: '2099-01-09', departTime: '17:30', arriveTime: '19:00', direct: true, durationMinutes: 90 },
    inbound:  { date: '2099-01-11', departTime: '16:00', arriveTime: '17:30', direct: true, durationMinutes: 90 },
    flightPriceSek: 1500,
    flightPriceConfidence: 'estimated',
    hotel: { name: 'Hotel X', area: 'Mitte', rating: 8.4, pricePerNightSek: 1200, totalSek: 2400, priceConfidence: 'estimated' },
    totalPriceSek: 3900,
    ...overrides,
  };
}

test('godkänd kandidat behålls', () => {
  const { kept, rejected } = travel.enforceHardConstraints([candidate()], criteria);
  assert.strictEqual(kept.length, 1, `förväntade 1 kvar, fick ${kept.length}: ${JSON.stringify(rejected)}`);
});

test('över budget kastas bort', () => {
  const { kept, rejected } = travel.enforceHardConstraints(
    [candidate({ totalPriceSek: 6500 })], criteria);
  assert.strictEqual(kept.length, 0);
  assert.match(rejected[0].reasons.join(' '), /överstiger budgeten/);
});

test('exakt på budgeten godkänns', () => {
  const { kept } = travel.enforceHardConstraints(
    [candidate({ totalPriceSek: 6000 })], criteria);
  assert.strictEqual(kept.length, 1);
});

test('avresa före tidigaste avresa kastas bort', () => {
  const { kept, rejected } = travel.enforceHardConstraints(
    [candidate({ outbound: { date: '2099-01-09', departTime: '09:00', arriveTime: '10:30', direct: true, durationMinutes: 90 } })],
    criteria);
  assert.strictEqual(kept.length, 0);
  assert.match(rejected[0].reasons.join(' '), /före tidigaste avresa/);
});

test('hemkomst efter senast hemma kastas bort', () => {
  const { kept, rejected } = travel.enforceHardConstraints(
    [candidate({ inbound: { date: '2099-01-11', departTime: '21:00', arriveTime: '22:30', direct: true, durationMinutes: 90 } })],
    criteria);
  assert.strictEqual(kept.length, 0);
  assert.match(rejected[0].reasons.join(' '), /efter senast hemma/);
});

test('okänt totalpris kastas bort (budget kan inte garanteras)', () => {
  const { kept, rejected } = travel.enforceHardConstraints(
    [candidate({ totalPriceSek: null })], criteria);
  assert.strictEqual(kept.length, 0);
  assert.match(rejected[0].reasons.join(' '), /totalpris kunde inte fastställas/);
});

test('dubbletter tas bort', () => {
  const { kept } = travel.enforceHardConstraints(
    [candidate(), candidate({ id: 'test-2' })], criteria);
  assert.strictEqual(kept.length, 1);
});

test('tid på plats härleds när AI:n inte angav den', () => {
  const { kept } = travel.enforceHardConstraints([candidate()], criteria);
  // landar 19:00 fredag, lyfter 16:00 söndag = 45 h
  assert.strictEqual(kept[0].timeAtDestinationHours, 45);
  assert.strictEqual(kept[0].totalTravelTimeMinutes, 180);
  assert.strictEqual(kept[0].isDirect, true);
});

test('gränsfall: avresa exakt på minuten godkänns', () => {
  const { kept } = travel.enforceHardConstraints(
    [candidate({ outbound: { date: '2099-01-09', departTime: '16:00', arriveTime: '17:30', direct: true, durationMinutes: 90 } })],
    criteria);
  assert.strictEqual(kept.length, 1);
});

/* ------------------------------------------------- prompter */

console.log('\nPrompter');

test('researchprompten innehåller de hårda kraven', () => {
  const p = travel.buildResearchPrompt(criteria);
  assert.ok(p.includes('6000 kr'), 'budget saknas i prompten');
  assert.ok(p.includes('Göteborg'), 'avreseort saknas');
  assert.ok(p.includes('16:00'), 'avresetid saknas');
  assert.ok(/får INTE hitta på priser/.test(p), 'regeln om att inte hitta på saknas');
});

test('redaktörsprompten säger att billigast inte vinner', () => {
  const p = travel.buildEditorPrompt(criteria, [candidate()]);
  assert.ok(/Billigast vinner INTE automatiskt/.test(p));
  assert.ok(/EXAKT TRE/.test(p));
});

/* -------------------------------------------------- summering */

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} godkända, ${failed} misslyckade\n`);
process.exit(failed === 0 ? 0 : 1);
