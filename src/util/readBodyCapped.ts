/**
 * Read a Web Fetch API Response body up to maxBytes without buffering unbounded data.
 * Same pattern as historically used in fetchImageUrl for HTTP image downloads.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}
