import test from 'node:test';
import assert from 'node:assert/strict';

import { ID_RANDOM_LENGTH, createIdMinter, formatId, isMintedId, mintId, seededRandom } from './ids.js';

test('an id is <prefix>_<base36 time>_<4 random>', () => {
  const id = formatId('med', 1762435200000, () => 0.5);
  assert.equal(id, `med_${(1762435200000).toString(36)}_iiii`);
  assert.match(id, /^med_[0-9a-z]+_[0-9a-z]{4}$/);
  assert.ok(isMintedId(id));
  assert.ok(isMintedId(id, 'med'));
  assert.ok(!isMintedId(id, 'take'));
  assert.ok(!isMintedId('shot_1761420033'), 'a v1 id has no random tail');
});

test('the clock and the random source are injectable', () => {
  let tick = 1000;
  const minter = createIdMinter({ now: () => tick++, random: seededRandom(3) });
  const first = minter.mint('take');
  const second = minter.mint('take');
  assert.equal(first.split('_')[1], (1000).toString(36));
  assert.equal(second.split('_')[1], (1001).toString(36));
  assert.notEqual(first, second);
});

test('the same seed mints the same ids', () => {
  const run = () => {
    const minter = createIdMinter({ now: () => 1762435200000, random: seededRandom(42) });
    return [minter.mint('med'), minter.mint('med'), minter.mint('look')];
  };
  assert.deepEqual(run(), run());
});

test('one minter never hands out the same id twice, even with a stuck random source', () => {
  const minter = createIdMinter({ now: () => 1762435200000, random: () => 0.25 });
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(minter.mint('med'));
  assert.equal(ids.size, 200);
  ids.forEach(id => assert.ok(isMintedId(id, 'med'), id));
});

test('reserved ids are never reissued', () => {
  const minter = createIdMinter({ now: () => 1762435200000, random: () => 0.25 });
  const taken = formatId('med', 1762435200000, () => 0.25);
  minter.reserve(taken);
  assert.ok(minter.has(taken));
  assert.notEqual(minter.mint('med'), taken);
});

test('a seeded random source stays in [0, 1) and does not repeat immediately', () => {
  const random = seededRandom(7);
  const values = Array.from({ length: 50 }, () => random());
  values.forEach(value => assert.ok(value >= 0 && value < 1));
  assert.equal(new Set(values).size, values.length);
});

test('mintId uses the real clock by default and honours overrides', () => {
  const before = Date.now();
  const id = mintId('job');
  const time = parseInt(id.split('_')[1], 36);
  assert.ok(time >= before && time <= Date.now());
  assert.equal(id.split('_')[2].length, ID_RANDOM_LENGTH);

  const pinned = mintId('job', { now: () => 7, random: () => 0 });
  assert.equal(pinned, 'job_7_0000');
});
