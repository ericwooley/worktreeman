import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { MatrixCard, MatrixCardDescription, MatrixCardFooter, MatrixCardHeader, MatrixCardTitle } from "./matrix-card";

test("MatrixCard renders shared chrome classes and supports div roots", () => {
  const articleMarkup = renderToStaticMarkup(
    <MatrixCard selected interactive className="p-3">
      <MatrixCardTitle lines={2} title="A very important title">A very important title</MatrixCardTitle>
      <MatrixCardDescription lines={3} title="Helpful supporting copy">Helpful supporting copy</MatrixCardDescription>
      <MatrixCardFooter className="mt-3">Footer metadata</MatrixCardFooter>
    </MatrixCard>,
  );

  assert.match(articleMarkup, /^<article class="matrix-card matrix-card-selected matrix-card-interactive p-3">/);
  assert.match(articleMarkup, /matrix-card-title theme-text-strong matrix-card-clamp-2/);
  assert.match(articleMarkup, /matrix-card-description theme-text-muted matrix-card-clamp-3/);
  assert.match(articleMarkup, /matrix-card-footer mt-3/);

  const divMarkup = renderToStaticMarkup(
    <MatrixCard as="div" interactive>
      <span>Nested in a button-safe container</span>
    </MatrixCard>,
  );

  assert.match(divMarkup, /^<div class="matrix-card matrix-card-interactive">/);
  assert.doesNotMatch(divMarkup, /^<article/);
});

test("MatrixCardHeader keeps titles, copy, badges, and actions grouped together", () => {
  const markup = renderToStaticMarkup(
    <MatrixCard as="div" interactive className="p-3">
      <MatrixCardHeader
        eyebrow={<span>Board item</span>}
        title="A very important title"
        titleText="A very important title"
        description="Helpful supporting copy that can clamp when space gets tight."
        descriptionText="Helpful supporting copy that can clamp when space gets tight."
        badges={<span>Running</span>}
        actions={<button type="button">Open</button>}
      />
      <MatrixCardFooter className="mt-3">Footer metadata</MatrixCardFooter>
    </MatrixCard>,
  );

  assert.match(markup, /matrix-card-header/);
  assert.match(markup, /matrix-card-header-main/);
  assert.match(markup, /matrix-card-header-side/);
  assert.match(markup, /matrix-card-eyebrow/);
  assert.match(markup, /matrix-card-badge-row/);
  assert.match(markup, /matrix-card-actions/);
  assert.match(markup, /A very important title/);
  assert.match(markup, /Helpful supporting copy/);
  assert.match(markup, />Running</);
  assert.match(markup, />Open</);
});
