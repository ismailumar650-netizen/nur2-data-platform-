export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  return authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}
