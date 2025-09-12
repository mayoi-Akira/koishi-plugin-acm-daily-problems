# koishi-plugin-acm-daily-problems

[![npm](https://img.shields.io/npm/v/koishi-plugin-acm-daily-problems?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-acm-daily-problems)

每天早上 8:30 推送一组 cf 随机题目（简单、中等、困难各一道）

指令:

- `rp ` - (Rand Problems)随机获取简单(≤1200)、中等(≤2000)、困难(>2000)题目各一道

- `ep <题目编号或链接>` - (Emplace Problems)手动添加题目到推送队列

- `push 1 / 0` - 开启/关闭每日题目推送

- `tp` - (Today Problems)获取今天的每日一题

- `cb` - (Check Board)查看当前的积分排行榜

- `绑定cf / 解绑cf` - 将 cf 账号绑定/解绑当前 qq 账号，解绑后积分数据全部清除！
