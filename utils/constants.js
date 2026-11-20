const LOCATIONS = {
  science: {
    id: 'science',
    name: '科学智汇城',
    shortName: '智汇城',
    destinationId: 'gangcheng',
    destinationName: '港城莞',
    routeKey: 'science_to_gangcheng'
  },
  gangcheng: {
    id: 'gangcheng',
    name: '港城莞',
    shortName: '港城莞',
    destinationId: 'science',
    destinationName: '科学智汇城',
    routeKey: 'gangcheng_to_science'
  }
}

const GROUP_STATUS = {
  WAITING: 'WAITING',
  CAR_WAITING: 'CAR_WAITING',
  DEPARTED: 'DEPARTED',
  CLOSED: 'CLOSED',
  EXPIRED: 'EXPIRED'
}

const WAITING_TTL_MS = 30 * 60 * 1000
const CAR_TTL_MS = 10 * 60 * 1000
const MAX_MEMBERS = 4

function getLocation(id) {
  return LOCATIONS[id] || null
}

function getChinaDateKey(date) {
  const value = date || new Date()
  const chinaTime = new Date(value.getTime() + 8 * 60 * 60 * 1000)
  return chinaTime.toISOString().slice(0, 10).replace(/-/g, '')
}

module.exports = {
  LOCATIONS,
  GROUP_STATUS,
  WAITING_TTL_MS,
  CAR_TTL_MS,
  MAX_MEMBERS,
  getLocation,
  getChinaDateKey
}
