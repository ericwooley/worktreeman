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
      <section className="relative z-10 mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[19rem_minmax(0,1fr)] lg:px-8 lg:py-10">
        <aside className="docs-rail h-fit lg:sticky lg:top-6">
          <div className="docs-rail-card">
            <p className="docs-kicker text-ink/55">Guide</p>
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
            <p className="docs-kicker text-ink/55">Use the tool</p>
            <p className="mt-3 text-sm leading-6 text-ink/68">
              Start with Overview, then Getting Started, then keep Configuration and Runtime open while you wire your repository.
            </p>
          </div>
        </aside>

        <section className="docs-article-shell reveal-up">
          <article className="docs-prose" dangerouslySetInnerHTML={{ __html: currentDoc.html }} />
        </section>
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
  return paragraph ? stripMarkdown(paragraph) : "Worktree Manager usage guide.";
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
