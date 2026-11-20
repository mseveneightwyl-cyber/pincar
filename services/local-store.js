const config = require('../config')
const {
  GROUP_STATUS,
  WAITING_TTL_MS,
  CAR_TTL_MS,
  MAX_MEMBERS,
  getChinaDateKey
} = require('../utils/constants')

const STORAGE_KEY = 'pincar_state_v1'
const PROFILE_KEY = 'pincar_profile_v1'
const MEETING_GATES = new Set(['SOUTH_GATE', 'NORTH_GATE'])
const RESERVATION_MIN_AHEAD_MS = 30 * 60 * 1000
const RESERVATION_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000
const RESERVATION_EXPIRE_AFTER_MS = 30 * 60 * 1000
const RESERVATION_MAX_MEMBERS = 4

function nowMs() {
  return Date.now()
}

function makeId(prefix) {
  return `${prefix}_${nowMs()}_${Math.floor(Math.random() * 100000)}`
}

function getProfile() {
  const saved = wx.getStorageSync(PROFILE_KEY)
  if (saved && saved.id) return saved

  const profile = {
    id: makeId('local_user'),
    nickname: ''
  }
  wx.setStorageSync(PROFILE_KEY, profile)
  return profile
}

function saveProfile(nickname) {
  const profile = getProfile()
  profile.nickname = nickname.trim().slice(0, 12)
  wx.setStorageSync(PROFILE_KEY, profile)

  const state = loadState(false)
  state.groups.forEach((group) => {
    group.members.forEach((member) => {
      if (member.id === profile.id) member.nickname = profile.nickname
    })
  })
  ;(state.reservations || []).forEach((reservation) => {
    reservation.members.forEach((member) => {
      if (member.id === profile.id) member.nickname = profile.nickname
    })
  })
  saveState(state)
  return profile
}

function initialState() {
  return {
    version: 1,
    groups: [],
    reservations: [],
    usedCodes: {},
    demoSeedDate: ''
  }
}

function seedDemoGroups(state) {
  if (!config.demoSeedEnabled) return

  const today = getChinaDateKey(new Date())
  const activeDemo = state.groups.some((group) => (
    group.isDemo &&
    group.status === GROUP_STATUS.CAR_WAITING &&
    group.expiresAt > nowMs()
  ))

  if (state.demoSeedDate === today && activeDemo) return

  const createdAt = nowMs()
  const expiresAt = createdAt + CAR_TTL_MS
  const demoGroups = [
    {
      id: `demo_science_${createdAt}`,
      routeKey: 'science_to_gangcheng',
      status: GROUP_STATUS.CAR_WAITING,
      code: '4821',
      plateTail: '5M6CR',
      meetingGate: 'SOUTH_GATE',
      arrivalTime: '07:10',
      leaderId: 'demo_lin',
      members: [
        { id: 'demo_lin', nickname: '林晓', joinedAt: createdAt },
        { id: 'demo_chen', nickname: '陈一', joinedAt: createdAt }
      ],
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      isDemo: true
    },
    {
      id: `demo_gangcheng_${createdAt}`,
      routeKey: 'gangcheng_to_science',
      status: GROUP_STATUS.CAR_WAITING,
      code: '7358',
      plateTail: '8K2PA',
      meetingGate: 'NORTH_GATE',
      arrivalTime: '18:20',
      leaderId: 'demo_yu',
      members: [
        { id: 'demo_yu', nickname: '余乐', joinedAt: createdAt }
      ],
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      isDemo: true
    }
  ]

  state.groups = state.groups.filter((group) => !group.isDemo)
  state.groups.push(...demoGroups)
  state.demoSeedDate = today
  state.usedCodes[`${today}_4821`] = true
  state.usedCodes[`${today}_7358`] = true
}

function cleanup(state) {
  const current = nowMs()
  state.groups.forEach((group) => {
    if (
      [GROUP_STATUS.WAITING, GROUP_STATUS.CAR_WAITING, GROUP_STATUS.DEPARTED].includes(group.status) &&
      group.expiresAt <= current
    ) {
      group.status = GROUP_STATUS.EXPIRED
      group.updatedAt = current
    }
  })

  state.groups = state.groups.filter((group) => (
    group.status !== GROUP_STATUS.CLOSED || current - group.updatedAt < 24 * 60 * 60 * 1000
  ))
  ;(state.reservations || []).forEach((reservation) => {
    if (reservation.status === 'OPEN' && reservation.departureAt <= current) {
      reservation.status = 'EXPIRED'
      reservation.updatedAt = current
    }
  })
  state.reservations = (state.reservations || []).filter((reservation) => (
    reservation.status === 'OPEN' || current - reservation.updatedAt < 24 * 60 * 60 * 1000
  ))
}

