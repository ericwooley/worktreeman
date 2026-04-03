import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaInstallCard } from "./pwa-install-card";

function renderCard(status: Parameters<typeof PwaInstallCard>[0]["status"]) {
  return renderToStaticMarkup(<PwaInstallCard status={status} onInstall={() => undefined} />);
}

test("PwaInstallCard renders an active install button when the prompt is available", () => {
  const markup = renderCard("available");

  assert.match(markup, /Install app/);
  assert.match(markup, />Ready</);
  assert.match(markup, /ready to install/);
  assert.doesNotMatch(markup, /disabled=""/);
});

test("PwaInstallCard renders manual guidance while waiting for the browser prompt", () => {
  const markup = renderCard("manual");

  assert.match(markup, />Waiting</);
  assert.match(markup, /browser install menu/);
  assert.match(markup, /disabled=""/);
});

test("PwaInstallCard removes the button after installation", () => {
  const markup = renderCard("installed");

  assert.match(markup, />Installed</);
  assert.match(markup, /already installed/);
  assert.doesNotMatch(markup, /<button/);
});
