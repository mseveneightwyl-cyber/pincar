const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const GROUP_STATUS = {
  WAITING: 'WAITING',
  CAR_WAITING: 'CAR_WAITING',
  DEPARTED: 'DEPARTED',
  CLOSED: 'CLOSED',
  EXPIRED: 'EXPIRED'
}

const RESERVATION_STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  EXPIRED: 'EXPIRED'
}

const ROUTE_KEYS = new Set(['science_to_gangcheng', 'gangcheng_to_science'])
const MEETING_GATES = new Set(['SOUTH_GATE', 'NORTH_GATE'])
const WAITING_TTL_MS = 30 * 60 * 1000
const CAR_TTL_MS = 10 * 60 * 1000
const MAX_MEMBERS = 4
const RESERVATION_MIN_AHEAD_MS = 30 * 60 * 1000
const RESERVATION_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000
const RESERVATION_EXPIRE_AFTER_MS = 30 * 60 * 1000
const RESERVATION_MAX_MEMBERS = 4
const MAX_ACTIVE_RESERVATIONS = 6
const EXPECTED_APPID = process.env.PINCAR_APP_ID
const RATE_WINDOW_MS = 60 * 1000
const TOTAL_REQUESTS_PER_WINDOW = 45
const ACTION_RATE_LIMITS = {
  saveProfile: 5,
  getRoom: 20,
  getGroup: 24,
  joinWaiting: 6,
  createCarGroup: 5,
  submitPlate: 5,
  joinCarGroup: 8,
  getReservations: 12,
  createReservation: 6,
  joinReservation: 8,
  leaveReservation: 8,
  leaveGroup: 6,
  depart: 5,
  finish: 5
}

class BusinessError extends Error {
  constructor(message, data) {
    super(message)
    this.data = data || null
  }
}

function now() {
  return new Date()
}

function addMilliseconds(date, milliseconds) {
  return new Date(date.getTime() + milliseconds)
}

function chinaDateKey(date) {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return chinaTime.toISOString().slice(0, 10).replace(/-/g, '')
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
}

function documentId(document) {
  return document && (document._id || document.id)
}

function documentData(document) {
  const data = { ...document }
  delete data._id
  return data
}

function cursorGroupIds(cursor) {
  if (!cursor) return []
  if (Array.isArray(cursor.waitingGroupIds)) return cursor.waitingGroupIds.filter(Boolean)
  return cursor.waitingGroupId ? [cursor.waitingGroupId] : []
}

function cursorData(groupIds, currentTime) {
  return {
    waitingGroupIds: [...new Set(groupIds.filter(Boolean))].slice(0, 40),
    waitingGroupId: '',
    updatedAt: currentTime
  }
}

function normalizeNickname(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12)
}

function validateNickname(nickname) {
  if (!nickname) throw new BusinessError('请填写昵称')
  if (!/^[\u4e00-\u9fffA-Za-z0-9_\-\u00b7 ]{1,12}$/.test(nickname)) {
    throw new BusinessError('昵称仅支持中文、字母、数字和常用符号')
  }
}

function normalizePlate(value) {
  return String(value || '').trim().toUpperCase()
}

function validateRoute(routeKey) {
  if (!ROUTE_KEYS.has(routeKey)) throw new BusinessError('通勤方向无效')
}

function validateMeetingGate(value) {
  const gate = String(value || '')
  if (!MEETING_GATES.has(gate)) throw new BusinessError('请选择南门或北门')
  return gate
}

function validateClock(value) {
  const clock = String(value || '').trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new BusinessError('请选择预计时间')
  return clock
}

function validateDepartureAt(value, currentTime) {
  const numericValue = typeof value === 'number' ? value : Number(value)
  const date = new Date(Number.isFinite(numericValue) && numericValue > 0 ? numericValue : value)
  if (Number.isNaN(date.getTime())) throw new BusinessError('预约日期或时间无效')
  date.setSeconds(0, 0)
  const ahead = date.getTime() - currentTime.getTime()
  if (ahead < RESERVATION_MIN_AHEAD_MS) throw new BusinessError('预约时间至少要比现在晚30分钟')
  if (ahead > RESERVATION_MAX_AHEAD_MS) throw new BusinessError('最多只能预约未来30天')
  return date
}

function reservationId(routeKey, gate, departureAt, slotIndex) {
  return `slot_${routeKey}_${gate}_${departureAt.getTime()}_${slotIndex}`
}

function validatePlate(plateTail) {
  if (!/^[A-Z0-9]{5,6}$/.test(plateTail)) {
    throw new BusinessError('请输入5–6位车牌尾号')
  }
}

