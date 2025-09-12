import { $, Context, Schema } from 'koishi';
import {} from 'koishi-plugin-cron';
import {} from 'koishi-plugin-puppeteer';
export const name = 'acm-daily-problems';

export const inject = {
  required: ['database', 'cron', 'puppeteer'],
  optional: [],
};
export const usage = `
### 基础功能
每天早上8:30推送一组cf随机题目（简单、中等、困难各一道）

### 指令:
- \`rp \` - (Rand Problems)随机获取简单(≤1200)、中等(≤2000)、困难(>2000)题目各一道

- \`ep <题目编号或链接>\` - (Emplace Problems)手动添加题目到推送队列

- \`push 1 / 0\` - 开启/关闭每日题目推送

- \`tp\` - (Today Problems)获取今天的每日一题

- \`cb\` - (Check Board)查看当前的积分排行榜

- \`绑定cf / 解绑cf\` - 将 cf 账号绑定/解绑当前 qq 账号，解绑后积分数据全部清除！

`;
declare module 'koishi' {
  interface Tables {
    acm_problems: problems;
  }
  interface Tables {
    acm_pushGroup: pushGroup;
  }
  interface Tables {
    acm_users: users;
  }
}
export interface problems {
  id: number;
  contestId: number;
  index: string;
  rating: number;
  name: string;
  difficulty: number;
  used: boolean;
  pushDate?: string;
  solved: string[];
}
export interface pushGroup {
  id: number;
  groupId: string;
  push: boolean;
}
export interface users {
  id: number;
  qId: string;
  cfHandle: string;
  score: number;
}
export interface Config {}

export const Config: Schema<Config> = Schema.object({});

async function getProblemList() {
  const url = 'https://codeforces.com/api/problemset.problems';
  const res = await fetch(url);
  const data = await res.json();
  const randomEasyProblems: any[] = [];
  const randomMidProblems: any[] = [];
  const randomHardProblems: any[] = [];
  if (data.status !== 'OK') {
    console.error('Failed to fetch problems from Codeforces API');
  }
  //按 rating 分为三个难度等级
  else {
    const problems = data.result.problems;
    for (const problem of problems) {
      if (!problem.rating) continue;
      if (problem.rating <= 1200) {
        randomEasyProblems.push(problem);
      } else if (problem.rating <= 2000) {
        randomMidProblems.push(problem);
      } else {
        randomHardProblems.push(problem);
      }
    }
  }
  return { randomEasyProblems, randomMidProblems, randomHardProblems };
}

function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

//从数据库获取或随机选择指定难度的问题
async function getProblemByDifficulty(
  ctx: Context,
  difficulty: number,
  problemPool: any[]
): Promise<any> {
  //从数据库中获取未使用的题目
  const unusedProblems = await ctx.database.get('acm_problems', {
    used: false,
    difficulty: difficulty,
  });
  const pushDate = getTodayDate();
  if (unusedProblems.length > 0) {
    //如果有未使用的题目，选择第一个并标记为已使用
    const selectedProblem = unusedProblems[0];
    await ctx.database.set(
      'acm_problems',
      { contestId: selectedProblem.contestId, index: selectedProblem.index },
      { used: true, pushDate: pushDate }
    );
    return selectedProblem;
  } else {
    //从题目池中随机选择一个新题目
    let selectedProblem = problemPool[Math.floor(Math.random() * problemPool.length)];

    //将新题目存入数据库并标记为已使用
    await ctx.database.create('acm_problems', {
      contestId: selectedProblem.contestId,
      index: selectedProblem.index,
      rating: selectedProblem.rating,
      name: selectedProblem.name,
      difficulty: difficulty,
      used: true,
      pushDate: pushDate,
    });

    return selectedProblem;
  }
}

