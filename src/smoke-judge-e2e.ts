// 临时 e2e：真实运行 judge 工具，验证 WA note（期望/实际对比）
import { judgeTool } from "../src/tools/judge.js";

const r = await judgeTool.execute("t1", {
  code: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b+1<<endl;}',
  tests: [
    { name: "样例1", stdin: "1 2\n", expectedOutput: "3\n" },
    { name: "样例2", stdin: "2 3\n", expectedOutput: "5\n" },
  ],
});
const d = r.details as any;
console.log("summary:", d.summary);
for (const t of d.tests) console.log(`  ${t.name} ${t.verdict} ${t.timeMs}ms note=${t.note ?? "-"}`);
