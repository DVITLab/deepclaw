/** True if the error is from AbortController.abort() (fetch / OpenAI client). */
export function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return true;
  const code = (e as { code?: string }).code;
  return code === "ERR_CANCELED" || code === "aborted";
}
