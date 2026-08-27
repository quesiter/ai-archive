import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = process.cwd();
const docsDirectory = resolve(root, "docs");
const requiredDocuments = [
  "00-文档索引.md",
  "01-产品功能与业务规则.md",
  "02-软件需求规格说明.md",
  "03-系统架构与详细设计.md",
  "04-界面与交互设计.md",
  "05-数据库设计.md",
  "06-接口设计.md",
  "07-测试与质量保证.md",
  "08-部署与发布.md",
  "09-运行维护.md",
  "10-用户使用手册.md",
  "11-Windows本地同步代理.md",
  "12-macOS本地同步代理.md",
  "13-版本变更记录.md",
];
const retiredDocumentNames = [
  "01-功能与业务规则审计.md",
  "02-需求基线.md",
  "03-架构概览.md",
  "04-系统设计.md",
  "05-界面设计.md",
  "06-数据模型.md",
  "07-接口文档.md",
  "08-用户手册.md",
  "09-部署文档.md",
  "10-运维手册.md",
  "13-变更历史.md",
  "14-V2.3发布冻结验收清单.md",
];

const errors = [];
const actualDocuments = readdirSync(docsDirectory)
  .filter((name) => name.toLowerCase().endsWith(".md"))
  .sort((a, b) => a.localeCompare(b, "zh-CN"));

for (const expected of requiredDocuments) {
  if (!actualDocuments.includes(expected)) errors.push(`缺少受控文档：docs/${expected}`);
}
for (const actual of actualDocuments) {
  if (!requiredDocuments.includes(actual)) errors.push(`存在未登记 Markdown 文档：docs/${actual}`);
}

const filesToCheck = [resolve(root, "README.md"), ...requiredDocuments.map((name) => resolve(docsDirectory, name))];
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of filesToCheck) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  if (!content.startsWith("# ")) {
    errors.push(`${relative(root, file)} 缺少一级标题`);
  }
  for (const retiredName of retiredDocumentNames) {
    if (content.includes(retiredName)) {
      errors.push(`${relative(root, file)} 仍引用已合并文档 ${retiredName}`);
    }
  }
  for (const match of content.matchAll(markdownLink)) {
    let target = match[1]?.trim() ?? "";
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split("#", 1)[0] ?? "";
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      errors.push(`${relative(root, file)} 包含无法解码的链接：${target}`);
      continue;
    }
    const resolvedTarget = resolve(dirname(file), target);
    if (!existsSync(resolvedTarget)) {
      errors.push(`${relative(root, file)} 包含断链：${target}`);
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`FAIL\t${error}`);
  process.exit(1);
}

console.log(`PASS\tDocumentation\t${requiredDocuments.length} numbered documents; links and retired names verified`);
