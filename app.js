const config = require('./config')

App({
  globalData: {
    brand: 'PINCAR',
    config
  },

  onLaunch() {
    if (config.cloudEnabled && config.cloudEnvId && wx.cloud) {
      wx.cloud.init({
        env: config.cloudEnvId || undefined,
        traceUser: true
      })
    }
  }
})
