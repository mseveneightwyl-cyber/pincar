const assert = require('assert')
const Module = require('module')

process.env.PINCAR_SECURITY_TEST = '1'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database() { return { command: {} } }
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const security = require('../cloudfunctions/pincar/index').__test

assert.strictEqual(security.normalizeNickname('  小   王  '), '小 王')
assert.doesNotThrow(() => security.validateNickname('小王_7'))
assert.throws(() => security.validateNickname('<script>'))
assert.doesNotThrow(() => security.validateGroupId('car_1725100000000_a1b2c3d4'))
assert.doesNotThrow(() => security.validateGroupId('waiting_1725100000000_a1b2c3d4e5f6'))
assert.throws(() => security.validateGroupId('../groups/anything'))
assert.doesNotThrow(() => security.validateReservationId('slot_science_to_gangcheng_SOUTH_GATE_1725100000000_1'))
assert.throws(() => security.validateReservationId('slot_unknown_1725100000000_1'))

let state = null
for (let index = 0; index < 5; index += 1) {
  state = security.nextRateState(state, 'createCarGroup', 1725100000000 + index)
}
assert.throws(() => security.nextRateState(state, 'createCarGroup', 1725100000010))
assert.doesNotThrow(() => security.nextRateState(state, 'createCarGroup', 1725100061000))

console.log('PINCAR SECURITY CHECKS: PASS')