function validateGroupId(value) {
  const id = String(value || '')
  if (!/^(waiting|car)_[0-9]{13}_(?:[a-z0-9]{8}|[a-f0-9]{12})$/.test(id)) {
    throw new BusinessError('队伍信息无效')
  }
  return id
}

function validateReservationId(value) {
  const id = String(value || '')
  if (!/^slot_(science_to_gangcheng|gangcheng_to_science)_(SOUTH_GATE|NORTH_GATE)_[0-9]{13}_(?:[1-9]|1[0-9]|2[0-5])$/.test(id)) {
    throw new BusinessError('预约信息无效')
  }
  return id
}

function isActive(group, currentTime) {
  if (!group) return false
  if (![GROUP_STATUS.WAITING, GROUP_STATUS.CAR_WAITING, GROUP_STATUS.DEPARTED].includes(group.status)) return false
  return new Date(group.expiresAt).getTime() > currentTime.getTime()
}

async function safeGet(ref) {
  try {
    const result = await ref.get()
    return result.data || null
  } catch (error) {
    const message = String(error.message || error.errMsg || '')
    if (error.errCode === -1 || /not exist|not found|不存在/i.test(message)) return null
    throw error
  }
}

function nextRateState(previous, action, currentTime) {
  const actionLimit = ACTION_RATE_LIMITS[action]
  if (!actionLimit) throw new BusinessError('未知操作')
  const sameWindow = previous &&
    Number(previous.windowStartedAt) > 0 &&
    currentTime - Number(previous.windowStartedAt) < RATE_WINDOW_MS
  const total = sameWindow ? Number(previous.total || 0) : 0
  const actions = sameWindow && previous.actions && typeof previous.actions === 'object'
    ? previous.actions
    : {}
  const actionCount = Number(actions[action] || 0)

  if (total >= TOTAL_REQUESTS_PER_WINDOW || actionCount >= actionLimit) {
    throw new BusinessError('操作太频繁，请稍后再试')
  }

  return {
    windowStartedAt: sameWindow ? Number(previous.windowStartedAt) : currentTime,
    total: total + 1,
    actions: { ...actions, [action]: actionCount + 1 }
  }
}

async function enforceRateLimit(openid, action) {
  const currentTime = Date.now()

  await db.runTransaction(async (transaction) => {
    const userRef = transaction.collection('users').doc(openid)
    const user = await safeGet(userRef)
    const previous = user && user._requestRate && Number(user._requestRate.windowStartedAt) > 0
      ? user._requestRate
      : null
    await userRef.set({
      data: {
        ...(user ? documentData(user) : {}),
        _requestRate: nextRateState(previous, action, currentTime)
      }
    })
  })
}

async function ensureNicknameIsSafe(openid, nickname) {
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      content: nickname,
      openid,
      scene: 1,
      version: 2
    })
    const suggestion = result && result.result && result.result.suggest
    if (suggestion !== 'pass') {
      throw new BusinessError('昵称未通过内容安全检查')
    }
    return 'wechat'
  } catch (error) {
    if (error instanceof BusinessError) throw error
    const errorCode = Number(
      error && (
        error.errCode ||
        error.errcode ||
        (error.error && (error.error.errCode || error.error.errcode))
      )
    )
    // 微信有时会通过异常返回“内容违规”，这种情况仍必须拦截。
    if (errorCode === 87014) {
      throw new BusinessError('昵称未通过内容安全检查')
    }
    // 上游内容安全服务暂时不可用时，不应让所有新用户都无法进入。
    // 昵称在此之前已经过长度、字符白名单和控制字符过滤。
    console.warn('[PINCAR] nickname security check degraded', errorCode || (error && error.message))
    return 'local_fallback'
  }
}

async function requireProfile(openid) {
  const profile = await safeGet(db.collection('users').doc(openid))
  if (!profile || !profile.nickname) throw new BusinessError('请先填写昵称')
  return profile
}

function memberFor(openid, nickname, joinedAt) {
  return { openid, nickname, joinedAt }
}

function boardFromGroup(group) {
  return {
    routeKey: group.routeKey,
    status: group.status,
    plateTail: group.plateTail,
    meetingGate: group.meetingGate || '',
    arrivalTime: group.arrivalTime || '',
    memberCount: group.members.length,
    maxMembers: MAX_MEMBERS,
    expiresAt: group.expiresAt,
    updatedAt: group.updatedAt
  }
}

