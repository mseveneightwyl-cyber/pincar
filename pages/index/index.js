const pincar = require('../../services/pincar')
const { LOCATIONS } = require('../../utils/constants')

Page({
  data: {
    nickname: '',
    busy: false,
    cloudMode: false,
    privacyAccepted: false,
    locations: [LOCATIONS.science, LOCATIONS.gangcheng]
  },

  onLoad() {
    const profile = pincar.getProfile()
    this.setData({
      nickname: profile.nickname || '',
      cloudMode: pincar.isCloudMode(),
      privacyAccepted: wx.getStorageSync('pincar_privacy_accepted') === '2026-09-03'
    })
    if (wx.getStorageSync('pincar_guide_seen') !== 'guide-v1') {
      wx.nextTick(() => {
        wx.navigateTo({ url: '/pages/guide/guide?first=1' })
      })
    }
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value })
  },

  togglePrivacyAccepted() {
    const privacyAccepted = !this.data.privacyAccepted
    this.setData({ privacyAccepted })
    if (privacyAccepted) {
      wx.setStorageSync('pincar_privacy_accepted', '2026-09-03')
    } else {
      wx.removeStorageSync('pincar_privacy_accepted')
    }
  },

  openPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' })
  },

  openGuide() {
    wx.navigateTo({ url: '/pages/guide/guide' })
  },

  async chooseLocation(event) {
    if (this.data.busy) return
    const nickname = this.data.nickname.trim()
    const originId = event.currentTarget.dataset.id

    if (!nickname) {
      wx.showToast({ title: '请先填写昵称', icon: 'none' })
      return
    }
    if (!this.data.privacyAccepted) {
      wx.showToast({ title: '请先阅读并同意隐私说明', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    try {
      await pincar.saveProfile(nickname)
      wx.navigateTo({ url: `/pages/room/room?origin=${originId}` })
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  }
})
