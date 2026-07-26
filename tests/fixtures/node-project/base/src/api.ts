import { authenticate } from "./auth.js";

export function startServer(port: number): void {
  console.log(`Server starting on port ${port}`);
}

export function handleRequest(token: string, path: string): string {
  const user = authenticate(token);
  if (!user) {
    return "401 Unauthorized";
  }
  if (path === "/health") {
    return "200 OK";
  }
  return `200 Hello ${user.username}`;
}
