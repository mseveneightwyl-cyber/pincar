const pincar = require('../../services/pincar')
const { LOCATIONS, getLocation } = require('../../utils/constants')

function locationByRoute(routeKey) {
  return Object.values(LOCATIONS).find((location) => location.routeKey === routeKey) || null
}

function defaultArrivalTime() {
  const date = new Date(Date.now() + 10 * 60 * 1000)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

Page({
  data: {
    origin: null,
    boards: [],
    myGroup: null,
    demoMode: false,
    loading: true,
    busy: false,
    plateModalVisible: false,
    plateInput: '',
    meetingGate: 'SOUTH_GATE',
    arrivalTime: defaultArrivalTime()
  },

  onLoad(options) {
    const origin = getLocation(options.origin)
    if (!origin) {
      wx.showToast({ title: '地点信息无效', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ origin })
    wx.setNavigationBarTitle({ title: `${origin.shortName} → ${origin.destinationName}` })
  },

  onShow() {
    if (!this.data.origin) return
    this.startWatcher()
  },

  onHide() {
    this.stopWatcher()
  },

  onUnload() {
    this.stopWatcher()
  },

  async onPullDownRefresh() {
    await this.refreshRoom()
    wx.stopPullDownRefresh()
  },

  startWatcher() {
    this.stopWatcher()
    this.roomWatcher = pincar.watchRoom(this.data.origin.routeKey, (room) => {
      this.applyRoom(room)
    })
  },

  stopWatcher() {
    if (this.roomWatcher) this.roomWatcher.close()
    this.roomWatcher = null
  },

  async refreshRoom() {
    if (!this.data.origin) return
    try {
      const room = await pincar.getRoom(this.data.origin.routeKey)
      this.applyRoom(room)
    } catch (error) {
      wx.showToast({ title: error.message || '刷新失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  applyRoom(room) {
    const current = Date.now()
    const boards = (room.boards || [])
      .filter((board) => new Date(board.expiresAt).getTime() > current || Number(board.expiresAt) > current)
      .map((board) => ({
        ...board,
        seatText: `${board.memberCount}/${board.maxMembers}`,
        gateText: board.meetingGate === 'NORTH_GATE' ? '北门' : '南门'
      }))
    const myGroup = room.myGroup ? { ...room.myGroup } : null
    if (myGroup) {
      const groupOrigin = locationByRoute(myGroup.routeKey)
      myGroup.directionText = groupOrigin
        ? `起点 ${groupOrigin.name} → 终点 ${groupOrigin.destinationName}`
        : '通勤方向'
    }
    this.setData({
      boards,
      myGroup,
      demoMode: Boolean(room.demoMode),
      loading: false
    })
  },

  openPlateModal() {
    if (this.data.myGroup) {
      this.openMyGroup()
      return
    }
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

  async createCarGroup() {
    if (this.data.busy) return
    const plateTail = this.data.plateInput.trim().toUpperCase()
    if (!/^[A-Z0-9]{5,6}$/.test(plateTail)) {
      wx.showToast({ title: '请输入5–6位车牌尾号', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    try {
      const group = await pincar.createCarGroup(
        this.data.origin.routeKey,
        plateTail,
        this.data.meetingGate,
        this.data.arrivalTime
      )
      this.setData({ plateModalVisible: false, plateInput: '' })
      this.navigateToGroup(group.id)
    } catch (error) {
      this.handleActionError(error)
    } finally {
      this.setData({ busy: false })
    }
  },

  async joinWaiting() {
    if (this.data.busy) return
    if (this.data.myGroup) {
      this.openMyGroup()
      return
    }

    this.setData({ busy: true })
    try {
      const group = await pincar.joinWaiting(this.data.origin.routeKey)
      this.navigateToGroup(group.id)
    } catch (error) {
      this.handleActionError(error)
    } finally {
      this.setData({ busy: false })
    }
  },

  async confirmJoinCar(event) {
    if (this.data.busy) return
    const groupId = event.currentTarget.dataset.id
    const board = this.data.boards.find((item) => item.id === groupId)
    if (!board || board.isFull) {
      wx.showToast({ title: '这辆车已经满员', icon: 'none' })
      return
    }
    if (this.data.myGroup) {
      wx.showToast({ title: '请先退出当前队伍', icon: 'none' })
      return
    }

    const modal = await new Promise((resolve) => {
      wx.showModal({
        title: '确认加入',
        content: '',
        confirmText: '确认',
        confirmColor: '#28aaa3',
        success: resolve,
        fail: () => resolve({ confirm: false })
      })
    })
    if (!modal.confirm) return

    this.setData({ busy: true })
    try {
      const group = await pincar.joinCarGroup(groupId)
      this.navigateToGroup(group.id)
    } catch (error) {
      this.handleActionError(error)
    } finally {
      this.setData({ busy: false })
    }
  },

  openMyGroup() {
    if (this.data.myGroup) this.navigateToGroup(this.data.myGroup.id)
  },

  openReservations() {
    wx.navigateTo({ url: `/pages/reserve/reserve?origin=${this.data.origin.id}` })
  },

  navigateToGroup(groupId) {
    wx.navigateTo({
      url: `/pages/group/group?groupId=${groupId}&origin=${this.data.origin.id}`
    })
  },

  handleActionError(error) {
    if (error.groupId) {
      this.navigateToGroup(error.groupId)
      return
    }
    wx.showToast({ title: error.message || '操作失败', icon: 'none' })
  }
})