function redactGroup(group) {
  group.code = ''
  group.plateTail = ''
  group.meetingGate = ''
  group.arrivalTime = ''
  group.leaderOpenid = ''
  group.members = []
  return group
}

function sanitizeBoard(board) {
  return {
    id: board._id,
    plateTail: board.plateTail,
    meetingGate: board.meetingGate || '',
    arrivalTime: board.arrivalTime || '',
    memberCount: board.memberCount,
    maxMembers: board.maxMembers || MAX_MEMBERS,
    isFull: board.memberCount >= (board.maxMembers || MAX_MEMBERS),
    expiresAt: board.expiresAt
  }
}

function sanitizeGroup(group, openid) {
  const belongs = group.members.some((member) => member.openid === openid)
  if (!belongs) throw new BusinessError('你不在这个队伍中')
  return {
    id: documentId(group),
    routeKey: group.routeKey,
    status: group.status,
    code: group.code,
    plateTail: group.plateTail || '',
    meetingGate: group.meetingGate || '',
    arrivalTime: group.arrivalTime || '',
    members: group.members.map((member) => ({
      nickname: member.nickname,
      isCurrentUser: member.openid === openid,
      isLeader: member.openid === group.leaderOpenid
    })),
    memberCount: group.members.length,
    maxMembers: MAX_MEMBERS,
    isLeader: group.leaderOpenid === openid,
    isMember: belongs,
    expiresAt: group.expiresAt
  }
}

async function reserveCode(transaction, groupId, currentTime) {
  const dateKey = chinaDateKey(currentTime)
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000))
    const codeId = `${dateKey}_${code}`
    const codeRef = transaction.collection('daily_codes').doc(codeId)
    const existing = await safeGet(codeRef)
    if (!existing) {
      await codeRef.set({
        data: {
          code,
          dateKey,
          groupId,
          createdAt: currentTime
        }
      })
      return code
    }
  }
  throw new BusinessError('暂时无法生成暗号，请稍后重试')
}

async function activeMembershipInTransaction(transaction, openid, currentTime) {
  const membershipRef = transaction.collection('memberships').doc(openid)
  const membership = await safeGet(membershipRef)
  if (!membership || !membership.active || !membership.groupId) return null

  const group = await safeGet(transaction.collection('groups').doc(membership.groupId))
  if (isActive(group, currentTime) && group.members.some((member) => member.openid === openid)) {
    return { membership, group }
  }

  await membershipRef.set({
    data: {
      active: false,
      groupId: '',
      routeKey: '',
      updatedAt: currentTime
    }
  })
  return null
}

async function closeGroup(groupId, finalStatus) {
  return db.runTransaction(async (transaction) => {
    const groupRef = transaction.collection('groups').doc(groupId)
    const group = await safeGet(groupRef)
    if (!group) return null
    if ([GROUP_STATUS.CLOSED, GROUP_STATUS.EXPIRED].includes(group.status)) return group

    const currentTime = now()
    const previousStatus = group.status
    group.status = finalStatus
    group.updatedAt = currentTime
    group.expiresAt = currentTime
    const members = [...group.members]
    for (const member of members) {
      await transaction.collection('memberships').doc(member.openid).set({
        data: {
          active: false,
          groupId: '',
          routeKey: '',
          updatedAt: currentTime
        }
      })
    }

    if (group.plateTail) {
      await transaction.collection('room_boards').doc(groupId).set({
        data: {
          routeKey: group.routeKey,
          status: finalStatus,
          plateTail: '',
          meetingGate: '',
          arrivalTime: '',
          memberCount: 0,
          maxMembers: MAX_MEMBERS,
          expiresAt: currentTime,
          updatedAt: currentTime
        }
      })
    }

    if (previousStatus === GROUP_STATUS.WAITING) {
      const cursorRef = transaction.collection('room_cursors').doc(group.routeKey)
      const cursor = await safeGet(cursorRef)
      const remainingIds = cursorGroupIds(cursor).filter((id) => id !== groupId)
      if (cursor && remainingIds.length !== cursorGroupIds(cursor).length) {
        await cursorRef.set({ data: cursorData(remainingIds, currentTime) })
      }
    }
    redactGroup(group)
    await groupRef.set({ data: documentData(group) })
    return group
  })
}

async function cleanupExpired(routeKey) {
  const currentTime = now()
  const result = await db.collection('groups')
    .where({
      routeKey,
      status: _.in([GROUP_STATUS.WAITING, GROUP_STATUS.CAR_WAITING, GROUP_STATUS.DEPARTED]),
      expiresAt: _.lte(currentTime)
    })
    .limit(20)
    .get()

  for (const group of result.data || []) {
    await closeGroup(group._id, GROUP_STATUS.EXPIRED)
  }
}

