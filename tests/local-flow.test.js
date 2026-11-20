const assert = require('assert')

const memory = {}
let fakeNow = new Date('2026-08-28T00:00:00.000Z').getTime()
Date.now = () => fakeNow

global.wx = {
  getStorageSync(key) {
    return memory[key]
  },
  setStorageSync(key, value) {
    memory[key] = JSON.parse(JSON.stringify(value))
  }
}

const store = require('../services/local-store')
const PROFILE_KEY = 'pincar_profile_v1'

function login(id, nickname) {
  wx.setStorageSync(PROFILE_KEY, { id, nickname })
}

async function run() {
  const joined = []

  for (let index = 1; index <= 5; index += 1) {
    login(`user_${index}`, `用户${index}`)
    joined.push(await store.joinWaiting('science_to_gangcheng'))
  }

  assert(joined.slice(0, 4).every((group) => group.id === joined[0].id), '前四人应进入同一个队伍')
  assert.strictEqual(joined[3].memberCount, 4, '第一个队伍应有四人')
  assert.notStrictEqual(joined[4].id, joined[0].id, '第五人应建立新队伍')
  assert.notStrictEqual(joined[4].code, joined[0].code, '同一天的暗号不能重复')

  login('reverse_user', '反向用户')
  const reverseGroup = await store.joinWaiting('gangcheng_to_science')
  assert.notStrictEqual(reverseGroup.id, joined[0].id, '两个通勤方向不能混组')

  login('user_1', '用户1')
  const carGroup = await store.submitPlate(joined[0].id, '5M6CR', 'SOUTH_GATE', '07:10')
  assert.strictEqual(carGroup.status, 'CAR_WAITING', '填写车牌后应转为已叫车组')
  assert.strictEqual(carGroup.plateTail, '5M6CR', '车牌尾号应保存')
  assert.strictEqual(carGroup.meetingGate, 'SOUTH_GATE', '上车门应保存')
  assert.strictEqual(carGroup.arrivalTime, '07:10', '预计时间应保存')
  assert.strictEqual(carGroup.isLeader, true, '填写车牌者应成为叫车人')

  let room = await store.getRoom('science_to_gangcheng')
  assert(room.boards.some((board) => board.id === joined[0].id), '车牌应出现在同方向房间顶部')

  login('user_2', '用户2')
  await store.leaveGroup(joined[0].id)
  login('user_1', '用户1')
  const afterLeave = await store.getGroup(joined[0].id)
  assert.strictEqual(afterLeave.memberCount, 3, '成员退出后应释放一个座位')

  const departed = await store.depart(joined[0].id)
  assert.strictEqual(departed.status, 'DEPARTED', '叫车人应能确认已经出发')
  room = await store.getRoom('science_to_gangcheng')
  assert(!room.boards.some((board) => board.id === joined[0].id), '已经出发的车辆不能继续公开展示')

  const reservationAt = fakeNow + 31 * 60 * 1000
  login('reserve_user_1', '预约甲')
  const reservation = await store.createReservation(
    'science_to_gangcheng',
    'NORTH_GATE',
    reservationAt
  )
  assert.strictEqual(reservation.memberCount, 1, '发布预约后应记录一个意向用户')
  login('reserve_user_2', '预约乙')
  let reservations = await store.getReservations('science_to_gangcheng')
  assert.strictEqual(reservations.length, 1, '同方向用户应看到预约意向')
  await store.joinReservation(reservation.id)
  reservations = await store.getReservations('science_to_gangcheng')
  assert.strictEqual(reservations[0].memberCount, 2, '其他用户应能加入预约')
  assert.strictEqual(reservations[0].meetingGate, 'NORTH_GATE', '预约集合门应保存')
  login('reserve_user_3', '预约丙')
  await store.joinReservation(reservation.id)
  login('reserve_user_4', '预约丁')
  await store.joinReservation(reservation.id)
  login('reserve_user_5', '预约戊')
  const overflowReservation = await store.createReservation(
    'science_to_gangcheng',
    'NORTH_GATE',
    reservationAt
  )
  assert.notStrictEqual(overflowReservation.id, reservation.id, '四人满组后应为第五人新建预约组')
  reservations = await store.getReservations('science_to_gangcheng')
  assert.strictEqual(reservations.length, 2, '同一时段应允许存在多个四人预约组')
  assert.throws(
    () => store.createReservation('science_to_gangcheng', 'SOUTH_GATE', fakeNow + 29 * 60 * 1000),
    /至少要比现在晚30分钟/,
    '30分钟以内不能发布预约'
  )
  login('reserve_user_2', '预约乙')
  await store.leaveReservation(reservation.id)
  reservations = await store.getReservations('science_to_gangcheng')
  assert.strictEqual(reservations[0].memberCount, 3, '用户应能退出预约')

  login('timeout_user', '超时用户')
  const timeoutGroup = await store.createCarGroup(
    'science_to_gangcheng',
    '7Q9LM',
    'NORTH_GATE',
    '08:20'
  )
  fakeNow += 10 * 60 * 1000 + 1
  room = await store.getRoom('science_to_gangcheng')
  assert(!room.boards.some((board) => board.id === timeoutGroup.id), '已叫车组超过十分钟应自动过期')

  console.log('PINCAR LOCAL FLOW: PASS')
  console.log(JSON.stringify({
    firstFourSameGroup: true,
    fifthUserOpenedNewGroup: true,
    oppositeRoutesSeparated: true,
    rideGateAndTimeSaved: true,
    futureReservationsVisible: true,
    reservationGroupsLimitedToFour: true,
    reservationMinimumThirtyMinutes: true,
    dailyCodesUnique: [joined[0].code, joined[4].code, reverseGroup.code],
    convertedPlate: carGroup.plateTail,
    seatReleasedAfterLeave: afterLeave.memberCount,
    departedCarHidden: true,
    tenMinuteExpiry: true
  }, null, 2))
}

run().catch((error) => {
  console.error(error.stack)
  process.exit(1)
})
