import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MatrixCard, MatrixCardDescription, MatrixCardFooter, MatrixCardTitle } from "./matrix-card";

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
