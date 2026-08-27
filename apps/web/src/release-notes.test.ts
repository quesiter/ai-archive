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

  it("shows the latest maintained changelog entry first", () => {
    expect(releaseNotes[0]).toMatchObject({
      date: "2026-08-28",
      version: "V2.3.0",
      title: "长期归档可靠性与运维可诊断性",
    });
    expect(releaseNotes[0]?.body).toContain("Restore Job");
    expect(releaseNotes[0]?.body).toContain("Archive Integrity Check");
  });
});
