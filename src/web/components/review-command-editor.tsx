import { useEffect, useMemo, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const REVIEW_COMMAND_HIGHLIGHT_REGEX = /@(ai|review)\b/gi;

function buildEditorDocument(value: string) {
  return {
    type: "doc",
    content: value.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

function renderCommandHighlightFallback(value: string) {
  if (!value) {
    return null;
  }

  return value.split(REVIEW_COMMAND_HIGHLIGHT_REGEX).reduce<Array<string | ReactNode>>((parts, part, index, source) => {
    if (index % 2 === 1) {
      const token = `@${part}`;
      parts.push(
        <span key={`${index}-${token}`} className="review-command-token">
          {token}
        </span>,
      );
      return parts;
    }

    if (part) {
      parts.push(part);
    }

    if (index < source.length - 1 && index % 2 === 0 && source[index + 1]) {
      return parts;
    }

    return parts;
  }, []);
}

const ReviewCommandHighlightExtension = Extension.create({
  name: "reviewCommandHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("review-command-highlight"),
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];

            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) {
                return;
              }

              REVIEW_COMMAND_HIGHLIGHT_REGEX.lastIndex = 0;
              const text = node.textContent;
              let match = REVIEW_COMMAND_HIGHLIGHT_REGEX.exec(text);

              while (match) {
                const start = pos + 1 + match.index;
                const end = start + match[0].length;
                decorations.push(Decoration.inline(start, end, { class: "review-command-token" }));
                match = REVIEW_COMMAND_HIGHLIGHT_REGEX.exec(text);
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export function getReviewCommandToken(value: string) {
  const match = value.trimStart().match(/^@(ai|review)\b/i);
  const token = match?.[1]?.toLowerCase();
  return token === "ai" || token === "review" ? token : null;
}

export function ReviewCommandEditor({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (nextValue: string) => void;
}) {
  const initialContent = useMemo(() => buildEditorDocument(value), []);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        orderedList: false,
        strike: false,
      }),
      Placeholder.configure({
        emptyEditorClass: "review-command-editor-empty",
        placeholder,
      }),
      ReviewCommandHighlightExtension,
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: "matrix-input review-command-editor min-h-[9rem] w-full rounded-none px-3 py-3 text-sm outline-none",
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getText({ blockSeparator: "\n" }));
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const currentValue = editor.getText({ blockSeparator: "\n" });
    if (currentValue === value) {
      return;
    }

    editor.commands.setContent(buildEditorDocument(value), { emitUpdate: false });
  }, [editor, value]);

  if (typeof window === "undefined") {
    return (
      <div className="matrix-input review-command-editor min-h-[9rem] w-full rounded-none px-3 py-3 text-sm outline-none">
        {value ? renderCommandHighlightFallback(value) : <span className="theme-text-muted">{placeholder}</span>}
      </div>
    );
  }

  if (!editor) {
    return <div className="matrix-input review-command-editor min-h-[9rem] w-full rounded-none px-3 py-3 text-sm outline-none" />;
  }

  return <EditorContent editor={editor} />;
}
