import changelogMarkdown from "../../../docs/CHANGELOG.md?raw";

export type ReleaseNote = {
  date: string;
  version: string;
  title: string;
  body: string;
};

function splitHeading(value: string): Pick<ReleaseNote, "version" | "title"> {
  const separator = value.search(/[：:]/);
  if (separator === -1) return { version: value.trim(), title: "" };
  return {
    version: value.slice(0, separator).trim(),
    title: value.slice(separator + 1).trim(),
  };
}

export function parseReleaseNotes(markdown: string): ReleaseNote[] {
  const headings = [...markdown.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/gm)];
  return headings.map((heading, index) => {
    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const meta = splitHeading(heading[2]!);
    return {
      date: heading[1]!,
      ...meta,
      body: markdown.slice(sectionStart, sectionEnd).trim(),
    };
  });
}

export const releaseNotes = parseReleaseNotes(changelogMarkdown);
