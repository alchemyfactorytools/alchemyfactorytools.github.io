'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encode, decode, strip, slug } = require('../web/share.js');
const db = require('../data/alchemy_db.json');

const catalog = Object.keys(db.items).map((name) => ({ name }));

test('defaults encode to just the version', () => {
  const prefs = { fields: { rate: '0.1', maxTier: '', solver: 'composer', cauldronEnabled: true, useSteam: false }, belt: [], extraTargets: [], allowed: [] };
  assert.equal(encode(prefs, { version: 55 }), 'v=55');
});

test('typical build is short and human-readable', () => {
  const prefs = { fields: { item: 'Basic Fertilizer', maxTier: '4', rate: '30', cauldronEnabled: true } };
  assert.equal(encode(prefs, { version: 55 }), 'v=55&o=basic_fertilizer&r=30&t=4');
});

test('round trip: fields, belt, extra targets, allowed inputs', () => {
  const prefs = {
    fields: { item: 'Healing Potion', rate: '2', rateUnit: 'machines', maxTier: '3', sk_factory: '4', useSteam: true, steamMode: 'cost', cauldronEnabled: false, forbidCauldron: 'Impure Copper Powder, Clay' },
    belt: [{ item: 'Coke Powder', rate: 240 }, { item: 'Logs', rate: null }],
    extraTargets: [{ item: 'Soap', rate: 30, rateMode: 'min' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }],
    allowed: ['Logs', 'Gelatinous Gridlock', 'Copper Coin'],
  };
  const qs = encode(prefs, { version: 55 });
  assert.match(qs, /b=coke_powder:240,logs/);
  assert.match(qs, /x=soap:30m,bandage:2c/);
  assert.match(qs, /a=logs,gelatinous_gridlock,copper_coin/);
  const { prefs: back, version, present } = decode('?' + qs, catalog);
  assert.equal(present, true);
  assert.equal(version, 55);
  assert.deepEqual(back.fields, { item: 'Healing Potion', rate: '2', rateUnit: 'machines', maxTier: '3', sk_factory: '4', useSteam: true, steamMode: 'cost', cauldronEnabled: false, forbidCauldron: 'Impure Copper Powder, Clay' });
  assert.deepEqual(back.belt, prefs.belt);
  assert.deepEqual(back.extraTargets, prefs.extraTargets);
  assert.deepEqual(back.allowed, prefs.allowed);
});

test('apostrophe items slug cleanly and resolve', () => {
  assert.equal(slug('Philosopherˈs Stone'), 'philosophers_stone');
  const { prefs } = decode('?o=philosophers_stone', catalog);
  assert.equal(prefs.fields.item, 'Philosopherˈs Stone');
});

test('unknown slugs and junk fall back silently; foreign params survive', () => {
  const { prefs, present } = decode('?pipeline=legacy&o=not_an_item&b=nope:5,logs&x=bad&t=9', catalog);
  assert.equal(present, true);
  assert.equal(prefs.fields.item, undefined);
  assert.deepEqual(prefs.belt, [{ item: 'Logs', rate: null }]);
  assert.deepEqual(prefs.extraTargets, []);
  assert.equal(prefs.fields.maxTier, '9');
  assert.equal(strip('?pipeline=legacy&o=soap&t=2'), 'pipeline=legacy');
  assert.equal(encode({ fields: { item: 'Soap' } }, { version: 55, base: '?pipeline=legacy&o=old' }), 'pipeline=legacy&v=55&o=soap');
});

test('a query without our keys is reported absent', () => {
  assert.equal(decode('?pipeline=legacy', catalog).present, false);
  assert.equal(decode('', catalog).present, false);
});