async function saveProfile(openid, event) {
  const nickname = normalizeNickname(event.nickname)
  validateNickname(nickname)
  const existing = await safeGet(db.collection('users').doc(openid))
  if (existing && existing.nickname === nickname) return { nickname }
  const nicknameSafetyMode = await ensureNicknameIsSafe(openid, nickname)
  const currentTime = now()
  await db.collection('users').doc(openid).set({
    data: {
      ...(existing ? documentData(existing) : {}),
      nickname,
      nicknameSafetyMode,
      nicknameCheckedAt: currentTime,
      updatedAt: currentTime
    }
  })
  return { nickname }
}

async function getRoom(openid, event) {
  validateRoute(event.routeKey)
  await requireProfile(openid)
  await cleanupExpired(event.routeKey)
  const currentTime = now()
  const boardsResult = await db.collection('room_boards')
    .where({
      routeKey: event.routeKey,
      status: GROUP_STATUS.CAR_WAITING,
      expiresAt: _.gt(currentTime)
    })
    .orderBy('updatedAt', 'desc')
    .limit(50)
    .get()

  let myGroup = null
  const membership = await safeGet(db.collection('memberships').doc(openid))
  if (membership && membership.active && membership.groupId) {
    const group = await safeGet(db.collection('groups').doc(membership.groupId))
    if (isActive(group, currentTime) && group.members.some((member) => member.openid === openid)) {
      myGroup = sanitizeGroup(group, openid)
    } else {
      await db.collection('memberships').doc(openid).set({
        data: { active: false, groupId: '', routeKey: '', updatedAt: currentTime }
      })
    }
  }

  return {
    boards: (boardsResult.data || []).map(sanitizeBoard),
    myGroup,
    demoMode: false
  }
}

async function getGroup(openid, event) {
  const groupId = validateGroupId(event.groupId)
  const group = await safeGet(db.collection('groups').doc(groupId))
  if (!group) return null
  const currentTime = now()
  if (!isActive(group, currentTime)) {
    if (![GROUP_STATUS.CLOSED, GROUP_STATUS.EXPIRED].includes(group.status)) {
      await closeGroup(group._id, GROUP_STATUS.EXPIRED)
    }
    return null
  }
  return sanitizeGroup(group, openid)
}

async function joinWaiting(openid, event) {
  validateRoute(event.routeKey)
  const profile = await requireProfile(openid)
  const currentTime = now()

  const group = await db.runTransaction(async (transaction) => {
    const active = await activeMembershipInTransaction(transaction, openid, currentTime)
    if (active) throw new BusinessError('你已经在一个队伍中', { groupId: documentId(active.group) })

    const cursorRef = transaction.collection('room_cursors').doc(event.routeKey)
    const cursor = await safeGet(cursorRef)
    const knownIds = cursorGroupIds(cursor)
    const availableIds = []
    let target = null

    for (const groupId of knownIds) {
      const candidate = await safeGet(transaction.collection('groups').doc(groupId))
      if (
        isActive(candidate, currentTime) &&
        candidate.status === GROUP_STATUS.WAITING &&
        candidate.members.length < MAX_MEMBERS
      ) {
        availableIds.push(groupId)
        if (!target) target = candidate
      }
    }

    if (!target) {
      const groupId = randomId('waiting')
      target = {
        id: groupId,
        routeKey: event.routeKey,
        status: GROUP_STATUS.WAITING,
        code: await reserveCode(transaction, groupId, currentTime),
        plateTail: '',
        meetingGate: '',
        arrivalTime: '',
        leaderOpenid: '',
        members: [],
        createdAt: currentTime,
        updatedAt: currentTime,
        expiresAt: addMilliseconds(currentTime, WAITING_TTL_MS)
      }
      availableIds.push(groupId)
    }

    target.members.push(memberFor(openid, profile.nickname, currentTime))
    target.updatedAt = currentTime
    target.expiresAt = addMilliseconds(currentTime, WAITING_TTL_MS)
    const targetId = documentId(target)
    await transaction.collection('groups').doc(targetId).set({ data: documentData(target) })
    await transaction.collection('memberships').doc(openid).set({
      data: {
        active: true,
        groupId: targetId,
        routeKey: target.routeKey,
        updatedAt: currentTime
      }
    })
    const nextIds = target.members.length >= MAX_MEMBERS
      ? availableIds.filter((id) => id !== targetId)
      : availableIds
    await cursorRef.set({ data: cursorData(nextIds, currentTime) })
    return target
  })

  return sanitizeGroup(group, openid)
}

