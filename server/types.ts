/**
 * Shared type definitions for server
 */
import type { Request } from "express";
import type { User } from "../drizzle/schema";

/**
 * Express request with authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user: User;
}

/**
 * Express request that may have a user attached
 */
export interface MaybeAuthenticatedRequest extends Request {
  user?: User;
}
