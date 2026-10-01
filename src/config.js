// =====================================================================================
//  原鸽 / 家鸽（Columba livia）生物学参数
//  数值取自常见鸟类学资料的典型范围，用于驱动模拟；个体之间会有随机差异。
// =====================================================================================

export const BIO = {
  species: '原鸽（家鸽 / 城市野鸽）',
  latin: 'Columba livia (domestica)',
  bodyLength: [0.29, 0.37],        // m
  wingspan: [0.62, 0.72],          // m
  massMale: [0.3, 0.38],           // kg（雄鸽略大）
  massFemale: [0.26, 0.34],
  lifespanWild: [3, 5],            // 城市中平均寿命（年）
  lifespanCaptive: [15, 20],

  bodyTemp: 41.5,                  // °C 体温
  heartRestBpm: [160, 220],        // 静息心率
  heartFlightBpm: [550, 650],      // 飞行心率
  breathRest: [25, 35],            // 静息呼吸次数 / 分
  breathFlight: [140, 180],

  walkSpeed: 0.35,                 // m/s 常速步行（每步约 6 cm，步频约 3 Hz）
  hurrySpeed: 0.8,
  flapHzCruise: 6.5,               // 平飞振翅频率
  flapHzTakeoff: 9,
  cruiseSpeed: 16,                 // m/s 真实平飞约 60–80 km/h（场景中会按比例缩放）
  homingSpeedKmh: [60, 95],

  dailyFoodG: 30,                  // 每日采食量（克，谷物）
  cropCapacityG: 22,               // 嗉囊容量
  digestGPerHour: 3.2,             // 嗉囊排空速率
  dailyWaterMl: 45,                // 每日饮水量
  sipMlPerSecond: 1.2,             // 吸吮式饮水速度

  flightInitiationDist: [1.5, 3.5],// 人接近时起飞距离（城市个体较“胆大”）
  alertDist: [3, 6],

  clutchSize: 2,                   // 每窝 2 枚白色卵
  layingIntervalH: 44,             // 两枚卵间隔约 44 小时
  incubationDays: [17, 19],
  maleShift: [10, 16.5],           // 雄鸽约 10:00–16:30 孵卵，其余时间由雌鸽负责
  fledgeDays: [25, 32],            // 雏鸽出飞日龄
  cropMilkDays: [0, 10],           // 头几天几乎全靠鸽乳喂养
  broodsPerYear: [5, 8],
};

// 场景尺度：真实的鸽子飞得很快，为了在广场尺度内看得清，飞行速度按此系数缩放
export const FLIGHT_SCALE = 0.55;

// 一天的时间：游戏内 1 小时 = 多少真实秒（默认 30 秒，一天约 12 分钟）
export const SECONDS_PER_GAME_HOUR = 30;

export const SUNRISE = 6.0;
export const SUNSET = 18.6;

// 鸽子名字与个性
export const FLOCK_SETUP = [
  { name: '灰灰', sex: 'male', morph: 'blueBar', bold: 0.65, social: 0.6 },
  { name: '小雪', sex: 'female', morph: 'white', bold: 0.4, social: 0.7 },
  { name: '斑斑', sex: 'male', morph: 'checker', bold: 0.8, social: 0.5 },
  { name: '阿红', sex: 'female', morph: 'red', bold: 0.5, social: 0.6 },
  { name: '墨墨', sex: 'male', morph: 'dark', bold: 0.55, social: 0.55 },
  { name: '花花', sex: 'female', morph: 'pied', bold: 0.45, social: 0.75 },
  { name: '大灰', sex: 'male', morph: 'blueBar', bold: 0.7, social: 0.5 },
  { name: '点点', sex: 'female', morph: 'checker', bold: 0.35, social: 0.8 },
];