function loadState(withSeed = true) {
  const saved = wx.getStorageSync(STORAGE_KEY)
  const state = saved && saved.version === 1 ? saved : initialState()
  if (!Array.isArray(state.reservations)) state.reservations = []
  cleanup(state)
  if (withSeed) seedDemoGroups(state)
  saveState(state)
  return state
}

function saveState(state) {
  wx.setStorageSync(STORAGE_KEY, state)
}

function getActiveGroup(state, userId) {
  return state.groups.find((group) => (
    [GROUP_STATUS.WAITING, GROUP_STATUS.CAR_WAITING, GROUP_STATUS.DEPARTED].includes(group.status) &&
    group.members.some((member) => member.id === userId)
  )) || null
}

function createCode(state) {
  const dateKey = getChinaDateKey(new Date())
  for (let index = 0; index < 100; index += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000))
    const codeKey = `${dateKey}_${code}`
    if (!state.usedCodes[codeKey]) {
      state.usedCodes[codeKey] = true
      return code
    }
  }
  throw new Error('暂时无法生成暗号，请稍后重试')
}

function validateMeetingGate(value) {
  if (!MEETING_GATES.has(value)) throw new Error('请选择南门或北门')
  return value
}

function validateClock(value) {
  const clock = String(value || '').trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('请选择预计时间')
  return clock
}

function validateDepartureAt(value, current) {
  const date = new Date(Number(value) || value)
  if (Number.isNaN(date.getTime())) throw new Error('预约日期或时间无效')
  date.setSeconds(0, 0)
  const ahead = date.getTime() - current
  if (ahead < RESERVATION_MIN_AHEAD_MS) throw new Error('预约时间至少要比现在晚30分钟')
  if (ahead > RESERVATION_MAX_AHEAD_MS) throw new Error('最多只能预约未来30天')
  return date.getTime()
}

function reservationId(routeKey, gate, departureAt, slotIndex) {
  return `slot_${routeKey}_${gate}_${departureAt}_${slotIndex}`
}

function publicBoard(group) {
  return {
    id: group.id,
    plateTail: group.plateTail,
    meetingGate: group.meetingGate || '',
    arrivalTime: group.arrivalTime || '',
    memberCount: group.members.length,
    maxMembers: MAX_MEMBERS,
    isFull: group.members.length >= MAX_MEMBERS,
    expiresAt: group.expiresAt
  }
}

function privateGroup(group, profile) {
  const remaining = Math.max(0, Math.ceil((group.expiresAt - nowMs()) / 1000))
  return {
    id: group.id,
    routeKey: group.routeKey,
    status: group.status,
    code: group.code,
    plateTail: group.plateTail || '',
    meetingGate: group.meetingGate || '',
    arrivalTime: group.arrivalTime || '',
    members: group.members.map((member) => ({
      nickname: member.nickname,
      isCurrentUser: member.id === profile.id,
      isLeader: member.id === group.leaderId
    })),
    memberCount: group.members.length,
    maxMembers: MAX_MEMBERS,
    isLeader: group.leaderId === profile.id,
    isMember: group.members.some((member) => member.id === profile.id),
    expiresAt: group.expiresAt,
    remainingSeconds: remaining
  }
}

