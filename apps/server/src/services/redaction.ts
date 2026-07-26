import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { redactionRules } from "../schema.js";

const builtinPatterns: Array<[RegExp, string]> = [
  [/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "[PHONE]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]"],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, "[CN_ID]"],
  [/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, "[CARD_NUMBER]"],
  [/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, "[IP_ADDRESS]"],
  [
    /(?<![@\w-])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?![\w-])/gi,
    "[DOMAIN]",
  ],
  [
    /\b(?:sk|api|key|token)[-_][A-Za-z0-9_-]{16,}\b/gi,
    "[API_KEY]",
  ],
  [
    /\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    "[TOKEN]",
  ],
];

export async function redactForCloud(input: string): Promise<{
  text: string;
  replacements: number;
}> {
  let text = input;
  let replacements = 0;
  for (const [pattern, replacement] of builtinPatterns) {
    text = text.replace(pattern, () => {
      replacements += 1;
      return replacement;
    });
  }
  const customRules = await db
    .select()
    .from(redactionRules)
    .where(eq(redactionRules.enabled, true));
  for (const rule of customRules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.pattern, "gu");
    } catch {
      continue;
    }
    text = text.replace(pattern, () => {
      replacements += 1;
      return rule.replacement;
    });
  }
  return { text, replacements };
}
