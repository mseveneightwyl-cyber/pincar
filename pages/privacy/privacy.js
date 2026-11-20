Page({
  acceptAndReturn() {
    wx.setStorageSync('pincar_privacy_accepted', '2026-09-03')
    const pages = getCurrentPages()
    const previous = pages.length > 1 ? pages[pages.length - 2] : null
    if (previous && previous.setData) previous.setData({ privacyAccepted: true })
    wx.navigateBack()
  }
})
