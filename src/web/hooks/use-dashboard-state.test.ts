import assert from "node:assert/strict";
import test from "#test-runtime";
import {
  appendDashboardNotification,
  dismissDashboardNotification,
  type DashboardNotification,
} from "./use-dashboard-state";

function createNotification(id: string, tone: DashboardNotification["tone"], title: string, message: string): DashboardNotification {
  return {
    id,
    tone,
    title,
    message,
    createdAt: `2026-04-24T12:00:0${id}.000Z`,
  };
}

test("appendDashboardNotification keeps the newest notifications within the stack limit", () => {
  const notifications = [
    createNotification("1", "info", "Started", "First request started."),
    createNotification("2", "success", "Saved", "Second request finished."),
  ];

  const next = appendDashboardNotification(
    notifications,
    createNotification("3", "danger", "Request failed", "Third request failed."),
    2,
  );

  assert.deepEqual(next.map((notification) => notification.id), ["2", "3"]);
});

test("dismissDashboardNotification removes only the targeted notification", () => {
  const notifications = [
    createNotification("1", "info", "Started", "First request started."),
    createNotification("2", "warning", "Check this request", "Background sync needs attention."),
    createNotification("3", "danger", "Request failed", "Third request failed."),
  ];

  const next = dismissDashboardNotification(notifications, "2");

  assert.deepEqual(next.map((notification) => notification.id), ["1", "3"]);
});
