/**
 * Heuristic: shell commands that require Telegram confirmation when
 * DEEPCLAW_SHELL_APPROVAL is not off (default: on = risky commands only).
 */
export function isDangerousShellCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  const lower = c.toLowerCase();

  if (/\brm\s+(-[a-z]*f[a-z]*r[a-z]*|-[a-z]*r[a-z]*f[a-z]*)\b/.test(lower)) {
    return true;
  }
  if (/\brm\s+.*\s(-[a-z]*f[a-z]*r[a-z]*|-[a-z]*r[a-z]*f[a-z]*)\b/.test(lower)) {
    return true;
  }
  if (/\brm\s+(-[fr]+|--force)\b.*[/~]/.test(lower)) {
    return true;
  }
  if (/\/dev\/(sd|nvme|vd|hd|loop)/.test(c)) {
    return true;
  }
  if (/\bdd\s+if=/.test(lower)) {
    return true;
  }
  if (/\b(mkfs|fdisk|cfdisk|parted|wipefs)\b/.test(lower)) {
    return true;
  }
  if (/\b(shutdown|reboot|poweroff|halt|init\s+0)\b/.test(lower)) {
    return true;
  }
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(lower)) {
    return true;
  }
  if (/\bchmod\s+[-+0-9]*777\b/.test(lower) && /[\s/]/.test(c)) {
    return true;
  }
  if (/\biptables\b/.test(lower) && /\b(-F|--flush)\b/.test(lower)) {
    return true;
  }
  if (/\buserdel\b|\bpasswd\s+root\b/.test(lower)) {
    return true;
  }
  if (/\bcurl\s+[^|]+\|\s*sudo\b/.test(lower)) {
    return true;
  }
  if (/\bsudo\s+rm\b/.test(lower) && /-rf\b|-fr\b/.test(lower)) {
    return true;
  }
  if (/\brm\s+.*-(?:rf|fr)\s+[/~]/.test(lower)) {
    return true;
  }
  if (/\brm\s+-\w*rf\w*\s+\/(?:\s|;|&&|\||&|$)/.test(lower)) {
    return true;
  }
  if (/:\(\)\s*\{/.test(lower) && /:\|:|&;/.test(lower)) {
    return true;
  }
  if (/\bkill\s+(?:-[a-z0-9]*9[a-z0-9]*\s+|\s+-9\s+)1\b/.test(lower)) {
    return true;
  }
  if (/\bchmod\s+-R\s+[-+0-9]*777\b/.test(lower)) {
    return true;
  }
  if (/[>]{1,2}\s*\/dev\/(sd|nvme|vd|hd|mmcblk|loop)/.test(lower)) {
    return true;
  }
  if (/\bchown\s+-R\s+root:/.test(lower) && /\s[/~]/.test(c)) {
    return true;
  }
  return false;
}