//生成题目链接
function generateProblemLink(problem: any): string {
  return `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
}

//格式化题目消息
function formatProblemsMessage(
  easyProblem: any,
  midProblem: any,
  hardProblem: any,
  title: string = '今日题目如下'
): string {
  return `${title}：\n\n简单：\n${easyProblem.name}\n${generateProblemLink(easyProblem)}（${
    easyProblem.rating
  }）\n\n中等：\n${midProblem.name}\n${generateProblemLink(midProblem)}（${
    midProblem.rating
  }）\n\n困难：\n${hardProblem.name}\n${generateProblemLink(hardProblem)}（${hardProblem.rating}）`;
}

async function updateScore(ctx: Context) {
  const today = getTodayDate();
  const problems = await ctx.database.get('acm_problems', { used: true, pushDate: today });
  if (!problems || problems.length === 0) {
    return 0;
  }

  const userScoreIncrements = new Map<string, number>();

  //从 1 开始计分
  //数据库中的user
  const users = await ctx.database.get('acm_users', {});
  const userSet = new Set(users.map((u: any) => u.cfHandle));

  for (const problem of problems) {
    let scoreForThisProblem = problem.rating / 100;
    const { contestId, index } = problem;
    const url = `https://codeforces.com/api/contest.status?contestId=${contestId}&from=1&count=1000`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK') {
        console.error(`cf api error:${contestId}-${index}:`, data);
        continue; //跳过此题，继续处理其他题
      }

      const submissions = data.result || [];
      // console.log(submissions);
      //读取数据库中该题已有的 solved 列表
      const t = await ctx.database.get('acm_problems', { contestId: contestId, index: index });
      const existingSolvedArr: string[] = Array.isArray(t?.[0]?.solved) ? t[0].solved : [];
      const existingSolved = new Set(existingSolvedArr);

      //收集新 AC 的人
      const acceptedUsers = new Set<string>();
      // console.log('users:', userSet);
      for (const submission of submissions) {
        // console.log(submission);
        if (submission?.verdict !== 'OK' || submission.problem.index !== index) continue;
        const handle = submission.author?.members?.[0]?.handle;
        // console.log(`${contestId}-${index} AC by ${handle}`);
        if (!handle || !userSet.has(handle)) continue;
        if (!existingSolved.has(handle)) acceptedUsers.add(handle);
      }

      const acUsers = Array.from(acceptedUsers).reverse();
      if (acUsers.length === 0) {
        //没有新 AC，继续下一个题
        continue;
      }

      //更新题目已解决列表（把旧的和新的拼起来）
      const newSolvedArr = [...existingSolvedArr, ...acUsers];
      await ctx.database.set('acm_problems', { contestId, index }, { solved: newSolvedArr });

      //累积每个新 AC 用户应加的分数
      //如果该用户是首杀，额外加一分
      if (existingSolved.size === 0) {
        const prevFirstAcScore = userScoreIncrements.get(acUsers[0]) ?? 0;
        userScoreIncrements.set(acUsers[0], prevFirstAcScore + 5);
      }
      for (const acUser of acUsers) {
        const prev = userScoreIncrements.get(acUser) ?? 0;
        userScoreIncrements.set(acUser, prev + scoreForThisProblem);
      }
    } catch (err) {
      console.error(`${contestId}-${index}:`, err);
      //遇错跳过当前题，继续处理下面的题
      continue;
    }
  }

  //将累积的分数统一写入用户表（并行写入以加速）
  const batch = [];
  for (const [cfHandle, inc] of userScoreIncrements.entries()) {
    if (!inc) continue;
    batch.push(
      ctx.database.set('acm_users', { cfHandle }, (row: any) => ({
        score: $.add(row.score, inc),
      }))
    );
  }
  try {
    await Promise.all(batch);
  } catch (err) {
    console.error('updating score error:', err);
    return 1;
  }

  return 0; //成功
}

