const GUIDE_VERSION = 'guide-v1'

Page({
  data: {
    current: 0,
    isFirstVisit: false,
    slides: [
      { key: 'route', step: '01', title: '选对通勤方向', copy: '填写队友可见的称呼，再确认起点和终点。只有同方向用户会匹配在一起。' },
      { key: 'instant', step: '02', title: '现在就出发', copy: '已经叫到车就发布车牌尾号；还没叫车就点“我要拼车”，自动进入最多4人的小组。' },
      { key: 'reserve', step: '03', title: '提前预约拼车', copy: '计划在30分钟后出发，可发布日期、时间和集合门，其他同方向用户可加入你的预约。' },
      { key: 'safe', step: '04', title: '暗号碰头，安全上车', copy: '见面时报出4位暗号确认队友。上车前核对完整车牌和司机信息，建议面对面建群并AA车费。' }
    ]
  },

  onLoad(options) {
    this.setData({ isFirstVisit: options.first === '1' })
  },

  onSlideChange(event) {
    this.setData({ current: event.detail.current })
  },

  nextSlide() {
    const lastIndex = this.data.slides.length - 1
    if (this.data.current >= lastIndex) {
      this.finishGuide()
      return
    }
    this.setData({ current: this.data.current + 1 })
  },

  finishGuide() {
    wx.setStorageSync('pincar_guide_seen', GUIDE_VERSION)
    wx.navigateBack()
  },

  skipGuide() {
    this.finishGuide()
  }
})