function getRoom(routeKey) {
  const state = loadState()
  const profile = getProfile()
  const boards = state.groups
    .filter((group) => (
      group.routeKey === routeKey &&
      group.status === GROUP_STATUS.CAR_WAITING &&
      group.expiresAt > nowMs()
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(publicBoard)
  const active = getActiveGroup(state, profile.id)

  return Promise.resolve({
    boards,
    myGroup: active ? privateGroup(active, profile) : null,
    demoMode: true
  })
}

function getGroup(groupId) {
  const state = loadState()
  const profile = getProfile()
  const group = state.groups.find((item) => item.id === groupId)
  if (!group || !group.members.some((member) => member.id === profile.id)) {
    return Promise.resolve(null)
  }
  return Promise.resolve(privateGroup(group, profile))
}

function ensureCanJoin(state, profile) {
  const active = getActiveGroup(state, profile.id)
  if (active) {
    const error = new Error('你已经在一个队伍中')
    error.groupId = active.id
    throw error
  }
}

function joinWaiting(routeKey) {
  const state = loadState()
  const profile = getProfile()
  ensureCanJoin(state, profile)
  const current = nowMs()

  let group = state.groups.find((item) => (
    item.routeKey === routeKey &&
    item.status === GROUP_STATUS.WAITING &&
    item.expiresAt > current &&
    item.members.length < MAX_MEMBERS
  ))

  if (!group) {
    group = {
      id: makeId('waiting'),
      routeKey,
      status: GROUP_STATUS.WAITING,
      code: createCode(state),
      plateTail: '',
      meetingGate: '',
      arrivalTime: '',
      leaderId: '',
      members: [],
      createdAt: current,
      updatedAt: current,
      expiresAt: current + WAITING_TTL_MS,
      isDemo: false
    }
    state.groups.push(group)
  }

  group.members.push({ id: profile.id, nickname: profile.nickname, joinedAt: current })
  group.updatedAt = current
  group.expiresAt = current + WAITING_TTL_MS
  saveState(state)
  return Promise.resolve(privateGroup(group, profile))
}

function createCarGroup(routeKey, plateTail, meetingGate, arrivalTime) {
  const state = loadState()
  const profile = getProfile()
  ensureCanJoin(state, profile)
  validateMeetingGate(meetingGate)
  validateClock(arrivalTime)
  const current = nowMs()
  const group = {
    id: makeId('car'),
    routeKey,
    status: GROUP_STATUS.CAR_WAITING,
    code: createCode(state),
    plateTail,
    meetingGate,
    arrivalTime,
    leaderId: profile.id,
    members: [{ id: profile.id, nickname: profile.nickname, joinedAt: current }],
    createdAt: current,
    updatedAt: current,
    expiresAt: current + CAR_TTL_MS,
    isDemo: false
  }
  state.groups.push(group)
  saveState(state)
  return Promise.resolve(privateGroup(group, profile))
}

function submitPlate(groupId, plateTail, meetingGate, arrivalTime) {
  const state = loadState()
  const profile = getProfile()
  const group = state.groups.find((item) => item.id === groupId)
  if (!group || group.status !== GROUP_STATUS.WAITING) throw new Error('当前队伍不能填写车牌')
  if (!group.members.some((member) => member.id === profile.id)) throw new Error('你不在这个队伍中')
  validateMeetingGate(meetingGate)
  validateClock(arrivalTime)

  const current = nowMs()
  group.status = GROUP_STATUS.CAR_WAITING
  group.plateTail = plateTail
  group.meetingGate = meetingGate
  group.arrivalTime = arrivalTime
  group.leaderId = profile.id
  group.updatedAt = current
  group.expiresAt = current + CAR_TTL_MS
  saveState(state)
  return Promise.resolve(privateGroup(group, profile))
}

function joinCarGroup(groupId) {
  const state = loadState()
  const profile = getProfile()
  ensureCanJoin(state, profile)
  const group = state.groups.find((item) => item.id === groupId)
  if (!group || group.status !== GROUP_STATUS.CAR_WAITING || group.expiresAt <= nowMs()) {
    throw new Error('这辆车已经出发或过期')
  }
  if (group.members.length >= MAX_MEMBERS) throw new Error('这辆车已经满员')

  const current = nowMs()
  group.members.push({ id: profile.id, nickname: profile.nickname, joinedAt: current })
  group.updatedAt = current
  saveState(state)
  return Promise.resolve(privateGroup(group, profile))
}

function privateReservation(reservation, profile) {
  return {
    id: reservation.id,
    routeKey: reservation.routeKey,
    meetingGate: reservation.meetingGate,
    departureAt: reservation.departureAt,
    members: reservation.members.map((member) => ({
      nickname: member.nickname,
      isCurrentUser: member.id === profile.id
    })),
    memberCount: reservation.members.length,
    isJoined: reservation.members.some((member) => member.id === profile.id),
    isFull: reservation.members.length >= RESERVATION_MAX_MEMBERS
  }
}

function getReservations(routeKey) {
  const state = loadState()
  const profile = getProfile()
  const current = nowMs()
  const reservations = state.reservations
    .filter((item) => item.routeKey === routeKey && item.status === 'OPEN' && item.departureAt > current)
    .sort((a, b) => a.departureAt - b.departureAt)
    .slice(0, 50)
    .map((item) => privateReservation(item, profile))
  return Promise.resolve(reservations)
}

function createReservation(routeKey, meetingGate, departureAtValue) {
  const state = loadState()
  const profile = getProfile()
  const meetingGateValue = validateMeetingGate(meetingGate)
  const current = nowMs()
  const departureAt = validateDepartureAt(departureAtValue, current)
  const duplicate = state.reservations.some((item) => (
    item.routeKey === routeKey &&
    item.meetingGate === meetingGateValue &&
    item.departureAt === departureAt &&
    item.status === 'OPEN' &&
    item.members.some((member) => member.id === profile.id)
  ))
  if (duplicate) throw new Error('你已经加入这个预约')
  let reservation = state.reservations.find((item) => (
    item.routeKey === routeKey &&
    item.meetingGate === meetingGateValue &&
    item.departureAt === departureAt &&
    item.status === 'OPEN' &&
    item.members.length < RESERVATION_MAX_MEMBERS
  ))
  if (!reservation) {
    const slotIndex = state.reservations.filter((item) => (
      item.routeKey === routeKey &&
      item.meetingGate === meetingGateValue &&
      item.departureAt === departureAt
    )).length + 1
    const id = reservationId(routeKey, meetingGateValue, departureAt, slotIndex)
    reservation = {
      id,
      routeKey,
      meetingGate: meetingGateValue,
      departureAt,
      status: 'OPEN',
      members: [],
      createdAt: current,
      updatedAt: current,
      expiresAt: departureAt + RESERVATION_EXPIRE_AFTER_MS
    }
    state.reservations.push(reservation)
  }
  if (reservation.members.some((member) => member.id === profile.id)) throw new Error('你已经加入这个预约')
  if (reservation.members.length >= RESERVATION_MAX_MEMBERS) throw new Error('这个预约人数已满')
  reservation.members.push({ id: profile.id, nickname: profile.nickname, joinedAt: current })
  reservation.updatedAt = current
  saveState(state)
  return Promise.resolve(privateReservation(reservation, profile))
}

function joinReservation(reservationIdValue) {
  const state = loadState()
  const profile = getProfile()
  const current = nowMs()
  const reservation = state.reservations.find((item) => item.id === reservationIdValue)
  if (!reservation || reservation.status !== 'OPEN') throw new Error('这个预约已经结束')
  validateDepartureAt(reservation.departureAt, current)
  if (reservation.members.some((member) => member.id === profile.id)) throw new Error('你已经加入这个预约')
  if (reservation.members.length >= RESERVATION_MAX_MEMBERS) throw new Error('这个预约人数已满')
  reservation.members.push({ id: profile.id, nickname: profile.nickname, joinedAt: current })
  reservation.updatedAt = current
  saveState(state)
  return Promise.resolve(privateReservation(reservation, profile))
}

function leaveReservation(reservationIdValue) {
  const state = loadState()
  const profile = getProfile()
  const reservation = state.reservations.find((item) => item.id === reservationIdValue)
  if (!reservation || reservation.status !== 'OPEN') return Promise.resolve(null)
  reservation.members = reservation.members.filter((member) => member.id !== profile.id)
  reservation.updatedAt = nowMs()
  if (!reservation.members.length) reservation.status = 'CLOSED'
  saveState(state)
  return Promise.resolve(null)
}

function leaveGroup(groupId) {
  const state = loadState()
  const profile = getProfile()
  const group = state.groups.find((item) => item.id === groupId)
  if (!group) return Promise.resolve(null)
  const memberIndex = group.members.findIndex((member) => member.id === profile.id)
  if (memberIndex < 0) return Promise.resolve(null)

  const current = nowMs()
  if (group.status === GROUP_STATUS.CAR_WAITING && group.leaderId === profile.id) {
    group.status = GROUP_STATUS.CLOSED
  } else {
    group.members.splice(memberIndex, 1)
    if (!group.members.length) {
      group.status = GROUP_STATUS.CLOSED
    }
  }
  group.updatedAt = current
  saveState(state)
  return Promise.resolve(null)
}

function depart(groupId) {
  const state = loadState()
  const profile = getProfile()
  const group = state.groups.find((item) => item.id === groupId)
  if (!group || group.status !== GROUP_STATUS.CAR_WAITING) throw new Error('当前车辆不能执行此操作')
  if (group.leaderId !== profile.id) throw new Error('只有叫车人可以确认出发')

  group.status = GROUP_STATUS.DEPARTED
  group.updatedAt = nowMs()
  group.expiresAt = nowMs() + CAR_TTL_MS
  saveState(state)
  return Promise.resolve(privateGroup(group, profile))
}

function finish(groupId) {
  const state = loadState()
  const profile = getProfile()
  const group = state.groups.find((item) => item.id === groupId)
  if (!group) return Promise.resolve(null)
  group.members = group.members.filter((member) => member.id !== profile.id)
  if (!group.members.length) {
    group.status = GROUP_STATUS.CLOSED
  }
  group.updatedAt = nowMs()
  saveState(state)
  return Promise.resolve(null)
}

function watchRoom(routeKey, callback) {
  let stopped = false
  const emit = () => {
    if (stopped) return
    getRoom(routeKey).then(callback).catch(() => {})
  }
  emit()
  const timer = setInterval(emit, 3000)
  return {
    close() {
      stopped = true
      clearInterval(timer)
    }
  }
}

module.exports = {
  getProfile,
  saveProfile,
  getRoom,
  getGroup,
  joinWaiting,
  createCarGroup,
  submitPlate,
  joinCarGroup,
  getReservations,
  createReservation,
  joinReservation,
  leaveReservation,
  leaveGroup,
  depart,
  finish,
  watchRoom
}