async function createCarGroup(openid, event) {
  validateRoute(event.routeKey)
  const plateTail = normalizePlate(event.plateTail)
  validatePlate(plateTail)
  const meetingGate = validateMeetingGate(event.meetingGate)
  const arrivalTime = validateClock(event.arrivalTime)
  const profile = await requireProfile(openid)
  const currentTime = now()

  const group = await db.runTransaction(async (transaction) => {
    const active = await activeMembershipInTransaction(transaction, openid, currentTime)
    if (active) throw new BusinessError('你已经在一个队伍中', { groupId: documentId(active.group) })

    const groupId = randomId('car')
    const created = {
      id: groupId,
      routeKey: event.routeKey,
      status: GROUP_STATUS.CAR_WAITING,
      code: await reserveCode(transaction, groupId, currentTime),
      plateTail,
      meetingGate,
      arrivalTime,
      leaderOpenid: openid,
      members: [memberFor(openid, profile.nickname, currentTime)],
      createdAt: currentTime,
      updatedAt: currentTime,
      expiresAt: addMilliseconds(currentTime, CAR_TTL_MS)
    }
    await transaction.collection('groups').doc(groupId).set({ data: created })
    await transaction.collection('memberships').doc(openid).set({
      data: { active: true, groupId, routeKey: event.routeKey, updatedAt: currentTime }
    })
    await transaction.collection('room_boards').doc(groupId).set({ data: boardFromGroup(created) })
    return created
  })

  return sanitizeGroup(group, openid)
}

async function submitPlate(openid, event) {
  const groupId = validateGroupId(event.groupId)
  const plateTail = normalizePlate(event.plateTail)
  validatePlate(plateTail)
  const meetingGate = validateMeetingGate(event.meetingGate)
  const arrivalTime = validateClock(event.arrivalTime)
  const currentTime = now()

  const group = await db.runTransaction(async (transaction) => {
    const groupRef = transaction.collection('groups').doc(groupId)
    const target = await safeGet(groupRef)
    if (!target || target.status !== GROUP_STATUS.WAITING || !isActive(target, currentTime)) {
      throw new BusinessError('当前队伍不能填写车牌')
    }
    if (!target.members.some((member) => member.openid === openid)) {
      throw new BusinessError('你不在这个队伍中')
    }

    target.status = GROUP_STATUS.CAR_WAITING
    target.plateTail = plateTail
    target.meetingGate = meetingGate
    target.arrivalTime = arrivalTime
    target.leaderOpenid = openid
    target.updatedAt = currentTime
    target.expiresAt = addMilliseconds(currentTime, CAR_TTL_MS)
    await groupRef.set({ data: documentData(target) })
    const targetId = documentId(target)
    await transaction.collection('room_boards').doc(targetId).set({ data: boardFromGroup(target) })

    const cursorRef = transaction.collection('room_cursors').doc(target.routeKey)
    const cursor = await safeGet(cursorRef)
    const nextIds = cursorGroupIds(cursor).filter((id) => id !== targetId)
    if (cursor) {
      await cursorRef.set({ data: cursorData(nextIds, currentTime) })
    }
    return target
  })

  return sanitizeGroup(group, openid)
}

async function joinCarGroup(openid, event) {
  const groupId = validateGroupId(event.groupId)
  const profile = await requireProfile(openid)
  const currentTime = now()

  const group = await db.runTransaction(async (transaction) => {
    const active = await activeMembershipInTransaction(transaction, openid, currentTime)
    if (active) throw new BusinessError('你已经在一个队伍中', { groupId: documentId(active.group) })

    const groupRef = transaction.collection('groups').doc(groupId)
    const target = await safeGet(groupRef)
    if (!target || target.status !== GROUP_STATUS.CAR_WAITING || !isActive(target, currentTime)) {
      throw new BusinessError('这辆车已经出发或过期')
    }
    if (target.members.length >= MAX_MEMBERS) throw new BusinessError('这辆车已经满员')

    target.members.push(memberFor(openid, profile.nickname, currentTime))
    target.updatedAt = currentTime
    await groupRef.set({ data: documentData(target) })
    const targetId = documentId(target)
    await transaction.collection('memberships').doc(openid).set({
      data: { active: true, groupId: targetId, routeKey: target.routeKey, updatedAt: currentTime }
    })
    await transaction.collection('room_boards').doc(targetId).set({ data: boardFromGroup(target) })
    return target
  })

  return sanitizeGroup(group, openid)
}

