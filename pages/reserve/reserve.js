const pincar = require('../../services/pincar')
const { getLocation } = require('../../utils/constants')

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timeValue(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultDeparture() {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  date.setMinutes(Math.ceil(date.getMinutes() / 10) * 10, 0, 0)
  return date
}

function departureTimestamp(date, time) {
  const parts = String(date).split('-').map(Number)
  const clock = String(time).split(':').map(Number)
  if (parts.length !== 3 || clock.length !== 2) return NaN
  return new Date(parts[0], parts[1] - 1, parts[2], clock[0], clock[1], 0, 0).getTime()
}

function dayLabel(timestamp) {
  const date = new Date(timestamp)
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayOffset = Math.round((targetStart - todayStart) / (24 * 60 * 60 * 1000))
  if (dayOffset === 0) return '今天'
  if (dayOffset === 1) return '明天'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

Page({
  data: {
    origin: null,
    reservations: [],
    loading: true,
    busy: false,
    modalVisible: false,
    meetingGate: 'SOUTH_GATE',
    reserveDate: '',
    reserveTime: '',
    minDate: '',
    maxDate: ''
  },

  onLoad(options) {
    const origin = getLocation(options.origin)
    if (!origin) {
      wx.showToast({ title: '地点信息无效', icon: 'none' })
      wx.navigateBack()
      return
    }
    const current = new Date()
    const maximum = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    this.setData({
      origin,
      minDate: dateValue(current),
      maxDate: dateValue(maximum)
    })
    wx.setNavigationBarTitle({ title: '预约拼车' })
  },

  onShow() {
    if (!this.data.origin) return
    this.refreshReservations()
    this.pollTimer = setInterval(() => this.refreshReservations(false), 10000)
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  },

  async onPullDownRefresh() {
    await this.refreshReservations()
    wx.stopPullDownRefresh()
  },

  async refreshReservations(showError = true) {
    try {
      const result = await pincar.getReservations(this.data.origin.routeKey)
      const current = Date.now()
      const reservations = (result || []).map((item) => {
        const timestamp = new Date(item.departureAt).getTime() || Number(item.departureAt)
        const memberNames = (item.members || []).map((member, index) => ({
          ...member,
          displayId: `${item.id}_${index}`,
          initial: member.nickname.slice(0, 1)
        }))
        const seatSlots = []
        for (let index = 0; index < 4; index += 1) {
          seatSlots.push(memberNames[index] || { displayId: `${item.id}_empty_${index}`, empty: true })
        }
        return {
          ...item,
          dateText: dayLabel(timestamp),
          timeText: timeValue(new Date(timestamp)),
          gateText: item.meetingGate === 'NORTH_GATE' ? '北门' : '南门',
          isTooSoon: timestamp - current < 30 * 60 * 1000,
          memberNames,
          seatSlots
        }
      })
      this.setData({ reservations, loading: false })
    } catch (error) {
      if (showError) wx.showToast({ title: error.message || '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  openCreateModal() {
    const departure = defaultDeparture()
    this.setData({
      modalVisible: true,
      meetingGate: 'SOUTH_GATE',
      reserveDate: dateValue(departure),
      reserveTime: timeValue(departure)
    })
  },

  closeCreateModal() {
    if (this.data.busy) return
    this.setData({ modalVisible: false })
  },

  stopBubble() {},

  selectMeetingGate(event) {
    this.setData({ meetingGate: event.currentTarget.dataset.gate })
  },

  onDateChange(event) {
    this.setData({ reserveDate: event.detail.value })
  },

  onTimeChange(event) {
    this.setData({ reserveTime: event.detail.value })
  },

  async createReservation() {
    if (this.data.busy) return
    const departureAt = departureTimestamp(this.data.reserveDate, this.data.reserveTime)
    if (!Number.isFinite(departureAt) || departureAt - Date.now() < 30 * 60 * 1000) {
      wx.showToast({ title: '预约时间至少要比现在晚30分钟', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      await pincar.createReservation(
        this.data.origin.routeKey,
        this.data.meetingGate,
        departureAt
      )
      this.setData({ modalVisible: false })
      wx.showToast({ title: '预约意向已发布', icon: 'success' })
      await this.refreshReservations(false)
    } catch (error) {
      wx.showToast({ title: error.message || '预约失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async toggleReservation(event) {
    if (this.data.busy) return
    const reservation = this.data.reservations.find((item) => item.id === event.currentTarget.dataset.id)
    if (!reservation) return
    if (!reservation.isJoined && (reservation.isFull || reservation.isTooSoon)) {
      wx.showToast({ title: reservation.isFull ? '这个预约人数已满' : '距离出发不足30分钟', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    try {
      if (reservation.isJoined) {
        await pincar.leaveReservation(reservation.id)
        wx.showToast({ title: '已退出预约', icon: 'none' })
      } else {
        await pincar.joinReservation(reservation.id)
        wx.showToast({ title: '已加入预约', icon: 'success' })
      }
      await this.refreshReservations(false)
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  }
})
