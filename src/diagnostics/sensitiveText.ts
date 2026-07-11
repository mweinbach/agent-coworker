const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:token|secret|api[ _-]?key|apikey|password|authorization|cookie|credential|private[ _-]?key|session[ _-]?id)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'\s,;}{]{6,})/gi;
const BODY_ASSIGNMENT_PATTERN =
  /\b(?:system[_ -]?prompt|prompt|completion|stdout|stderr|command(?:[_ -]?(?:failed|line))?|shell[_ -]?command|file[_ -]?content|contents|transcript|messages|request[_ -]?body|response[_ -]?body|body|form[_ -]?data|payload|response)(?:tail|text|json|data|content|line)?\b\s*[:=]\s*[^\n\r]*/gim;
const COMMON_SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g;
const CREDENTIAL_URL_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function looksLikeJsonBody(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 24) return false;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  return /"(?:prompt|completion|messages|body|payload|response|token|api[_-]?key|secret)"/i.test(
    trimmed,
  );
}

export function redactSensitiveText(value: string): string {
  const redacted = value
    .replace(PRIVATE_KEY_PATTERN, "[redacted-secret]")
    .replace(BEARER_PATTERN, "$1 [redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1=[redacted]")
    .replace(CREDENTIAL_URL_PATTERN, "$1[redacted]@")
    .replace(COMMON_SECRET_VALUE_PATTERN, "[redacted-secret]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(BODY_ASSIGNMENT_PATTERN, "[redacted-body]");

  return looksLikeJsonBody(redacted) ? "[redacted-json-body]" : redacted;
}
