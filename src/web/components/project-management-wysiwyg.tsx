import { useEffect, useRef } from "react";
import { Editor } from "@toast-ui/react-editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import { useTheme } from "./theme-provider";

interface ToastEditorHandle {
  getInstance(): {
    getMarkdown(): string;
    setMarkdown(markdown: string, cursorToEnd?: boolean): void;
  };
}

interface ProjectManagementWysiwygProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
}

export function ProjectManagementWysiwyg({
  value,
  onChange,
  height = "65vh",
  readOnly = false,
}: ProjectManagementWysiwygProps) {
  const { theme } = useTheme();
  const editorRef = useRef<ToastEditorHandle | null>(null);
  const lastValueRef = useRef(value);

  useEffect(() => {
    const instance = editorRef.current?.getInstance();
    if (!instance || value === lastValueRef.current) {
      return;
    }

    instance.setMarkdown(value, false);
    lastValueRef.current = value;
  }, [value]);

  return (
    <div
      className={`relative pm-wysiwyg-shell border theme-border-subtle ${theme.variant === "dark" ? "pm-wysiwyg-shell-dark" : "pm-wysiwyg-shell-light"}`}
      data-theme-variant={theme.variant}
    >
      {readOnly ? <div className="absolute inset-0 z-10 cursor-not-allowed" aria-hidden="true" /> : null}
      <Editor
        ref={editorRef as never}
        initialValue={value}
        previewStyle="vertical"
        height={height}
        initialEditType="wysiwyg"
        useCommandShortcut
        hideModeSwitch
        onChange={() => {
          if (readOnly) {
            return;
          }
          const nextValue = editorRef.current?.getInstance().getMarkdown() ?? "";
          lastValueRef.current = nextValue;
          onChange(nextValue);
        }}
      />
    </div>
  );
}
