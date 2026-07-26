import { config } from "./config.js";

interface User {
  id: string;
  username: string;
  role: "admin" | "user";
}

const users: Map<string, User> = new Map();

export function authenticate(token: string): User | null {
  const user = users.get(token);
  return user ?? null;
}

export function register(username: string, role: "admin" | "user"): User {
  const user: User = { id: crypto.randomUUID(), username, role };
  const token = config.secret + username;
  users.set(token, user);
  return user;
}
