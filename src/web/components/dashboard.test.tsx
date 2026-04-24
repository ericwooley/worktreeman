import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";

async function renderNotificationStack(markupProps: {
  notifications: Array<{
    id: string;
    tone: "danger" | "warning" | "success" | "info";
    title: string;
    message: string;
    createdAt: string;
  }>;
}) {
  const originalSelf = globalThis.self;
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    writable: true,
    value: globalThis,
  });

  try {
    const { DashboardNotificationStack } = await import("./dashboard");
    return renderToStaticMarkup(
      <DashboardNotificationStack {...markupProps} onDismiss={() => undefined} />,
    );
  } finally {
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      writable: true,
      value: originalSelf,
    });
  }
}

test("DashboardNotificationStack renders stacked dismissible notifications", async () => {
  const markup = await renderNotificationStack({
    notifications: [
      {
        id: "toast-1",
        tone: "danger",
        title: "Request failed",
        message: "The branch merge failed.",
        createdAt: "2026-04-24T12:00:00.000Z",
      },
      {
        id: "toast-2",
        tone: "success",
        title: "Saved",
        message: "The document was updated.",
        createdAt: "2026-04-24T12:00:01.000Z",
      },
    ],
  });

  assert.match(markup, /fixed right-4 z-\[60\]/);
  assert.match(markup, /bottom:calc\(var\(--terminal-drawer-stowed-height\) \+ var\(--terminal-drawer-page-gap\) \+ 1rem\)/);
  assert.match(markup, />Request failed</);
  assert.match(markup, />Saved</);
  assert.match(markup, /The branch merge failed\./);
  assert.match(markup, /The document was updated\./);
  assert.match(markup, /Dismiss Request failed/);
  assert.match(markup, /Dismiss Saved/);
});

test("DashboardNotificationStack renders nothing when there are no notifications", async () => {
  const markup = await renderNotificationStack({ notifications: [] });

  assert.equal(markup, "");
});
