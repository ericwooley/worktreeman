import express from "express";
import type {
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
} from "../../shared/types.js";
import {
  getBackgroundCommandEntries,
  getBackgroundCommandLogs,
  listBackgroundCommands,
  restartBackgroundCommand,
  startBackgroundCommand,
  stopBackgroundCommand,
  streamBackgroundCommandLogs,
} from "../services/background-command-service.js";
import type { ApiRouterContext } from "./api-router-context.js";

export function registerApiBackgroundCommandRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/worktrees/:branch/background-commands", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        context.repoRoot,
        worktree,
        (await context.operationalState.getRuntimeById(worktree.id)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/start", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await startBackgroundCommand({
        config,
        repoRoot: context.repoRoot,
        worktree,
        runtime: (await context.operationalState.getRuntimeById(worktree.id)) ?? undefined,
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        context.repoRoot,
        worktree,
        (await context.operationalState.getRuntimeById(worktree.id)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/stop", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await stopBackgroundCommand(context.repoRoot, worktree, decodedName);

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        context.repoRoot,
        worktree,
        (await context.operationalState.getRuntimeById(worktree.id)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/restart", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await restartBackgroundCommand({
        config,
        repoRoot: context.repoRoot,
        worktree,
        runtime: (await context.operationalState.getRuntimeById(worktree.id)) ?? undefined,
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        context.repoRoot,
        worktree,
        (await context.operationalState.getRuntimeById(worktree.id)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands/:name/logs", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const logs: BackgroundCommandLogsResponse = await getBackgroundCommandLogs(
        config,
        worktree,
        decodeURIComponent(req.params.name),
      );
      res.json(logs);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands/:name/logs/stream", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const commandName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[commandName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${commandName}` });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (payload: BackgroundCommandLogStreamEvent) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const history = await getBackgroundCommandLogs(config, worktree, commandName);
      writeEvent({ type: "snapshot", commandName: history.commandName, lines: history.lines });

      const dispose = await streamBackgroundCommandLogs({
        config,
        worktree,
        commandName,
        onEvent: (event) => writeEvent(event),
        onError: (message) => writeEvent({
          type: "append",
          commandName,
          lines: [{
            id: `stream-error:${Date.now()}`,
            source: "stderr",
            text: message,
            timestamp: new Date().toISOString(),
          }],
        }),
      });

      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        dispose();
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });
}
