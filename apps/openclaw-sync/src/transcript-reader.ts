import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";

export async function readTranscript(path: string, maxDecompressedBytes: number): Promise<string> {
  if (!/\.gz$/i.test(path)) return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const source = createReadStream(path);
  const decompressor = createGunzip();
  // pipe() does not forward source errors. A removed or unreadable transcript
  // must reject this read so the agent can continue with the remaining files.
  source.on("error", (error) => decompressor.destroy(error));
  source.pipe(decompressor);
  try {
    for await (const chunk of decompressor) {
      const buffer = Buffer.from(chunk as Buffer);
      totalBytes += buffer.length;
      if (totalBytes > maxDecompressedBytes) {
        throw new Error(`Decompressed transcript exceeds ${maxDecompressedBytes / (1024 * 1024)} MiB`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    source.destroy();
    decompressor.destroy();
  }
}