function sanitizeReservation(reservation, openid) {
  const members = Array.isArray(reservation.members) ? reservation.members : []
  return {
    id: documentId(reservation),
    routeKey: reservation.routeKey,
    meetingGate: reservation.meetingGate,
    departureAt: reservation.departureAt,
    members: members.map((member) => ({
      nickname: member.nickname,
      isCurrentUser: member.openid === openid
    })),
    memberCount: members.length,
    isJoined: members.some((member) => member.openid === openid),
    isFull: members.length >= RESERVATION_MAX_MEMBERS
  }
}

async function cleanupReservations(routeKey) {
  const currentTime = now()
  const result = await db.collection('reservations')
    .where({
      routeKey,
      status: RESERVATION_STATUS.OPEN,
      departureAt: _.lte(currentTime)
    })
    .limit(20)
    .get()
  for (const reservation of result.data || []) {
    await db.collection('reservations').doc(reservation._id).update({
      data: {
        status: RESERVATION_STATUS.EXPIRED,
        members: [],
        updatedAt: currentTime
      }
    })
  }
}

function storedReservationIds(user) {
  if (!user || !Array.isArray(user.activeReservationIds)) return []
  return [...new Set(user.activeReservationIds.filter((id) => (
    typeof id === 'string' && id.length <= 160 && id.startsWith('slot_')
  )))].slice(0, MAX_ACTIVE_RESERVATIONS)
}

async function activeReservationIdsInTransaction(transaction, user, openid, currentTime) {
  const activeIds = []
  for (const reservationId of storedReservationIds(user)) {
    const reservation = await safeGet(transaction.collection('reservations').doc(reservationId))
    if (
      reservation &&
      reservation.status === RESERVATION_STATUS.OPEN &&
      new Date(reservation.departureAt).getTime() > currentTime.getTime() &&
      Array.isArray(reservation.members) &&
      reservation.members.some((member) => member.openid === openid)
    ) {
      activeIds.push(reservationId)
    }
  }
  return activeIds
}

async function getReservations(openid, event) {
  validateRoute(event.routeKey)
  await requireProfile(openid)
  await cleanupReservations(event.routeKey)
  const currentTime = now()
  const result = await db.collection('reservations')
    .where({
      routeKey: event.routeKey,
      status: RESERVATION_STATUS.OPEN,
      departureAt: _.gt(currentTime)
    })
    .orderBy('departureAt', 'asc')
    .limit(50)
    .get()
  return (result.data || []).map((item) => sanitizeReservation(item, openid))
}

async function createReservation(openid, event) {
  validateRoute(event.routeKey)
  const meetingGate = validateMeetingGate(event.meetingGate)
  await requireProfile(openid)
  const currentTime = now()
  const departureAt = validateDepartureAt(event.departureAt, currentTime)

  const reservation = await db.runTransaction(async (transaction) => {
    const userRef = transaction.collection('users').doc(openid)
    const user = await safeGet(userRef)
    if (!user || !user.nickname) throw new BusinessError('请先填写昵称')
    const activeReservationIds = await activeReservationIdsInTransaction(transaction, user, openid, currentTime)
    if (activeReservationIds.length >= MAX_ACTIVE_RESERVATIONS) {
      throw new BusinessError(`每人最多同时保留${MAX_ACTIVE_RESERVATIONS}个预约`)
    }
    let target = null
    let targetRef = null
    for (let slotIndex = 1; slotIndex <= 25; slotIndex += 1) {
      const slotId = reservationId(event.routeKey, meetingGate, departureAt, slotIndex)
      const ref = transaction.collection('reservations').doc(slotId)
      const candidate = await safeGet(ref)
      if (!candidate || candidate.status !== RESERVATION_STATUS.OPEN) {
        targetRef = ref
        target = {
          id: slotId,
          routeKey: event.routeKey,
          meetingGate,
          departureAt,
          status: RESERVATION_STATUS.OPEN,
          members: [],
          createdAt: currentTime,
          updatedAt: currentTime,
          expiresAt: addMilliseconds(departureAt, RESERVATION_EXPIRE_AFTER_MS)
        }
        break
      }
      if (candidate.members.some((member) => member.openid === openid)) {
        throw new BusinessError('你已经加入这个预约')
      }
      if (candidate.members.length < RESERVATION_MAX_MEMBERS) {
        targetRef = ref
        target = candidate
        break
      }
    }
    if (!target || !targetRef) throw new BusinessError('这个时段预约人数过多，请选择相邻时间')
    if (target.members.some((member) => member.openid === openid)) {
      throw new BusinessError('你已经加入这个预约')
    }
    if (target.members.length >= RESERVATION_MAX_MEMBERS) throw new BusinessError('这个预约人数已满')
    target.members.push(memberFor(openid, user.nickname, currentTime))
    target.updatedAt = currentTime
    await targetRef.set({ data: documentData(target) })
    await userRef.set({
      data: {
        ...documentData(user),
        activeReservationIds: [...activeReservationIds, documentId(target)]
      }
    })
    return target
  })
  return sanitizeReservation(reservation, openid)
}

