const config = require('../config')
const localStore = require('./local-store')

function isCloudMode() {
  return Boolean(config.cloudEnabled && config.cloudEnvId && wx.cloud)
}

async function cloudCall(action, data) {
  const response = await wx.cloud.callFunction({
    name: config.cloudFunctionName,
    data: Object.assign({ action }, data || {})
  })
  const result = response.result || {}
  if (!result.ok) {
    const error = new Error(result.message || '服务暂时不可用')
    if (result.data && result.data.groupId) error.groupId = result.data.groupId
    throw error
  }
  return result.data
}

function getProfile() {
  return localStore.getProfile()
}

async function saveProfile(nickname) {
  const profile = localStore.saveProfile(nickname)
  if (isCloudMode()) await cloudCall('saveProfile', { nickname: profile.nickname })
  return profile
}

function getRoom(routeKey) {
  if (isCloudMode()) return cloudCall('getRoom', { routeKey })
  return localStore.getRoom(routeKey)
}

function getGroup(groupId) {
  if (isCloudMode()) return cloudCall('getGroup', { groupId })
  return localStore.getGroup(groupId)
}

function joinWaiting(routeKey) {
  if (isCloudMode()) return cloudCall('joinWaiting', { routeKey })
  return localStore.joinWaiting(routeKey)
}

function createCarGroup(routeKey, plateTail, meetingGate, arrivalTime) {
  if (isCloudMode()) return cloudCall('createCarGroup', { routeKey, plateTail, meetingGate, arrivalTime })
  return localStore.createCarGroup(routeKey, plateTail, meetingGate, arrivalTime)
}

function submitPlate(groupId, plateTail, meetingGate, arrivalTime) {
  if (isCloudMode()) return cloudCall('submitPlate', { groupId, plateTail, meetingGate, arrivalTime })
  return localStore.submitPlate(groupId, plateTail, meetingGate, arrivalTime)
}

function joinCarGroup(groupId) {
  if (isCloudMode()) return cloudCall('joinCarGroup', { groupId })
  return localStore.joinCarGroup(groupId)
}

function getReservations(routeKey) {
  if (isCloudMode()) return cloudCall('getReservations', { routeKey })
  return localStore.getReservations(routeKey)
}

function createReservation(routeKey, meetingGate, departureAt) {
  if (isCloudMode()) return cloudCall('createReservation', { routeKey, meetingGate, departureAt })
  return localStore.createReservation(routeKey, meetingGate, departureAt)
}

function joinReservation(reservationId) {
  if (isCloudMode()) return cloudCall('joinReservation', { reservationId })
  return localStore.joinReservation(reservationId)
}

function leaveReservation(reservationId) {
  if (isCloudMode()) return cloudCall('leaveReservation', { reservationId })
  return localStore.leaveReservation(reservationId)
}

function leaveGroup(groupId) {
  if (isCloudMode()) return cloudCall('leaveGroup', { groupId })
  return localStore.leaveGroup(groupId)
}

function depart(groupId) {
  if (isCloudMode()) return cloudCall('depart', { groupId })
  return localStore.depart(groupId)
}

function finish(groupId) {
  if (isCloudMode()) return cloudCall('finish', { groupId })
  return localStore.finish(groupId)
}

function watchRoom(routeKey, callback) {
  if (!isCloudMode()) return localStore.watchRoom(routeKey, callback)

  let closed = false
  let refreshing = false
  const refresh = async () => {
    if (closed || refreshing) return
    refreshing = true
    try {
      const room = await getRoom(routeKey)
      if (!closed) callback(room)
    } catch (error) {
      // 短暂断网时保留当前页面，下一轮自动重试。
    } finally {
      refreshing = false
    }
  }

  refresh()
  const timer = setInterval(refresh, 6000)

  return {
    close() {
      closed = true
      clearInterval(timer)
    }
  }
}

module.exports = {
  isCloudMode,
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
