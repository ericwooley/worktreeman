import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadingOverlay } from "./LoadingOverlay";
import { CardLoadingBadge } from "./CardLoadingBadge";

test("LoadingOverlay renders nothing when not visible", () => {
  const markup = renderToStaticMarkup(<LoadingOverlay visible={false} label="Loading item…" />);
  assert.equal(markup, "");
  assert.doesNotMatch(markup, /Loading item/);
  assert.doesNotMatch(markup, /loading-overlay/);
});

test("LoadingOverlay renders sr-only live region and visual overlay when visible", () => {
  const markup = renderToStaticMarkup(<LoadingOverlay visible={true} label="Loading document…" />);

  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /aria-atomic="true"/);
  assert.match(markup, /sr-only/);
  assert.match(markup, /Loading document…/);
  assert.match(markup, /loading-overlay/);
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /matrix-spinner-sm/);
});

test("LoadingOverlay uses assertive aria-live when specified", () => {
  const markup = renderToStaticMarkup(
    <LoadingOverlay visible={true} label="Loading now" ariaLive="assertive" />,
  );

  assert.match(markup, /aria-live="assertive"/);
});

test("LoadingOverlay uses default label when none provided", () => {
  const markup = renderToStaticMarkup(<LoadingOverlay visible={true} />);

  assert.match(markup, /Loading…/);
});

test("CardLoadingBadge renders spinner and badge with label", () => {
  const markup = renderToStaticMarkup(<CardLoadingBadge label="Saving…" />);

  assert.match(markup, /matrix-spinner-sm/);
  assert.match(markup, /Saving…/);
  // MatrixBadge renders with theme-badge-* and border classes (no matrix-badge class in output)
  assert.match(markup, /theme-badge-neutral/);
  assert.match(markup, /inline-flex/);
});

test("CardLoadingBadge uses default label when none provided", () => {
  const markup = renderToStaticMarkup(<CardLoadingBadge />);

  assert.match(markup, /Loading…/);
  assert.match(markup, /matrix-spinner-sm/);
  assert.match(markup, /theme-badge-neutral/);
});

test("CardLoadingBadge renders in compact mode by default", () => {
  const markup = renderToStaticMarkup(<CardLoadingBadge label="Processing" />);
  assert.match(markup, /theme-badge-neutral/);
  assert.match(markup, /Processing/);
});
