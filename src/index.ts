import { Session } from 'inspector/promises';
import { Context, Schema } from 'koishi';
import {} from 'koishi-plugin-cron';
export const name = 'acm-daily-problems';

export const inject = {
  required: ['database', 'cron', 'puppeteer'],
  optional: [],
};
export const usage = `
    每天早上8:30推送一组cf随机题目（简单、中等、困难各一道）

    指令:
    - \`rp / randproblem\` - 随机获取简单(≤1200)、中等(≤2000)、困难(>2000)题目各一道

    - \`ep / emplace <题目编号或链接>\` - 手动添加题目到推送队列

    - \`push 1 / 0\` - 开启/关闭本群每日题目推送
`;
declare module 'koishi' {
  interface Tables {
    acm_problems: problems;
  }
  interface Tables {
    acm_pushGroup: pushGroup;
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
}
export interface pushGroup {
  id: number;
  groupId: string;
  push: boolean;
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
  // 按 rating 分为三个难度等级
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

// 从数据库获取或随机选择指定难度的问题
async function getProblemByDifficulty(
  ctx: Context,
  difficulty: number,
  problemPool: any[]
): Promise<any> {
  // 从数据库中获取未使用的题目
  const unusedProblems = await ctx.database.get('acm_problems', {
    used: false,
    difficulty: difficulty,
  });

  if (unusedProblems.length > 0) {
    // 如果有未使用的题目，选择第一个并标记为已使用
    const selectedProblem = unusedProblems[0];
    await ctx.database.set(
      'acm_problems',
      { contestId: selectedProblem.contestId, index: selectedProblem.index },
      { used: true }
    );
    return selectedProblem;
  } else {
    // 从题目池中随机选择一个新题目
    let selectedProblem = problemPool[Math.floor(Math.random() * problemPool.length)];

    // 将新题目存入数据库并标记为已使用
    await ctx.database.create('acm_problems', {
      contestId: selectedProblem.contestId,
      index: selectedProblem.index,
      rating: selectedProblem.rating,
      name: selectedProblem.name,
      difficulty: difficulty,
      used: true,
    });

    return selectedProblem;
  }
}

// 生成题目链接
function generateProblemLink(problem: any): string {
  return `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
}

// 格式化题目消息
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

export function apply(ctx: Context) {
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

  ctx
    .command('rp', '(RandProblem)随机一组cf题目')
    .alias('randproblem')
    .usage('随机获取简单(≤1200)、中等(≤2000)、困难(>2000)题目各一道')
    .action(async ({ session }) => {
      const { randomEasyProblems, randomMidProblems, randomHardProblems } = await getProblemList();

      // 从每个列表中随机选一个题目
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
        // 更新已有记录
        await ctx.database.set('acm_pushGroup', { groupId: groupId }, { push: push === 1 });
      } else {
        // 创建新记录
        await ctx.database.create('acm_pushGroup', { groupId: groupId, push: push === 1 });
      }

      session.send(push ? '每日题目推送已开启，每天8:30准时推送' : '已关闭每日题目推送');
    });

  ctx
    .command('ep <problem:string>', '(EmplaceProblem)手动添加题目到题库')
    .alias('EmplaceProblem')
    .usage('emplace 1234/A 或\nemplace 1234A 或\nemplace [题目链接]')
    .action(async ({ session }, str) => {
      let contestId: number;
      let index: string;

      // 解析输入
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
      // 检查题目是否已存在
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

      // 获取题目信息
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

      // 确定难度等级
      let difficulty: number;
      if (problem.rating <= 1200) {
        difficulty = 1; // 简单
      } else if (problem.rating <= 2000) {
        difficulty = 2; // 中等
      } else {
        difficulty = 3; // 困难
      }

      // 添加题目到数据库
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

  ctx.cron('30 8 * * *', async () => {
    const groups = await ctx.database.get('acm_pushGroup', { push: true });
    if (groups.length === 0) {
      console.log('无群聊开启推送');
      return;
    }

    const groupIds = groups.map(group => 'onebot:' + group.groupId);

    try {
      // 获取题目池
      let { randomEasyProblems, randomMidProblems, randomHardProblems } = await getProblemList();
      const usedProblems = await ctx.database.get('acm_problems', { used: true });

      // 过滤掉已使用的题目
      const usedSet = new Set(usedProblems.map((p: any) => `${p.contestId}-${p.index}`));
      const filterUnused = (problems: any[]) =>
        problems.filter(p => !usedSet.has(`${p.contestId}-${p.index}`));

      randomEasyProblems = filterUnused(randomEasyProblems);
      randomMidProblems = filterUnused(randomMidProblems);
      randomHardProblems = filterUnused(randomHardProblems);

      // 分别获取三个难度的题目
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
}