export function apply(ctx: Context) {
  //数据库
  ctx.model.extend(
    'acm_problems',
    {
      id: 'unsigned',
      contestId: 'integer',
      index: 'string',
      rating: 'integer',
      name: 'string',
      difficulty: 'integer',
      used: 'boolean',
      //时间戳
      pushDate: 'string',
      solved: 'list',
    },
    {
      autoInc: true,
    }
  );
  ctx.model.extend(
    'acm_pushGroup',
    {
      id: 'unsigned',
      groupId: 'string',
      push: 'boolean',
    },
    {
      autoInc: true,
    }
  );
  ctx.model.extend(
    'acm_users',
    {
      id: 'unsigned',
      qId: 'string',
      cfHandle: 'string',
      score: 'integer',
    },
    {
      autoInc: true,
    }
  );

  //ctx.()

  ctx
    .command('rp', '(RandProblem)随机一组cf题目')
    .usage('\n随机获取简单(≤1200)、中等(≤2000)、困难(>2000)题目各一道')
    .action(async ({ session }) => {
      const { randomEasyProblems, randomMidProblems, randomHardProblems } = await getProblemList();

      //从每个列表中随机选一个题目
      const easyProblem = randomEasyProblems[Math.floor(Math.random() * randomEasyProblems.length)];
      const midProblem = randomMidProblems[Math.floor(Math.random() * randomMidProblems.length)];
      const hardProblem = randomHardProblems[Math.floor(Math.random() * randomHardProblems.length)];

      if (!easyProblem || !midProblem || !hardProblem) {
        session.send('题目获取失败');
        return;
      }

      const message = formatProblemsMessage(easyProblem, midProblem, hardProblem, '随机题目如下');
      session.send(message);
    });

  ctx
    .command('push <push:number>', '开启/关闭每日题目推送')
    .usage('push 1 开启推送，push 0 关闭推送')
    .action(async ({ session }, push) => {
      if (push !== 0 && push !== 1) {
        session.send('push 1 开启题目推送\npush 0 关闭题目推送');
        return;
      }
      const groupId = session.channelId;

      const existing = await ctx.database.get('acm_pushGroup', { groupId: groupId });
      if (existing.length > 0) {
        //更新已有记录
        await ctx.database.set('acm_pushGroup', { groupId: groupId }, { push: push === 1 });
      } else {
        //创建新记录
        await ctx.database.create('acm_pushGroup', { groupId: groupId, push: push === 1 });
      }

      session.send(push ? '每日题目推送已开启，每天8:30准时推送' : '已关闭每日题目推送');
    });

  ctx
    .command('ep <problem:string>', '(EmplaceProblem)手动添加题目到题库')
    .usage('\n使用示例：\nemplace 1234/A 或\nemplace 1234A 或\nemplace [题目链接]')
    .action(async ({ session }, str) => {
      let contestId: number;
      let index: string;

      //解析输入
      const urlMatch = str.match(
        /codeforces\.com\/(?:contest|problemset)\/(?:problem\/)?(\d+)\/(?:problem\/)?([A-Za-z]+)/
      );
      if (urlMatch) {
        contestId = parseInt(urlMatch[1]);
        index = urlMatch[2];
      } else {
        const parts = str.split(/\/| /);
        if (parts.length === 2) {
          contestId = parseInt(parts[0]);
          index = parts[1];
        } else if (parts.length === 1) {
          const match = parts[0].match(/^(\d+)([A-Za-z]+)$/);
          if (match) {
            contestId = parseInt(match[1]);
            index = match[2];
          } else {
            session.send('输入格式错误，请使用 "1234/A"、 "1234A" 或 题目链接');
            return;
          }
        } else {
          session.send('输入格式错误，请使用 "1234/A"、 "1234A" 或 题目链接');
          return;
        }
      }
      index = index.toUpperCase();
      //检查题目是否已存在
      const existing = await ctx.database.get('acm_problems', {
        contestId: contestId,
        index: index,
      });
      if (existing.length > 0) {
        ctx.database.set('acm_problems', { contestId: contestId, index: index }, { used: false });
        if (existing[0].used === true) session.send(`成功添加题目：${existing[0].name}`);
        if (existing[0].used === false) session.send(`推送队列中已存在该题目`);
        return;
      }

      //获取题目信息
      const apiUrl = `https://codeforces.com/api/problemset.problems`;
      const res = await fetch(apiUrl);
      const data = await res.json();
      if (data.status !== 'OK') {
        session.send('无法从 Codeforces 获取题目信息');
        return;
      }

      const problem = data.result.problems.find(
        (p: any) => p.contestId === contestId && p.index === index
      );
      if (!problem) {
        session.send('未找到该题目，请检查题目编号是否正确');
        return;
      }
      if (!problem.rating) {
        session.send('该题目无难度评级，无法添加到题库');
        return;
      }

      //确定难度等级
      let difficulty: number;
      if (problem.rating <= 1200) {
        difficulty = 1; //简单
      } else if (problem.rating <= 2000) {
        difficulty = 2; //中等
      } else {
        difficulty = 3; //困难
      }

      //添加题目到数据库
      await ctx.database.create('acm_problems', {
        contestId: contestId,
        index: index,
        rating: problem.rating,
        name: problem.name,
        difficulty: difficulty,
        used: false,
      });

      session.send(`成功添加题目：${problem.name}`);
    });

  //绑定codeforces账号
  ctx
    .command('绑定cf <handle:string>', '绑定codeforces账号')
    .action(async ({ session }, handle) => {
      //console.log(handle);
      const url = `https://codeforces.com/api/user.info?handles=${handle}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK') {
        session.send('未找到该Codeforces账号，请检查用户名是否正确');
        return;
      }
      const userId = session.userId;
      const qexisting = await ctx.database.get('acm_users', { qId: userId });
      const cexisting = await ctx.database.get('acm_users', { cfHandle: handle });
      if (cexisting.length > 0) {
        session.send(`该Codeforces账号已被绑定`);
        return;
      }
      if (qexisting.length > 0) {
        //更新已有记录
        await ctx.database.set('acm_users', { qId: userId }, { cfHandle: handle });
        session.send(`已成功更新Codeforces账号：${handle}`);
      } else {
        //创建新记录
        await ctx.database.create('acm_users', { qId: userId, cfHandle: handle, score: 0 });
        session.send(`已成功绑定Codeforces账号：${handle}`);
      }
    });

  //解绑cf账号
  ctx
    .command('解绑cf', '解绑codeforces账号')
    .usage('解绑后积分数据全部清除，请慎重')
    .action(async ({ session }) => {
      const userId = session.userId;
      const existing = await ctx.database.get('acm_users', { qId: userId });
      if (existing.length === 0) {
        session.send('你还未绑定Codeforces账号呢');
        return;
      }
      await ctx.database.remove('acm_users', { qId: userId });
      session.send('已成功解绑Codeforces账号');
    });
  //获取今天的题
  ctx.command('tp', '(TodayProblems)获取今天的题目').action(async ({ session }) => {
    const today = getTodayDate();
    const todayProblems = await ctx.database.get('acm_problems', {
      used: true,
      pushDate: today,
    });
    if (!todayProblems || todayProblems.length === 0) {
      session.send('今天没有题目哦');
      return;
    }
    let easyProblem, midProblem, hardProblem;
    for (const problem of todayProblems) {
      if (problem.difficulty === 1) {
        easyProblem = problem;
      } else if (problem.difficulty === 2) {
        midProblem = problem;
      } else if (problem.difficulty === 3) {
        hardProblem = problem;
      }
    }
    const message = formatProblemsMessage(easyProblem, midProblem, hardProblem, '今天的题目如下');
    session.send(message);
  });
  //渲染积分榜图片的函数
  async function renderLeaderboardImage(
    users: any[],
    easyProblemSolved: string[],
    midProblemSolved: string[],
    hardProblemSolved: string[],
    startRank: number = 1
  ): Promise<Buffer> {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
            background: linear-gradient(135deg, #eef2f7 0%, #dce3ec 100%);
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .leaderboard {
            background: linear-gradient(to bottom, #ffffff 0%, #f9fafc 100%);
            border-radius: 10px;
            border: 1px solid #d1d9e6;
            padding: 20px;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
            min-width: 420px;
            max-width: 520px;
        }
        .title {
            text-align: center;
            font-size: 20px;
            font-weight: bold;
            color: #333;
            margin-bottom: 20px;
            border-bottom: 2px solid #e5e9f0;
            padding-bottom: 10px;
        }
        .rank-item {
            display: flex;
            align-items: center;
            padding: 10px 14px;
            margin: 6px 0;
            border-radius: 6px;
            background: #fdfdfd;
            border: 1px solid #e5e9f0;
            transition: background 0.2s;
        }
        .rank-item:hover {
            background: #f5f7fa;
        }
        /* 金银铜改为柔和色 */
        .rank-item:nth-child(2) {
            background: #fff8d9;
            border-color: #f0e0a0;
            font-weight: bold;
        }
        .rank-item:nth-child(3) {
            background: #f0f0f0;
            border-color: #c0c0c0;
            font-weight: bold;
        }
        .rank-item:nth-child(4) {
            background: #f7e4d4;
            border-color: #d8a67b;
            font-weight: bold;
        }
        .rank-number {
            font-size: 14px;
            font-weight: bold;
            width: 28px;
            text-align: center;
            color: #444;
        }
        .user-info {
            flex-grow: 1;
            margin-left: 12px;
        }
        .username {
            font-size: 14px;
            font-weight: 600;
            color: #333;
        }
        .score {
            font-size: 12px;
            color: #666;
            margin-top: 3px;
        }
        .problem-status {
            display: flex;
            gap: 6px;
            margin-left: 15px;
        }
        .problem-circle {
            width: 50px;
            height: 20px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: bold;
            border: 1px solid #ccc;
            background: #ffffff;
            color: #555;
        }
        .problem-circle.solved {
            background: #6fc36f;
            border-color: #58a858;
            color: white;
        }
        .problem-circle.first-blood {
            background: #285028;
            border-color: #285028;
            color: white;
        }
    </style>
</head>
<body>
    <div class="leaderboard">
        <div class="title">ACM 每日题目积分榜</div>
        ${users
          .map((user, index) => {
            // 检查用户在三道题目的状态
            const easyStatus = easyProblemSolved.includes(user.cfHandle);
            const midStatus = midProblemSolved.includes(user.cfHandle);
            const hardStatus = hardProblemSolved.includes(user.cfHandle);

            // 检查是否为首杀（第一个解决的人）
            const easyFirstBlood =
              easyProblemSolved.length > 0 && easyProblemSolved[0] === user.cfHandle;
            const midFirstBlood =
              midProblemSolved.length > 0 && midProblemSolved[0] === user.cfHandle;
            const hardFirstBlood =
              hardProblemSolved.length > 0 && hardProblemSolved[0] === user.cfHandle;

            return `
              <div class="rank-item">
              <div class="rank-number" style="font-size: ${
                startRank + index === 1 || startRank + index === 2 || startRank + index === 3
                  ? '22px'
                  : '14px'
              }">${
              startRank + index === 1
                ? '🥇'
                : startRank + index === 2
                ? '🥈'
                : startRank + index === 3
                ? '🥉'
                : startRank + index
            }</div>
              <div class="user-info">
                <div class="username">${user.cfHandle}</div>
                <div class="score">${user.score} 分</div>
              </div>
              <div class="problem-status">
                <div class="problem-circle ${
                  easyFirstBlood ? 'first-blood' : easyStatus ? 'solved' : ''
                }">A</div>
                <div class="problem-circle ${
                  midFirstBlood ? 'first-blood' : midStatus ? 'solved' : ''
                }">B</div>
                <div class="problem-circle ${
                  hardFirstBlood ? 'first-blood' : hardStatus ? 'solved' : ''
                }">C</div>
              </div>
              </div>
            `;
          })
          .join('')}
    </div>
</body>
</html>`;

    const page = await ctx.puppeteer.page();
    try {
      await page.setContent(html);
      await page.setViewport({ width: 550, height: 600 });
      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: true,
      });
      return screenshot as Buffer;
    } finally {
      await page.close();
    }
  }

  //做了今天的题加分, 检查时更新所有人的分数
  ctx
    .command('cb [size:number] [page:number]', '(CheckBoard)查看积分榜')
    .usage('\n用法：\ncb [size] [page]\nsize - 每页用户数，默认15\npage - 页码，默认1')
    .action(async ({ session }, size = 15, page = 1) => {
      const users = await ctx.database.get('acm_users', {});
      if (users.length === 0) {
        session.send('暂无用户数据');
        return;
      }
      //更新所有用户的分数
      const ret = await updateScore(ctx);
      // console.log(ret);
      if (ret !== 0) {
        session.send('更新积分榜时出错，请稍后再试');
        return;
      }
      //重新获取用户数据
      const updatedUsers = await ctx.database.get('acm_users', {});
      //按分数排序
      updatedUsers.sort((a: any, b: any) => b.score - a.score);

      // 计算分页
      const startIndex = (page - 1) * size;
      const endIndex = startIndex + size;
      const paginatedUsers = updatedUsers.slice(startIndex, endIndex);

      if (paginatedUsers.length === 0) {
        session.send('该页面没有数据');
        return;
      }

      // 获取今天的三道题目及其solved数组
      const today = getTodayDate();
      const todayProblems = await ctx.database.get('acm_problems', {
        used: true,
        pushDate: today,
      });

      // 初始化三道题的solved数组
      let easyProblemSolved: string[] = [];
      let midProblemSolved: string[] = [];
      let hardProblemSolved: string[] = [];

      // 根据难度分配solved数组
      for (const problem of todayProblems) {
        const solvedArray = Array.isArray(problem.solved) ? problem.solved : [];
        if (problem.difficulty === 1) {
          easyProblemSolved = solvedArray;
        } else if (problem.difficulty === 2) {
          midProblemSolved = solvedArray;
        } else if (problem.difficulty === 3) {
          hardProblemSolved = solvedArray;
        }
      }

      try {
        // 渲染积分榜图片
        const imageBuffer = await renderLeaderboardImage(
          paginatedUsers,
          easyProblemSolved,
          midProblemSolved,
          hardProblemSolved,
          startIndex + 1 // 传递起始排名
        );
        await session.send(`<img src="data:image/png;base64,${imageBuffer.toString('base64')}"/>`);
      } catch (error) {
        console.error('生成积分榜图片失败:', error);
        session.sendQueued('生成积分榜图片失败，降级为文本显示');
        // 降级到文本消息
        let message = '积分榜：\n\n';
        for (let i = 0; i < paginatedUsers.length; i++) {
          const user = paginatedUsers[i];
          message += `${startIndex + i + 1}. ${user.cfHandle} - ${user.score} 分\n`;
        }
        session.sendQueued(message);
      }
    });

  //每天8:30推送题目
  ctx.cron('30 8 * * *', async () => {
    const groups = await ctx.database.get('acm_pushGroup', { push: true });
    if (groups.length === 0) {
      console.log('无群聊开启推送');
      return;
    }

    const groupIds = groups.map(group => 'onebot:' + group.groupId);

    try {
      //获取题目池
      let { randomEasyProblems, randomMidProblems, randomHardProblems } = await getProblemList();
      const usedProblems = await ctx.database.get('acm_problems', { used: true });

      //过滤掉已使用的题目
      const usedSet = new Set(usedProblems.map((p: any) => `${p.contestId}-${p.index}`));
      const filterUnused = (problems: any[]) =>
        problems.filter(p => !usedSet.has(`${p.contestId}-${p.index}`));

      randomEasyProblems = filterUnused(randomEasyProblems);
      randomMidProblems = filterUnused(randomMidProblems);
      randomHardProblems = filterUnused(randomHardProblems);

      //分别获取三个难度的题目
      const easyProblem = await getProblemByDifficulty(ctx, 1, randomEasyProblems);
      const midProblem = await getProblemByDifficulty(ctx, 2, randomMidProblems);
      const hardProblem = await getProblemByDifficulty(ctx, 3, randomHardProblems);

      if (!easyProblem || !midProblem || !hardProblem) {
        console.error('题目获取失败');
        return;
      }

      const message = formatProblemsMessage(easyProblem, midProblem, hardProblem);
      ctx.broadcast(groupIds, message);
    } catch (error) {
      console.error('每日推送失败:', error);
    }
  });

  //每两分钟更新一次积分榜
  ctx.cron('*/2 * * * *', async () => {
    //console.log('cron test');
    await updateScore(ctx);
  });
}
