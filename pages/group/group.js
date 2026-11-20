const pincar = require('../../services/pincar')
const { LOCATIONS, GROUP_STATUS } = require('../../utils/constants')

function locationByRoute(routeKey) {
  return Object.values(LOCATIONS).find((location) => location.routeKey === routeKey) || null
}

function formatRemaining(expiresAt) {
  const expires = new Date(expiresAt).getTime() || Number(expiresAt)
  const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000))
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, '0')
  const secondsPart = String(seconds % 60).padStart(2, '0')
  return `${minutesPart}:${secondsPart}`
}

function defaultArrivalTime() {
  const date = new Date(Date.now() + 10 * 60 * 1000)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

Page({
  data: {
    groupId: '',
    group: null,
    origin: null,
    slots: [],
    loading: true,
    busy: false,
    isWaiting: false,
    isCarWaiting: false,
    isDeparted: false,
    statusText: '',
    remainingText: '--:--',
    plateModalVisible: false,
    plateInput: '',
    meetingGate: 'SOUTH_GATE',
    arrivalTime: defaultArrivalTime()
  },

  onLoad(options) {
    this.setData({
      groupId: options.groupId || '',
      origin: options.origin ? LOCATIONS[options.origin] : null
    })
  },

  onShow() {
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  startPolling() {
    this.stopPolling()
    this.refreshGroup(true)
    this.pollTimer = setInterval(() => this.refreshGroup(false), 3000)
    this.clockTimer = setInterval(() => {
      if (!this.data.group) return
      this.setData({ remainingText: formatRemaining(this.data.group.expiresAt) })
    }, 1000)
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.pollTimer = null
    this.clockTimer = null
  },

  async refreshGroup(initial) {
    if (!this.data.groupId) return
    try {
      const group = await pincar.getGroup(this.data.groupId)
      if (!group) {
        this.stopPolling()
        wx.showToast({ title: '队伍已结束', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      this.applyGroup(group)
    } catch (error) {
      if (initial) wx.showToast({ title: error.message || '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  applyGroup(group) {
    const isWaiting = group.status === GROUP_STATUS.WAITING
    const isCarWaiting = group.status === GROUP_STATUS.CAR_WAITING
    const isDeparted = group.status === GROUP_STATUS.DEPARTED
    const slots = []
    for (let index = 0; index < group.maxMembers; index += 1) {
      const member = group.members[index]
      slots.push(member ? {
        ...member,
        initial: member.nickname.slice(0, 1),
        empty: false,
        index
      } : { empty: true, index })
    }

    const resolvedOrigin = locationByRoute(group.routeKey) || this.data.origin
    if (resolvedOrigin && !this.routeTitleSet) {
      wx.setNavigationBarTitle({ title: `${resolvedOrigin.shortName} → ${resolvedOrigin.destinationName}` })
      this.routeTitleSet = true
    }

    this.setData({
      group,
      origin: resolvedOrigin,
      slots,
      isWaiting,
      isCarWaiting,
      isDeparted,
      statusText: isWaiting ? '等待队友' : (isCarWaiting ? '等待出发' : '已经出发'),
      remainingText: formatRemaining(group.expiresAt),
      loading: false
    })
  },

  openPlateModal() {
    this.setData({
      plateModalVisible: true,
      plateInput: '',
      meetingGate: 'SOUTH_GATE',
      arrivalTime: defaultArrivalTime()
    })
  },

  closePlateModal() {
    if (this.data.busy) return
    this.setData({ plateModalVisible: false, plateInput: '' })
  },

  stopBubble() {},

  onPlateInput(event) {
    const value = event.detail.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    this.setData({ plateInput: value })
  },

  selectMeetingGate(event) {
    this.setData({ meetingGate: event.currentTarget.dataset.gate })
  },

  onArrivalTimeChange(event) {
    this.setData({ arrivalTime: event.detail.value })
  },

  async submitPlate() {
    if (this.data.busy) return
    const plateTail = this.data.plateInput.trim().toUpperCase()
    if (!/^[A-Z0-9]{5,6}$/.test(plateTail)) {
      wx.showToast({ title: '请输入5–6位车牌尾号', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    try {
      const group = await pincar.submitPlate(
        this.data.groupId,
        plateTail,
        this.data.meetingGate,
        this.data.arrivalTime
      )
      this.setData({ plateModalVisible: false, plateInput: '' })
      this.applyGroup(group)
    } catch (error) {
      wx.showToast({ title: error.message || '提交失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async markDeparted() {
    if (this.data.busy) return
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: '确认已出发',
        content: '确认后将停止向新用户展示和开放加入',
        confirmText: '已出发',
        confirmColor: '#28aaa3',
        success: resolve,
        fail: () => resolve({ confirm: false })
      })
    })
    if (!result.confirm) return

    this.setData({ busy: true })
    try {
      const group = await pincar.depart(this.data.groupId)
      this.applyGroup(group)
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async leaveGroup() {
    if (this.data.busy) return
    const leaderWillClose = this.data.isCarWaiting && this.data.group.isLeader
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: '退出队伍',
        content: leaderWillClose ? '你是叫车人，退出后该车牌组会结束' : '退出后可以重新选择队伍',
        confirmText: '确认退出',
        confirmColor: '#e57f68',
        success: resolve,
        fail: () => resolve({ confirm: false })
      })
    })
    if (!result.confirm) return

    this.setData({ busy: true })
    try {
      await pincar.leaveGroup(this.data.groupId)
      this.stopPolling()
      wx.navigateBack()
    } catch (error) {
      wx.showToast({ title: error.message || '退出失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async finishTrip() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await pincar.finish(this.data.groupId)
      this.stopPolling()
      wx.navigateBack()
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  }
})