async function joinReservation(openid, event) {
  const reservationId = validateReservationId(event.reservationId)
  await requireProfile(openid)
  const currentTime = now()
  const reservation = await db.runTransaction(async (transaction) => {
    const userRef = transaction.collection('users').doc(openid)
    const user = await safeGet(userRef)
    if (!user || !user.nickname) throw new BusinessError('请先填写昵称')
    const activeReservationIds = await activeReservationIdsInTransaction(transaction, user, openid, currentTime)
    if (activeReservationIds.length >= MAX_ACTIVE_RESERVATIONS) {
      throw new BusinessError(`每人最多同时保留${MAX_ACTIVE_RESERVATIONS}个预约`)
    }
    const ref = transaction.collection('reservations').doc(reservationId)
    const target = await safeGet(ref)
    if (!target || target.status !== RESERVATION_STATUS.OPEN) throw new BusinessError('这个预约已经结束')
    validateDepartureAt(target.departureAt, currentTime)
    if (target.members.some((member) => member.openid === openid)) {
      throw new BusinessError('你已经加入这个预约')
    }
    if (target.members.length >= RESERVATION_MAX_MEMBERS) throw new BusinessError('这个预约人数已满')
    target.members.push(memberFor(openid, user.nickname, currentTime))
    target.updatedAt = currentTime
    await ref.set({ data: documentData(target) })
    await userRef.set({
      data: {
        ...documentData(user),
        activeReservationIds: [...activeReservationIds, reservationId]
      }
    })
    return target
  })
  return sanitizeReservation(reservation, openid)
}

async function leaveReservation(openid, event) {
  const reservationId = validateReservationId(event.reservationId)
  const currentTime = now()
  await db.runTransaction(async (transaction) => {
    const userRef = transaction.collection('users').doc(openid)
    const user = await safeGet(userRef)
    const ref = transaction.collection('reservations').doc(reservationId)
    const target = await safeGet(ref)
    if (!target || target.status !== RESERVATION_STATUS.OPEN) return null
    const nextMembers = target.members.filter((member) => member.openid !== openid)
    if (nextMembers.length === target.members.length) return null
    target.members = nextMembers
    target.updatedAt = currentTime
    if (!target.members.length) target.status = RESERVATION_STATUS.CLOSED
    await ref.set({ data: documentData(target) })
    if (user) {
      await userRef.set({
        data: {
          ...documentData(user),
          activeReservationIds: storedReservationIds(user).filter((id) => id !== reservationId)
        }
      })
    }
    return null
  })
  return null
}

async function leaveGroup(openid, event) {
  const groupId = validateGroupId(event.groupId)
  const currentTime = now()
  await db.runTransaction(async (transaction) => {
    const groupRef = transaction.collection('groups').doc(groupId)
    const target = await safeGet(groupRef)
    if (!target) return null
    const memberIndex = target.members.findIndex((member) => member.openid === openid)
    if (memberIndex < 0) return null

    const leaderClosesCar = target.status === GROUP_STATUS.CAR_WAITING && target.leaderOpenid === openid
    if (leaderClosesCar) {
      target.status = GROUP_STATUS.CLOSED
      target.updatedAt = currentTime
      target.expiresAt = currentTime
      for (const member of target.members) {
        await transaction.collection('memberships').doc(member.openid).set({
          data: { active: false, groupId: '', routeKey: '', updatedAt: currentTime }
        })
      }
      await transaction.collection('room_boards').doc(documentId(target)).set({
        data: {
          routeKey: target.routeKey,
          status: GROUP_STATUS.CLOSED,
          plateTail: '',
          meetingGate: '',
          arrivalTime: '',
          memberCount: 0,
          maxMembers: MAX_MEMBERS,
          expiresAt: currentTime,
          updatedAt: currentTime
        }
      })
    } else {
      target.members.splice(memberIndex, 1)
      target.updatedAt = currentTime
      await transaction.collection('memberships').doc(openid).set({
        data: { active: false, groupId: '', routeKey: '', updatedAt: currentTime }
      })

      if (!target.members.length) {
        target.status = GROUP_STATUS.CLOSED
        target.expiresAt = currentTime
      } else if (target.status === GROUP_STATUS.WAITING) {
        target.expiresAt = addMilliseconds(currentTime, WAITING_TTL_MS)
      }

      if (target.plateTail) {
        await transaction.collection('room_boards').doc(documentId(target)).set({ data: boardFromGroup(target) })
      }
    }

    if ([GROUP_STATUS.CLOSED, GROUP_STATUS.EXPIRED].includes(target.status)) redactGroup(target)
    await groupRef.set({ data: documentData(target) })

    if (target.status === GROUP_STATUS.WAITING || target.status === GROUP_STATUS.CLOSED) {
      const cursorRef = transaction.collection('room_cursors').doc(target.routeKey)
      const cursor = await safeGet(cursorRef)
      const targetId = documentId(target)
      let nextIds = cursorGroupIds(cursor).filter((id) => id !== targetId)
      if (target.status === GROUP_STATUS.WAITING && target.members.length < MAX_MEMBERS) {
        nextIds = [targetId, ...nextIds]
      }
      await cursorRef.set({ data: cursorData(nextIds, currentTime) })
    }
    return null
  })
  return null
}

