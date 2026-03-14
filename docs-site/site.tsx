import { marked } from "marked";
import { AmbientCanvasBackground, docsAmbientPalette } from "../src/web/components/ambient-canvas-background";

const markdownModules = import.meta.glob("../docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface DocPage {
  index: string;
  slug: string;
  title: string;
  excerpt: string;
  html: string;
}

const docs = Object.entries(markdownModules)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([filePath, markdown]) => {
    const slug = filePath
      .split("/")
      .pop()
      ?.replace(/\.md$/, "")
      .replace(/^\d+-/, "") ?? "doc";
    const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? slug;

    return {
      index: filePath.match(/\/(\d+)-/)?.[1] ?? "00",
      slug,
      title,
      excerpt: extractExcerpt(markdown),
      html: marked.parse(markdown) as string,
    } satisfies DocPage;
  });

const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));

export function DocsSite() {
  const currentSlug = getCurrentSlug();
  const currentDoc = docsBySlug.get(currentSlug) ?? docs[0];

  return (
    <main className="docs-shell relative min-h-screen overflow-hidden text-ink">
      <AmbientCanvasBackground palette={docsAmbientPalette} />

      <section className="relative z-10 overflow-hidden border-b border-ink/10">
        <div className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
            <div className="docs-hero-panel reveal-up">
              <p className="docs-kicker">Standalone docs website</p>
              <h1 className="mt-4 max-w-4xl text-5xl tracking-tight sm:text-6xl lg:text-7xl">Worktree Manager Field Guide</h1>
              <p className="mt-5 max-w-3xl text-base leading-8 text-ink/72 sm:text-lg">
                A publishable reference site generated entirely from Markdown in `docs/`, with each source file rendered as its own static page.
              </p>
              <div className="mt-8 flex flex-wrap gap-3 text-sm">
                <a href={toDocHref(docs[0]?.slug)} className="docs-pill docs-pill-solid">
                  Start with overview
                </a>
                <a href={toDocHref("publishing-docs")} className="docs-pill docs-pill-ghost">
                  Publishing notes
                </a>
              </div>
            </div>

            <div className="grid gap-4 reveal-up-delayed sm:grid-cols-2 lg:grid-cols-1">
              <InfoTile eyebrow="Source" title="Markdown only" body="Every doc page comes from `docs/*.md`. The site layer only handles layout and navigation." />
              <InfoTile eyebrow="Output" title="Static pages" body="Each markdown file is emitted as its own publishable page under `dist/docs/<slug>/index.html`." />
            </div>
          </div>
        </div>
      </section>

      <section className="relative z-10 mx-auto grid max-w-7xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[19rem_minmax(0,1fr)] lg:px-8">
        <aside className="docs-rail h-fit lg:sticky lg:top-6">
          <div className="docs-rail-card">
            <p className="docs-kicker text-ink/55">Pages</p>
            <nav className="mt-4 flex flex-col gap-2 text-sm">
              {docs.map((doc) => {
                const isCurrent = doc.slug === currentDoc.slug;

                return (
                  <a key={doc.slug} href={toDocHref(doc.slug)} className={`docs-toc-item ${isCurrent ? "docs-toc-item-current" : ""}`}>
                    <span className="docs-toc-index">{doc.index}</span>
                    <span>
                      <strong className="block font-medium text-ink">{doc.title}</strong>
                      <span className="mt-1 block text-xs leading-5 text-ink/55">{doc.excerpt}</span>
                    </span>
                  </a>
                );
              })}
            </nav>
          </div>

          <div className="docs-rail-note">
            <p className="docs-kicker text-ink/55">Publishing model</p>
            <p className="mt-3 text-sm leading-6 text-ink/68">
              The CLI serves the local app. This docs site is a separate static artifact built for publishing.
            </p>
          </div>
        </aside>

        <div className="space-y-6">
          <section className="grid gap-4 md:grid-cols-3">
            {docs.map((doc) => (
              <a key={`${doc.slug}-card`} href={toDocHref(doc.slug)} className={`docs-summary-card reveal-up ${doc.slug === currentDoc.slug ? "docs-summary-card-current" : ""}`}>
                <div className="flex items-start justify-between gap-4">
                  <span className="docs-summary-index">{doc.index}</span>
                  <span className="text-xs uppercase tracking-[0.24em] text-ink/40">Page</span>
                </div>
                <h2 className="mt-4 text-2xl text-ink">{doc.title}</h2>
                <p className="mt-3 text-sm leading-6 text-ink/68">{doc.excerpt}</p>
              </a>
            ))}
          </section>

          <section className="docs-article-shell reveal-up">
            <div className="flex flex-col gap-4 border-b border-ink/10 pb-6 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="docs-kicker text-ink/50">Page {currentDoc.index}</p>
                <h2 className="mt-3 text-4xl tracking-tight text-ink sm:text-5xl">{currentDoc.title}</h2>
              </div>
              <div className="docs-meta-chip">{currentDoc.slug}</div>
            </div>
            <article className="docs-prose" dangerouslySetInnerHTML={{ __html: currentDoc.html }} />
          </section>
        </div>
      </section>
    </main>
  );
}

function getCurrentSlug(): string {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);

  if (!lastSegment || lastSegment.endsWith(".html")) {
    return docs[0]?.slug ?? "overview";
  }

  return lastSegment;
}

function toDocHref(slug: string | undefined): string {
  if (!slug) {
    return "/";
  }

  return slug === docs[0]?.slug ? "/" : `/${slug}/`;
}

function extractExcerpt(markdown: string): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("```"));

  const paragraph = lines.find((line) => !line.startsWith("-") && !/^\d+\./.test(line));
  return paragraph ? stripMarkdown(paragraph) : "Documentation generated from Markdown source.";
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function InfoTile({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <article className="docs-info-tile">
      <p className="docs-kicker text-ink/45">{eyebrow}</p>
      <h2 className="mt-3 text-3xl tracking-tight text-ink">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-ink/68">{body}</p>
    </article>
  );
}
