// 学习统计：解析 knowledge.md 的勾选状态 / 官方难度【n】/ 掌握等级备注，产出 /stats 面板数据。
// 纯函数无渲染依赖，冒烟测试直接喂字符串。
import { readFileSync } from "node:fs";
import { KNOWLEDGE_PROMPT_PATH } from "./prompts.js";

export interface StatsSection {
  title: string;
  total: number;
  mastered: number;
}

export interface KnowledgeStats {
  total: number;
  mastered: number;
  /** 一级章节（## 标题）分组；无章节的条目归入「未分组」 */
  sections: StatsSection[];
  /** 掌握等级 → 已掌握条数（来源「（等级 N：…）」备注，仅统计已勾选条目） */
  grades: Map<number, number>;
  /** 官方难度【n】 → [已掌握, 总数]，按难度升序 */
  difficulties: Array<{ level: number; mastered: number; total: number }>;
}

const CHECKBOX_RE = /^(\s*)- \[( |x)\] (.*)$/;
const DIFFICULTY_RE = /【(\d+)】/;
const GRADE_RE = /（等级\s*(\d+)/;

export function parseKnowledgeStats(content: string): KnowledgeStats {
  const lines = content.split("\n");
  const sections: StatsSection[] = [];
  const grades = new Map<number, number>();
  const diffMap = new Map<number, { mastered: number; total: number }>();
  let current: StatsSection | null = null;
  let total = 0;
  let mastered = 0;

  const sectionFor = (title: string): StatsSection => {
    let s = sections.find((x) => x.title === title);
    if (!s) {
      s = { title, total: 0, mastered: 0 };
      sections.push(s);
    }
    return s;
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2?.[1]) {
      current = sectionFor(h2[1]!);
      continue;
    }
    const m = line.match(CHECKBOX_RE);
    if (!m) continue;
    const checked = m[2] === "x";
    const text = m[3]!;
    total++;
    if (!current) current = sectionFor("未分组");
    current.total++;
    const diff = text.match(DIFFICULTY_RE)?.[1];
    if (diff) {
      const d = diffMap.get(Number(diff)) ?? { mastered: 0, total: 0 };
      d.total++;
      diffMap.set(Number(diff), d);
    }
    if (!checked) continue;
    mastered++;
    current.mastered++;
    if (diff) diffMap.get(Number(diff))!.mastered++;
    const grade = text.match(GRADE_RE)?.[1];
    if (grade) grades.set(Number(grade), (grades.get(Number(grade)) ?? 0) + 1);
  }

  const difficulties = [...diffMap.entries()]
    .map(([level, d]) => ({ level, ...d }))
    .sort((a, b) => a.level - b.level);

  return { total, mastered, sections, grades, difficulties };
}

export function readKnowledgeStats(path = KNOWLEDGE_PROMPT_PATH): KnowledgeStats {
  return parseKnowledgeStats(readFileSync(path, "utf8"));
}
