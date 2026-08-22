import { eq } from "drizzle-orm";
import safeRegex from "safe-regex2";
import { db } from "../db.js";
import { redactionRules } from "../schema.js";

type Replacement = string | ((match: string, ...groups: string[]) => string);
type RedactionPattern = readonly [RegExp, Replacement];

export type CompiledCustomRedactionRule = {
  pattern: RegExp;
  replacement: string;
};

export type RedactionResult = {
  text: string;
  replacements: number;
};

export type SequenceRedactionResult = {
  texts: string[];
  replacements: number;
};

export type SecurityRuleTemplate = {
  name: string;
  pattern: string;
  replacement: string;
};

export const SECURITY_RULE_PACK: readonly SecurityRuleTemplate[] = [
  {
    name: "密码与密钥赋值",
    pattern:
      String.raw`(?:password|passwd|pwd|passphrase|密码|口令|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*(?::|=|is|是|为)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；&#]+)`,
    replacement: "[SECRET_ASSIGNMENT]",
  },
  {
    name: "Authorization 请求头",
    pattern: String.raw`authorization\s*:\s*[^\r\n]+`,
    replacement: "[AUTHORIZATION]",
  },
  {
    name: "数据库连接地址",
    pattern:
      String.raw`(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s"'<>]+`,
    replacement: "[DATABASE_URL]",
  },
  {
    name: "SSH/SFTP 登录命令",
    pattern:
      String.raw`(?:ssh|sftp)\s+[^\r\n@]{0,300}@[A-Za-z0-9.:[\]-]+[^\r\n]{0,300}`,
    replacement: "[SSH_LOGIN]",
  },
  {
    name: "主机端口与账号密码",
    pattern:
      String.raw`(?:[0-9.]{7,15}|[A-Za-z0-9.-]{1,253}):[0-9]{2,5}\s+[A-Za-z0-9._-]{1,64}\/[^\s\r\n]{3,200}`,
    replacement: "[SSH_LOGIN]",
  },
  {
    name: "私钥块",
    pattern:
      String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{1,200000}?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`,
    replacement: "[PRIVATE_KEY]",
  },
  {
    name: "常见平台访问令牌",
    pattern:
      String.raw`(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,255}|AIza[0-9A-Za-z_-]{30,})`,
    replacement: "[ACCESS_TOKEN]",
  },
] as const;

const securityPatterns: readonly RedactionPattern[] = [
  [
    /-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    "[PRIVATE_KEY]",
  ],
  [
    /((?:["']?)(?:password|passwd|pwd|passphrase|密码|口令|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(?:["']?)\s*(?::|=|is|是|为)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；&#]+)/gi,
    (_match, prefix) => `${prefix}[REDACTED]`,
  ],
  [
    /((?:--)(?:password|passwd|passphrase|api-key|token|secret|client-secret|access-token)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (_match, prefix) => `${prefix}[REDACTED]`,
  ],
  [/(authorization\s*:\s*)[^\r\n]+/gi, (_match, prefix) => `${prefix}[REDACTED]`],
  [
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s"'<>]+/gi,
    "[DATABASE_URL]",
  ],
  [
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@[^\s"'<>]+/gi,
    "[AUTHENTICATED_URL]",
  ],
  [
    /(?<![\w.])(?:(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9.-]+):\d{2,5}\s+(?:[A-Za-z0-9._-]{1,64})\/[^\s\r\n]{3,}/g,
    "[SSH_LOGIN]",
  ],
  [
    /\b(?:ssh|sftp)\s+(?:(?:-[A-Za-z]\s+\S+|-[A-Za-z]+)\s+)*[A-Za-z0-9._-]+@[A-Za-z0-9.:[\]-]+[^\r\n]*/gi,
    "[SSH_LOGIN]",
  ],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,255}|AIza[0-9A-Za-z_-]{30,})\b/g,
    "[ACCESS_TOKEN]",
  ],
  [/\b(?:sk|api|key|token)[-_][A-Za-z0-9_-]{16,}\b/gi, "[API_KEY]"],
  [
    /\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    "[TOKEN]",
  ],
];

const privateKeyBeginPattern =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i;
const privateKeyEndPattern =
  /-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i;

const cloudPrivacyPatterns: readonly RedactionPattern[] = [
  [/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "[PHONE]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]"],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, "[CN_ID]"],
  [/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, "[CARD_NUMBER]"],
  [/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, "[IP_ADDRESS]"],
  [
    /(?<![@\w-])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?![\w-])/gi,
    "[DOMAIN]",
  ],
];

function applyPatterns(
  input: string,
  patterns: readonly RedactionPattern[],
): RedactionResult {
  let text = input;
  let replacements = 0;
  for (const [pattern, replacement] of patterns) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (...args: unknown[]) => {
      replacements += 1;
      if (typeof replacement === "string") return replacement;
      return replacement(String(args[0] ?? ""), ...args.slice(1, -2).map(String));
    });
  }
  return { text, replacements };
}

function applyCustomRules(
  input: string,
  rules: readonly CompiledCustomRedactionRule[],
): RedactionResult {
  let text = input;
  let replacements = 0;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, () => {
      replacements += 1;
      return rule.replacement;
    });
  }
  return { text, replacements };
}

export function validateCustomRedactionPattern(pattern: string): void {
  if (!safeRegex(pattern)) throw new Error("Regular expression is too complex");
  new RegExp(pattern, "giu");
}

export function compileCustomRedactionRules(
  rules: ReadonlyArray<{ pattern: string; replacement: string; enabled?: boolean }>,
): CompiledCustomRedactionRule[] {
  const compiled: CompiledCustomRedactionRule[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    try {
      validateCustomRedactionPattern(rule.pattern);
      compiled.push({
        pattern: new RegExp(rule.pattern, "giu"),
        replacement: rule.replacement,
      });
    } catch {
      // Ignore invalid legacy rules rather than breaking capture or analysis.
    }
  }
  return compiled;
}

export async function loadEnabledCustomRedactionRules(): Promise<
  CompiledCustomRedactionRule[]
> {
  const rules = await db
    .select()
    .from(redactionRules)
    .where(eq(redactionRules.enabled, true));
  return compileCustomRedactionRules(rules);
}

export function redactSensitiveTextForStorage(
  input: string,
  customRules: readonly CompiledCustomRedactionRule[] = [],
): RedactionResult {
  const builtin = applyPatterns(input, securityPatterns);
  const custom = applyCustomRules(builtin.text, customRules);
  return {
    text: custom.text,
    replacements: builtin.replacements + custom.replacements,
  };
}

export function redactSensitiveTextSequenceForStorage(
  inputs: readonly string[],
  customRules: readonly CompiledCustomRedactionRule[] = [],
): SequenceRedactionResult {
  const texts: string[] = [];
  let replacements = 0;
  let insideFragmentedPrivateKey = false;

  for (const input of inputs) {
    if (insideFragmentedPrivateKey) {
      const end = privateKeyEndPattern.exec(input);
      if (!end) {
        texts.push("[PRIVATE_KEY]");
        replacements += 1;
        continue;
      }
      const tail = redactSensitiveTextForStorage(
        input.slice(end.index + end[0].length),
        customRules,
      );
      texts.push(`[PRIVATE_KEY]${tail.text}`);
      replacements += 1 + tail.replacements;
      insideFragmentedPrivateKey = false;
      continue;
    }

    const begin = privateKeyBeginPattern.exec(input);
    if (begin) {
      const afterBegin = input.slice(begin.index + begin[0].length);
      if (!privateKeyEndPattern.test(afterBegin)) {
        const prefix = redactSensitiveTextForStorage(
          input.slice(0, begin.index),
          customRules,
        );
        texts.push(`${prefix.text}[PRIVATE_KEY]`);
        replacements += prefix.replacements + 1;
        insideFragmentedPrivateKey = true;
        continue;
      }
    }

    const redacted = redactSensitiveTextForStorage(input, customRules);
    texts.push(redacted.text);
    replacements += redacted.replacements;
  }

  return { texts, replacements };
}

export function redactSensitiveUrlForStorage(
  input: string,
  customRules: readonly CompiledCustomRedactionRule[] = [],
): RedactionResult {
  let text = input;
  let replacements = 0;
  try {
    const parsed = new URL(input);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      replacements += 1;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:password|passwd|secret|token|api[_-]?key|credential|signature)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
        replacements += 1;
      }
    }
    text = parsed.toString();
  } catch {
    // Non-URL legacy values still pass through the text redactor below.
  }
  const redacted = redactSensitiveTextForStorage(text, customRules);
  const totalReplacements = replacements + redacted.replacements;
  if (totalReplacements > 0) {
    try {
      new URL(redacted.text);
    } catch {
      return { text: "https://redacted.invalid/", replacements: totalReplacements };
    }
  }
  return { text: redacted.text, replacements: totalReplacements };
}

export async function redactForStorage(input: string): Promise<RedactionResult> {
  return redactSensitiveTextForStorage(input, await loadEnabledCustomRedactionRules());
}

export async function redactForCloud(input: string): Promise<RedactionResult> {
  const secure = applyPatterns(input, securityPatterns);
  const privateText = applyPatterns(secure.text, cloudPrivacyPatterns);
  const custom = applyCustomRules(
    privateText.text,
    await loadEnabledCustomRedactionRules(),
  );
  return {
    text: custom.text,
    replacements:
      secure.replacements + privateText.replacements + custom.replacements,
  };
}