async function depart(openid, event) {
  const groupId = validateGroupId(event.groupId)
  const currentTime = now()
  const group = await db.runTransaction(async (transaction) => {
    const groupRef = transaction.collection('groups').doc(groupId)
    const target = await safeGet(groupRef)
    if (!target || target.status !== GROUP_STATUS.CAR_WAITING || !isActive(target, currentTime)) {
      throw new BusinessError('当前车辆不能执行此操作')
    }
    if (target.leaderOpenid !== openid) throw new BusinessError('只有叫车人可以确认出发')

    target.status = GROUP_STATUS.DEPARTED
    target.updatedAt = currentTime
    target.expiresAt = addMilliseconds(currentTime, CAR_TTL_MS)
    await groupRef.set({ data: documentData(target) })
    await transaction.collection('room_boards').doc(documentId(target)).set({
      data: { ...boardFromGroup(target), status: GROUP_STATUS.DEPARTED }
    })
    return target
  })
  return sanitizeGroup(group, openid)
}

async function finish(openid, event) {
  const groupId = validateGroupId(event.groupId)
  const currentTime = now()
  await db.runTransaction(async (transaction) => {
    const groupRef = transaction.collection('groups').doc(groupId)
    const target = await safeGet(groupRef)
    if (!target) return null
    if (target.status !== GROUP_STATUS.DEPARTED) throw new BusinessError('当前行程还未出发')
    if (!target.members.some((member) => member.openid === openid)) {
      throw new BusinessError('你不在这个队伍中')
    }
    target.members = target.members.filter((member) => member.openid !== openid)
    target.updatedAt = currentTime
    if (!target.members.length) {
      target.status = GROUP_STATUS.CLOSED
      target.expiresAt = currentTime
      redactGroup(target)
    }
    await groupRef.set({ data: documentData(target) })
    await transaction.collection('memberships').doc(openid).set({
      data: { active: false, groupId: '', routeKey: '', updatedAt: currentTime }
    })
    return null
  })
  return null
}

const handlers = {
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
  finish
}

exports.main = async (event) => {
  const action = event && typeof event === 'object' && !Array.isArray(event)
    ? String(event.action || '')
    : ''
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    if (!EXPECTED_APPID) throw new BusinessError('服务未配置小程序 AppID')
    if (wxContext.APPID !== EXPECTED_APPID) {
      throw new BusinessError('请求来源无效')
    }
    if (!openid) throw new BusinessError('无法识别当前用户')
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new BusinessError('请求格式无效')
    }
    if (JSON.stringify(event).length > 4096) throw new BusinessError('请求内容过大')
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null
    if (!handler) throw new BusinessError('未知操作')
    await enforceRateLimit(openid, action)
    const data = await handler(openid, event)
    return { ok: true, data }
  } catch (error) {
    console.error('[PINCAR]', action || 'invalid-action', error && (error.stack || error.message || error))
    return {
      ok: false,
      message: error instanceof BusinessError ? error.message : '服务暂时不可用，请稍后重试',
      data: error instanceof BusinessError ? error.data : null
    }
  }
}

if (process.env.PINCAR_SECURITY_TEST === '1') {
  exports.__test = {
    normalizeNickname,
    validateNickname,
    validateGroupId,
    validateReservationId,
    nextRateState
  }
}
