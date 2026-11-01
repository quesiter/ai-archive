import { describe, expect, it } from "vitest";
import { parseReleaseNotes, releaseNotes } from "./release-notes.js";

describe("parseReleaseNotes", () => {
  it("keeps releases in source order and separates version metadata", () => {
    const notes = parseReleaseNotes(`# 变更历史

## 2026-08-22 V2.0.0：当前版本

- 第一项

## 2026-08-17 V1.9.0：上一版本

- 第二项
`);

    expect(notes).toEqual([
      {
        date: "2026-08-22",
        version: "V2.0.0",
        title: "当前版本",
        body: "- 第一项",
      },
      {
        date: "2026-08-17",
        version: "V1.9.0",
        title: "上一版本",
        body: "- 第二项",
      },
    ]);
  });

  it("supports legacy headings without a description", () => {
    expect(parseReleaseNotes("## 2026-07-24 v14 及更早\n\n- 初始能力")[0]).toMatchObject({
      version: "v14 及更早",
      title: "",
    });
  });

  it("keeps one group per day and retains all merged update topics", () => {
    expect(new Set(releaseNotes.map(note=>note.date)).size).toBe(releaseNotes.length);
    expect(releaseNotes[0]).toMatchObject({date:"2026-11-01",version:"V2.4.12",title:"性能优化、采集适配与归档核验"});
    for (const topic of ["词条", "追加采集", "全文副本", "豆包", "Grok Build", "备份恢复", "Date"]) expect(releaseNotes[0]!.body).toContain(topic);
    expect(releaseNotes.filter(note=>note.date === "2026-11-01")).toHaveLength(1);
    expect(releaseNotes[0]!.body).not.toMatch(/V2\.4\.(?:9|10|11)\b/);
    const october = releaseNotes.find(note=>note.date === "2026-10-26")!;
    expect(october.version).toBe("V2.4.8");
    for (const topic of ["Retry-After", "不自动重放", "设备上报版本", "项目分类证据策略"]) expect(october.body).toContain(topic);
    const performance = releaseNotes.find(note=>note.date === "2026-10-25")!;
    expect(performance).toMatchObject({version:"V2.4.7",title:"性能与稳定性完善"});
    expect(performance.body).toContain("Chokidar 4"); expect(performance.body).toContain("可用内存");
    const recapture = releaseNotes.find(note=>note.date === "2026-10-08")!;
    expect(recapture.body).toContain("0025_recapture_jobs"); expect(recapture.body).toContain("逐条重新读取原会话");
    const merged = releaseNotes.find(note=>note.date === "2026-10-07")!;
    expect(merged.version).toBe("V2.4.3"); expect(merged.body).toContain("三端组件统一更新");
    expect(releaseNotes.find(note=>note.date === "2026-09-19")?.version).toBe("V2.4.0");
  });
});
