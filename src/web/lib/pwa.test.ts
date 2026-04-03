import assert from "node:assert/strict";
import test from "#test-runtime";
import { isPwaInstalled, registerPwaServiceWorker } from "./pwa";

test("isPwaInstalled returns true for standalone display mode and iOS standalone", () => {
  assert.equal(
    isPwaInstalled({
      matchMedia: (query) => ({ matches: query === "(display-mode: standalone)" }),
      navigator: { standalone: false },
    }),
    true,
  );

  assert.equal(
    isPwaInstalled({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: true },
    }),
    true,
  );
});

test("isPwaInstalled returns false when the app is not running standalone", () => {
  assert.equal(
    isPwaInstalled({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: false },
    }),
    false,
  );
});

test("registerPwaServiceWorker registers the default service worker path", async () => {
  const registrations: Array<{ scriptUrl: string; scope?: string }> = [];

  const registered = await registerPwaServiceWorker({
    register: async (scriptUrl, options) => {
      registrations.push({ scriptUrl, scope: options?.scope });
      return {};
    },
  });

  assert.equal(registered, true);
  assert.deepEqual(registrations, [{ scriptUrl: "/sw.js", scope: "/" }]);
});

test("registerPwaServiceWorker returns false when unsupported or registration fails", async () => {
  assert.equal(await registerPwaServiceWorker(null), false);

  const registered = await registerPwaServiceWorker({
    register: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(registered, false);
});
