import express from "express";
import { registerApiAiLogRoutes } from "./api-ai-log-routes.js";
import { registerApiBackgroundCommandRoutes } from "./api-background-command-routes.js";
import { registerApiGitRoutes } from "./api-git-routes.js";
import { registerApiProjectManagementRoutes } from "./api-project-management-routes.js";
import {
  createApiRouterContext,
} from "./api-router-context.js";
import { registerApiStateRoutes } from "./api-state-routes.js";
import { registerApiWorktreeRoutes } from "./api-worktree-routes.js";
import type { ApiRouterOptions } from "./api-types.js";

export function createApiRouter(options: ApiRouterOptions): express.Router {
  const router = express.Router();
  const context = createApiRouterContext(options);

  registerApiStateRoutes(router, context);
  registerApiAiLogRoutes(router, context);
  registerApiGitRoutes(router, context);
  registerApiProjectManagementRoutes(router, context);
  registerApiWorktreeRoutes(router, context);
  registerApiBackgroundCommandRoutes(router, context);

  return router;
}
